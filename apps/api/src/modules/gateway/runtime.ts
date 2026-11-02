import { exec, q, q1 } from '../../db/client.js';
import { open } from '../../shared/crypto.js';
import { BuiltinEngine, isPortFree, type RuntimeSpec, type Upstream } from './engine.js';

/**
 * 网关运行时 supervisor。
 *
 * 职责边界很清楚：
 *   · 编译（policy 模块）决定"应该跑什么"
 *   · supervisor 决定"实际在跑什么"，并把这个事实写回 gateway_instances.runtime_*
 *
 * 之前这两件事混在一起 —— 编译完就把 status 写成 APPLIED，界面上看起来
 * 一切正常，实际没有任何端口在监听。现在 runtime_state 只由这里写。
 */

const engines = new Map<string, BuiltinEngine>();

interface InstanceRow {
  id: string;
  name: string;
  engine_kind: string;
  bind_host: string;
  active_config_version: number | null;
  http_port: number;
}

interface SpecRow {
  policyKey: string;
  listenPort: number;
  strategy: string;
  members: Array<{ endpointId: string; host: string; port: number; protocol: Upstream['protocol'] }>;
}

async function loadCredentials(endpointIds: string[]): Promise<Map<string, { username: string; password: string }>> {
  const out = new Map<string, { username: string; password: string }>();
  if (endpointIds.length === 0) return out;

  const rows = await q<{ id: string; ciphertext: string; nonce: string; key_version: number }>(
    `SELECT e.id,
            encode(s.ciphertext,'base64') AS ciphertext,
            encode(s.nonce,'base64') AS nonce,
            s.key_version
     FROM proxy_endpoints e
     JOIN secrets s ON s.ref = e.credential_ref
     WHERE e.id = ANY($1::uuid[])`,
    [endpointIds],
  );

  for (const r of rows) {
    try {
      const plain = open({
        ciphertext: Buffer.from(r.ciphertext, 'base64'),
        nonce: Buffer.from(r.nonce, 'base64'),
        keyVersion: r.key_version,
      });
      const parsed = JSON.parse(plain) as { username?: string; password?: string };
      if (parsed.username) {
        out.set(r.id, { username: parsed.username, password: parsed.password ?? '' });
      }
    } catch {
      // 解不开就当作无凭据 —— 让这个成员在握手阶段失败并被降权，
      // 而不是让整次 apply 抛错导致网关起不来
    }
  }
  return out;
}

/**
 * 按实例当前生效的配置启动 / 更新引擎。
 *
 * 幂等：重复调用只会热更新成员集合，不会重建监听端口。
 */
