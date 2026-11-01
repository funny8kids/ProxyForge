/**
 * 端到端验收：把「能跑通」和「守住了约束」分开断言。
 * 用法：node scripts/verify.mjs
 *
 * 这份脚本是回归基线 —— 任何一条断言失败都说明系统主干被破坏了。
 */
import { createPublicKey, createHash, verify as nodeVerify } from 'node:crypto';

const BASE = process.env.PF_BASE ?? 'http://127.0.0.1:8081';
const results = [];
let token = '';

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

console.log(`\nProxyForge 验收 @ ${BASE}\n`);

// ── 1. 认证 ──
console.log('1. 认证与授权');
const login = await api('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'admin', password: 'proxyforge' }),
});
check('登录返回 JWT', login.status === 200 && typeof login.body.accessToken === 'string');
token = login.body.accessToken ?? '';

const badLogin = await api('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'admin', password: 'wrong' }),
});
check('错误口令返回 401', badLogin.status === 401, `status=${badLogin.status}`);

const noAuth = await fetch(`${BASE}/api/v1/resources`);
check('无凭据访问被拒 401', noAuth.status === 401, `status=${noAuth.status}`);

const viewerLogin = await api('/api/v1/auth/login', {
  method: 'POST',
  body: JSON.stringify({ username: 'viewer', password: 'proxyforge' }),
});
const viewerToken = viewerLogin.body.accessToken;
const viewerWrite = await fetch(`${BASE}/api/v1/pools`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'should-fail' }),
});
check('VIEWER 写操作被拒 403', viewerWrite.status === 403, `status=${viewerWrite.status}`);

// ── 2. 数据面 ──
console.log('\n2. 资源与分级');
const overview = await api('/api/v1/analytics/overview');
check('概览返回真实计数', overview.body.counters?.totalEndpoints > 0,
  `total=${overview.body.counters?.totalEndpoints}`);

const list = await api('/api/v1/resources?limit=5');
check('资源列表游标分页', Array.isArray(list.body.items) && list.body.items.length === 5);

const trust = await api('/api/v1/trust/summary');
const pubTier = trust.body.tiers?.find((t) => t.tier === 'PUBLIC_PROXY');
check('PUBLIC_PROXY 不可进网关', pubTier && pubTier.gatewayEligible === false);

// ── 3. 信任门槛：三条硬约束 ──
console.log('\n3. 信任门槛（关键约束）');
const pubEndpoint = (await api('/api/v1/resources?tier=PUBLIC_PROXY&limit=1')).body.items?.[0];

if (pubEndpoint) {
  const grant = await api(`/api/v1/resources/${pubEndpoint.id}/gateway-grant`, {
    method: 'POST',
    body: JSON.stringify({ grant: true }),
  });
  check('公开代理授予网关权限被拒', grant.status === 422,
    `code=${grant.body.code ?? grant.status}`);

  const promote = await api(`/api/v1/resources/${pubEndpoint.id}/tier`, {
    method: 'PATCH',
    body: JSON.stringify({ tier: 'VERIFIED_PROXY' }),
  });
  check('公开代理直接提级被拒', promote.status === 403,
    `code=${promote.body.code ?? promote.status}`);
} else {
  check('存在公开代理样本', false, '未找到 PUBLIC_PROXY 端点');
}

// ── 4. 策略编译 ──
console.log('\n4. 策略编译与网关下发');
const reload = await api('/api/v1/gateway/reload', { method: 'POST' });
check('网关重新编译成功', reload.status === 200, `version=${reload.body.version}`);

const insts = reload.body.instances ?? [];
check('编译覆盖全部实例', insts.length >= 2, `count=${insts.length}`);

const primaryInst = insts.find((i) => i.name.includes('primary')) ?? insts[0];
const labInst = insts.find((i) => i.name.includes('lab'));

check('正式实例编译出成员', primaryInst.memberCount > 0, `members=${primaryInst.memberCount}`);