export async function applyRuntime(instanceId: string): Promise<{
  ok: boolean;
  state: string;
  listeners: Array<{ policyKey: string; port: number; members: number }>;
  error: string | null;
}> {
  const instance = await q1<InstanceRow>(
    `SELECT id, name, engine_kind, bind_host, active_config_version, http_port
     FROM gateway_instances WHERE id = $1`,
    [instanceId],
  );
  if (!instance) return { ok: false, state: 'FAILED', listeners: [], error: '实例不存在' };

  const cfg = await q1<{ runtime_spec: { policies?: SpecRow[] } | null; version: number }>(
    `SELECT runtime_spec, version FROM gateway_configs
     WHERE instance_id = $1 AND status = 'APPLIED'
     ORDER BY version DESC LIMIT 1`,
    [instanceId],
  );

  const policies = cfg?.runtime_spec?.policies ?? [];
  if (policies.length === 0) {
    // 没有任何策略成员：不算失败，但也没什么可跑的
    await exec(
      `UPDATE gateway_instances
       SET runtime_state = 'STOPPED', listeners = '[]'::jsonb,
           runtime_reload_at = now(), runtime_error = NULL
       WHERE id = $1`,
      [instanceId],
    );
    return { ok: true, state: 'STOPPED', listeners: [], error: null };
  }

  // 端口预检：先看端口是不是被别的进程占了，把原因说清楚，
  // 而不是让 listen 抛一个 EADDRINUSE 然后界面只显示"启动失败"。
  //
  // 关键：本实例引擎**已经持有**的端口不算冲突。worker 每 15s 会重下发一次，
  // 不排除自己就会变成"第一次成功、之后永远 FAILED"，而端口其实一直在正常转发。
  const owned = new Set(
    (runtimeSnapshot(instanceId)?.policies ?? []).map((p) => p.listenPort),
  );
  const conflicts: string[] = [];
  for (const p of policies) {
    if (owned.has(p.listenPort)) continue;
    const free = await isPortFree(p.listenPort, instance.bind_host);
    if (!free) conflicts.push(`端口 ${p.listenPort}（策略 ${p.policyKey}）已被占用`);
  }
  if (conflicts.length > 0) {
    const message = conflicts.join('；');
    await exec(
      `UPDATE gateway_instances
       SET runtime_state = 'FAILED', runtime_error = $2, runtime_reload_at = now()
       WHERE id = $1`,
      [instanceId, message],
    );
    return { ok: false, state: 'FAILED', listeners: [], error: message };
  }

  const creds = await loadCredentials(policies.flatMap((p) => p.members.map((m) => m.endpointId)));

  const spec: RuntimeSpec = {
    instanceName: instance.name,
    policies: policies.map((p) => ({
      policyKey: p.policyKey,
      listenPort: p.listenPort,
      strategy: p.strategy,
      members: p.members.map((m) => ({
        endpointId: m.endpointId,
        host: m.host,
        port: m.port,
        protocol: m.protocol,
        username: creds.get(m.endpointId)?.username,
        password: creds.get(m.endpointId)?.password,
      })),
    })),
  };

  let engine = engines.get(instanceId);
  if (!engine) {
    engine = new BuiltinEngine();
    engines.set(instanceId, engine);
  }

  await exec(
    `UPDATE gateway_instances SET runtime_state = 'STARTING', runtime_reload_at = now() WHERE id = $1`,
    [instanceId],
  );

  try {
    await engine.apply(spec, instance.bind_host);
    const status = engine.status();
    const listeners = status.policies.map((p) => ({
      policyKey: p.policyKey,
      port: p.listenPort,
      members: p.members,
    }));

    await exec(
      `UPDATE gateway_instances
       SET runtime_state = 'RUNNING', runtime_error = NULL,
           runtime_pid = $2, runtime_started_at = COALESCE(runtime_started_at, now()),
           runtime_reload_at = now(), listeners = $3::jsonb, last_seen_at = now()
       WHERE id = $1`,
      [instanceId, process.pid, JSON.stringify(listeners)],
    );

    return { ok: true, state: 'RUNNING', listeners, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await exec(
      `UPDATE gateway_instances
       SET runtime_state = 'FAILED', runtime_error = $2, runtime_reload_at = now()
       WHERE id = $1`,
      [instanceId, message.slice(0, 500)],
    );
    return { ok: false, state: 'FAILED', listeners: [], error: message };
  }
}

export async function stopRuntime(instanceId: string): Promise<void> {
  const engine = engines.get(instanceId);
  if (engine) {
    await engine.stop();
    engines.delete(instanceId);
  }
  await exec(
    `UPDATE gateway_instances
     SET runtime_state = 'STOPPED', runtime_pid = NULL, listeners = '[]'::jsonb, runtime_error = NULL
     WHERE id = $1`,
    [instanceId],
  );
}

/** 运行时快照：引擎内存里的实时数据，比数据库里的落盘值新 */
export function runtimeSnapshot(instanceId: string): ReturnType<BuiltinEngine['status']> | null {
  return engines.get(instanceId)?.status() ?? null;
}

/**
 * 启动时对齐：把所有 builtin 引擎的实例拉起来。
 *
 * 只处理 engine_kind = 'builtin' —— gost 引擎需要外部二进制，
 * 由运维单独部署，这里不假装能管住它。
 */
export async function startAllRuntimes(): Promise<Array<{ name: string; state: string; detail: string }>> {
  const rows = await q<{ id: string; name: string }>(
    `SELECT id, name FROM gateway_instances WHERE engine_kind = 'builtin' ORDER BY created_at ASC`,
  );
  const out: Array<{ name: string; state: string; detail: string }> = [];
  for (const row of rows) {
    const res = await applyRuntime(row.id);
    out.push({
      name: row.name,
      state: res.state,
      detail: res.error ?? `${res.listeners.length} 个监听端口`,
    });
  }
  return out;
}

export async function stopAllRuntimes(): Promise<void> {
  for (const id of [...engines.keys()]) await stopRuntime(id);
}