const primaryCfgs = (await api(`/api/v1/gateway/configs?instanceId=${primaryInst.instanceId}`)).body.items ?? [];
const primaryCfg = primaryCfgs.find((c) => c.version === primaryInst.version) ?? primaryCfgs[0];
const pr = primaryCfg?.renderedConfig ?? '';

check('正式配置含 services 段', pr.includes('services:'));
check('正式配置含 chains 段', pr.includes('chains:'));
check('正式配置不含实验隔离段', !pr.includes('EXPERIMENTAL ISOLATION'));
check('正式配置未泄露凭据', !/password:\s*\S/.test(pr));

if (labInst) {
  const labCfgs = (await api(`/api/v1/gateway/configs?instanceId=${labInst.instanceId}`)).body.items ?? [];
  const labCfg = labCfgs.find((c) => c.version === labInst.version) ?? labCfgs[0];
  const lr = labCfg?.renderedConfig ?? '';
  check('实验实例声明隔离段', lr.includes('EXPERIMENTAL ISOLATION'));
  check('实验实例正式段为空（公开代理不进正式网关）', /services:\s*\n\s*\[\]/.test(lr));
} else {
  check('存在实验网关实例', false);
}

const policies = await api('/api/v1/policies');
check('策略列表可读', Array.isArray(policies.body.items) && policies.body.items.length > 0,
  `count=${policies.body.items?.length}`);

// ── 5. 订阅与 Ed25519 签名 ──
console.log('\n5. 订阅渲染与签名验签');
const subToken = process.env.PF_SUB_TOKEN ?? 'pf_sub_demo0000000000000000000000';
const subRes = await fetch(`${BASE}/api/v1/subscriptions/${subToken}`, {
  headers: { Accept: 'text/yaml' },
});
const yaml = await subRes.text();
check('订阅渲染返回 200', subRes.status === 200, `status=${subRes.status}`);
check('返回 YAML 内容', yaml.includes('proxies:'));

const sig = subRes.headers.get('x-pf-signature');
const keyId = subRes.headers.get('x-pf-key-id');
const revision = subRes.headers.get('x-pf-revision');
const canonicalHash = subRes.headers.get('x-pf-canonical-hash');
check('响应带签名头', Boolean(sig && keyId && revision), `keyId=${keyId} rev=${revision}`);

// 取公钥并独立验签（客户端视角，不复用服务端代码）
const jwks = await (await fetch(`${BASE}/api/v1/.well-known/proxyforge-signing-keys.json`)).json();
const activeKey = jwks.keys?.find((k) => k.key_id === keyId) ?? jwks.keys?.[0];

if (activeKey && sig) {
  // 信封与哈希头必须取自**同一次**响应。
  // 订阅内容随健康检查实时变化：先取 YAML 再取 JSON，中间只要有一次健康检查
  // 落地，两次响应的载荷就不是同一份，比对必然失败 —— 这是测试的顺序依赖，
  // 不是签名不一致。
  const envRes = await fetch(`${BASE}/api/v1/subscriptions/${subToken}?format=json`);
  const envelope = await envRes.json();
  const envelopeHash = envRes.headers.get('x-pf-canonical-hash');

  // 独立实现 JCS（与协议一致的最小实现），用于交叉验证服务端实现
  const canonical = jcs(envelope.payload);
  const raw = Buffer.from(activeKey.public_key, 'base64url');
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  const pubKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = nodeVerify(null, Buffer.from(canonical, 'utf8'), pubKey, Buffer.from(sig, 'base64url'));

  check('Ed25519 签名可被客户端独立验签', ok);

  const localHash = `sha256:${createHash('sha256').update(canonical).digest('base64url')}`;
  check('canonicalHash 与本地重算一致',
    localHash === envelope.canonicalHash && localHash === envelopeHash,
    `local=${localHash.slice(7, 22)}…`);

  check('revision 单调且非零', Number(revision) > 0, `rev=${revision}`);
} else {
  check('公钥可获取', false);
}

// 撤销后必须 404（防枚举：不存在/撤销/过期三者统一）
const created = await api('/api/v1/subscriptions', {
  method: 'POST',
  body: JSON.stringify({ name: 'verify-temp', poolId: (await api('/api/v1/pools')).body.items[0].id }),
});
const tempToken = created.body.token;
const beforeRevoke = await fetch(`${BASE}/api/v1/subscriptions/${tempToken}`);
await api(`/api/v1/subscriptions/${created.body.id}`, { method: 'DELETE' });
const afterRevoke = await fetch(`${BASE}/api/v1/subscriptions/${tempToken}`);
check('新订阅可访问', beforeRevoke.status === 200);
check('撤销后返回 404', afterRevoke.status === 404, `status=${afterRevoke.status}`);

// ── 6. 导入闭环 ──
console.log('\n6. 导入与幂等');
// 每轮用不同的保留地址**和端口**，保证验收可重复执行（不受上一轮残留影响）。
// 只随机 /24 里的主机号不够：去重键是 (host, port, protocol)，
// 250 个取值在两三次连跑后就会撞上，表现为「首次导入新增 0 条」这种假失败。
const tag = Math.floor(Math.random() * 250) + 1;
const portA = 20000 + Math.floor(Math.random() * 40000);
const portB = 20000 + Math.floor(Math.random() * 40000);
const hostA = `198.51.100.${tag}`;
const hostB = `198.51.101.${tag}`;
const importBody = {
  mode: 'TEXT',
  content: [`${hostA}:${portA}`, `socks5://${hostB}:${portB}`, `${hostA}:${portA}`, 'not-a-proxy'].join('\n'),
};
const imp1 = await api('/api/v1/resources/import', { method: 'POST', body: JSON.stringify(importBody) });
check('首次导入新增 2 条', imp1.body.imported === 2, `imported=${imp1.body.imported}`);
check('同批次去重生效', imp1.body.duplicated === 1, `dup=${imp1.body.duplicated}`);
check('非法行被跳过并记录', imp1.body.skipped === 1 && imp1.body.errors.length === 1);

const imp2 = await api('/api/v1/resources/import', { method: 'POST', body: JSON.stringify(importBody) });
// 第二次导入：3 行合法（其中 1 行是批内重复）全部命中已存在记录
check('重复导入全部去重', imp2.body.imported === 0 && imp2.body.duplicated === 3,
  `imported=${imp2.body.imported} dup=${imp2.body.duplicated}`);

// ── 7. 错误模型 ──
console.log('\n7. 错误模型');
const nf = await api('/api/v1/resources/00000000-0000-0000-0000-000000000000');
check('不存在返回 RFC 9457', nf.status === 404 && nf.body.code === 'NOT_FOUND');
check('错误响应不含 SQL', !JSON.stringify(nf.body).toLowerCase().includes('select '));
check('错误响应带 requestId', typeof nf.body.requestId === 'string');

const badEnum = await api('/api/v1/resources?status=BOGUS');
check('非法枚举返回 400', badEnum.status === 400 && badEnum.body.code === 'INVALID_ARGUMENT');

// ── 8. 系统状态 ──
console.log('\n8. 系统状态');
const status = await api('/api/v1/system/status');
check('DB 健康', status.body.db?.ok === true, `${status.body.db?.latencyMs}ms`);
check('探针模式可见', typeof status.body.probeMode === 'string', `mode=${status.body.probeMode}`);
check('Outbox 计数可读', typeof status.body.outbox?.pending === 'number');

// ── 汇总 ──
const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(56)}`);
console.log(`总计 ${results.length} 项：通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length > 0) {
  console.log('\n失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
  process.exit(1);
}
console.log('全部通过 ✓\n');

// 独立 JCS 实现（RFC 8785 最小子集），用于交叉验证服务端实现
function jcs(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return JSON.stringify(Object.is(v, -0) ? 0 : v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
}
