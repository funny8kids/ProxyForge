import type { FastifyInstance } from 'fastify';
import type {
  ProxyProtocol,
  SubscriptionCreated,
  SubscriptionNodeFilter,
  SubscriptionRoutingMode,
  SubscriptionRow,
  TrustTier,
} from '@proxyforge/contracts';
import { exec, q, q1, tx } from '../../db/client.js';
import { actorOf, guard } from '../auth/index.js';
import { audit, emit, EVENT_TYPES } from '../../shared/events.js';
import { notFound, invalid, AppError } from '../../shared/errors.js';
import { opaqueToken, uuidv7 } from '../../shared/id.js';
import { sha256Hex, ed25519Sign, generateSigningKeyPair, seal, open, sha256Base64Url } from '../../shared/crypto.js';
import { canonicalize } from '../../shared/jcs.js';
import {
  EXPORT_FORMATS,
  normalizeFormat,
  normalizeRoutingMode,
  renderSubscription,
  type ExportFormat,
  type ExportProxy,
  type RoutingMode,
} from './render.js';
import { applyNameTemplate, applyNodeFilter, normalizeNodeFilter } from './filter.js';

/**
 * 订阅渲染与签名（ADR-0008 / ADR-0009 / SEC-001 §6.4）
 *
 * 三个必须遵守的点：
 *   1. 签名对象是 **JCS 规范化 JSON**，不是 YAML 字节流。
 *      YAML 序列化不唯一，签字节流必然在客户端上验签失败。
 *   2. revision 单调递增 + expiresAt + 可撤销，三者共同构成防重放。
 *   3. Token 只在创建时返回一次明文；库里只存 sha256。
 */

interface SubscriptionLookup {
  id: string;
  name: string;
  pool_id: string;
  pool_key: string;
  format: string;
  signing_enabled: boolean;
  revision: string;
  expires_at: string | null;
  revoked_at: string | null;
  node_filter: SubscriptionNodeFilter | null;
  name_template: string | null;
  routing_mode: string;
  extra_rules: string[] | null;
}

interface EligibleEndpoint {
  id: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  trust_tier: TrustTier;
  quality_score: string;
  p50_ms: number | null;
  credential_ref: string | null;
  country_code: string | null;
}

/** 一行规则的长度上限。用户手写，但一份订阅不该被塞进一兆字节的规则。 */
const MAX_RULE_LEN = 200;
const MAX_RULES = 60;
const MAX_TEMPLATE_LEN = 80;

/**
 * 校验并归一化规则行。
 *
 * 这里只做"能不能被解析"的检查，不校验规则类型白名单 —— 类型集合随内核
 * 版本增长，写死会让新语法进不来。真正危险的输入是**超长行**和**海量行**：
 * 它们会让渲染出来的配置体积失控，客户端加载变慢但不会报错，很难归因。
 */
function normalizeRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const line = String(item ?? '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.length > MAX_RULE_LEN) throw invalid(`规则过长（上限 ${MAX_RULE_LEN} 字符）：${line.slice(0, 40)}…`);
    out.push(line);
    if (out.length > MAX_RULES) throw invalid(`规则条数过多（上限 ${MAX_RULES} 条）`);
  }
  return out;
}

function normalizeTemplate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim();
  if (!t) return null;
  if (t.length > MAX_TEMPLATE_LEN) throw invalid(`命名模板过长（上限 ${MAX_TEMPLATE_LEN} 字符）`);
  return t;
}


export async function registerSubscriptionRoutes(app: FastifyInstance): Promise<void> {
  // ── 管理接口 ──
  app.get('/subscriptions', { preHandler: guard('subscription:read') }, async (): Promise<{ items: SubscriptionRow[] }> => {
    const rows = await q<Record<string, unknown>>(
      `SELECT s.*, p.key AS pool_key FROM subscriptions s JOIN resource_pools p ON p.id = s.pool_id
       ORDER BY s.created_at DESC`,
    );
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        poolId: r.pool_id as string,
        poolKey: r.pool_key as string,
        format: r.format as SubscriptionRow['format'],
        tokenPrefix: r.token_prefix as string,
        signingEnabled: Boolean(r.signing_enabled),
        revision: Number(r.revision),
        expiresAt: (r.expires_at as string) ?? null,
        revokedAt: (r.revoked_at as string) ?? null,
        lastAccessedAt: (r.last_accessed_at as string) ?? null,
        accessCount: Number(r.access_count),
        createdAt: String(r.created_at),
        nodeFilter: normalizeNodeFilter(r.node_filter),
        nameTemplate: (r.name_template as string) ?? null,
        routingMode: normalizeRoutingMode(r.routing_mode),
        extraRules: Array.isArray(r.extra_rules) ? (r.extra_rules as string[]) : [],
      })),
    };
  });

  app.post('/subscriptions', { preHandler: guard('subscription:write') }, async (req): Promise<SubscriptionCreated> => {
    const body = req.body as {
      name: string; poolId: string; format?: string; signingEnabled?: boolean; expiresAt?: string;
      nodeFilter?: unknown; nameTemplate?: unknown; routingMode?: unknown; extraRules?: unknown;
    };
    if (!body?.name) throw invalid('name 必填');
    if (!body?.poolId) throw invalid('poolId 必填');

    // 格式白名单要在落库前校验。否则传一个 DB CHECK 不认识的值，
    // 用户拿到的是 500 + 约束名，而不是「这个格式不支持」。
    const requestedFormat = body.format ? normalizeFormat(body.format, 'mihomo') : 'mihomo';
    if (body.format && !(EXPORT_FORMATS as string[]).includes(body.format)) {
      throw invalid(`format 不支持：${body.format}（可选 ${EXPORT_FORMATS.join(' / ')}）`);
    }

    const nodeFilter = normalizeNodeFilter(body.nodeFilter);
    const nameTemplate = normalizeTemplate(body.nameTemplate);
    const routingMode = normalizeRoutingMode(body.routingMode);
    const extraRules = normalizeRules(body.extraRules);

    const actor = actorOf(req);
    const pool = await q1<{ key: string }>('SELECT key FROM resource_pools WHERE id = $1', [body.poolId]);
    if (!pool) throw notFound('资源池');

    // 签名开启时必须存在 ACTIVE 密钥，否则宁可失败也不返回未签名内容
    if (body.signingEnabled) {
      const key = await q1('SELECT 1 FROM signing_keys WHERE status = \'ACTIVE\'');
      if (!key) {
        throw new AppError('SIGNING_KEY_UNAVAILABLE', '已启用签名但无 ACTIVE 密钥，请先激活签名密钥');
      }
    }

    const token = opaqueToken('pf_sub');
    const id = uuidv7();

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO subscriptions
           (id, name, pool_id, format, token_hash, token_prefix, signing_enabled, expires_at, created_by,
            node_filter, name_template, routing_mode, extra_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb)`,
        [
          id, body.name, body.poolId, requestedFormat,
          sha256Hex(token), token.slice(0, 12), body.signingEnabled ?? false,
          body.expiresAt ?? null, actor.id,
          JSON.stringify(nodeFilter), nameTemplate, routingMode, JSON.stringify(extraRules),
        ],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'subscription.create',
        resourceType: 'subscription', resourceId: id,
        afterState: {
          name: body.name, poolId: body.poolId, signingEnabled: body.signingEnabled ?? false,
          routingMode, nodeFilter, extraRules,
        },
      });
    });

    return {
      id,
      name: body.name,
      poolId: body.poolId,
      poolKey: pool.key,
      format: requestedFormat as SubscriptionRow['format'],
      tokenPrefix: token.slice(0, 12),
      signingEnabled: body.signingEnabled ?? false,
      revision: 0,
      expiresAt: body.expiresAt ?? null,
      revokedAt: null,
      lastAccessedAt: null,
      accessCount: 0,
      createdAt: new Date().toISOString(),
      nodeFilter,
      nameTemplate,
      routingMode,
      extraRules,
      token,
      url: `/api/v1/subscriptions/${token}`,
      warning: 'Token 仅显示一次，请立即保存',
    };
  });

  /**
   * 修改订阅设置。
   *
   * 之前建完订阅就再也不能改 —— 想换分流模式或调节点上限只能删了重建，
   * 而重建会丢掉 token（客户端要重新导入）和版本历史。
   * 这里只允许改**渲染相关**字段，pool / token / revision 都不动。
   */
  app.patch('/subscriptions/:id', { preHandler: guard('subscription:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      name?: string; format?: string; nameTemplate?: unknown; routingMode?: unknown;
      extraRules?: unknown; nodeFilter?: unknown; signingEnabled?: boolean;
    };
    const actor = actorOf(req);

    const existing = await q1<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM subscriptions WHERE id = $1',
      [id],
    );
    if (!existing) throw notFound('订阅');
    if (existing.revoked_at) throw invalid('订阅已撤销，无法修改');

    const sets: string[] = [];
    const params: unknown[] = [id];
    const before: Record<string, unknown> = {};

    const push = (column: string, value: unknown, cast = ''): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw invalid('name 不能为空');
      push('name', name);
      before['name'] = name;
    }
    if (body.format !== undefined) {
      if (!(EXPORT_FORMATS as string[]).includes(body.format)) {
        throw invalid(`format 不支持：${body.format}（可选 ${EXPORT_FORMATS.join(' / ')}）`);
      }
      push('format', body.format);
      before['format'] = body.format;
    }
    if (body.routingMode !== undefined) {
      const mode = normalizeRoutingMode(body.routingMode);
      push('routing_mode', mode);
      before['routingMode'] = mode;
    }
    if (body.extraRules !== undefined) {
      const rules = normalizeRules(body.extraRules);
      push('extra_rules', JSON.stringify(rules), '::jsonb');
      before['extraRules'] = rules;
    }
    if (body.nameTemplate !== undefined) {
      const tpl = normalizeTemplate(body.nameTemplate);
      push('name_template', tpl);
      before['nameTemplate'] = tpl;
    }
    if (body.nodeFilter !== undefined) {
      const filter = normalizeNodeFilter(body.nodeFilter);
      push('node_filter', JSON.stringify(filter), '::jsonb');
      before['nodeFilter'] = filter;
    }
    if (body.signingEnabled !== undefined) {
      if (body.signingEnabled) {
        const key = await q1(`SELECT 1 FROM signing_keys WHERE status = 'ACTIVE'`);
        if (!key) throw new AppError('SIGNING_KEY_UNAVAILABLE', '已启用签名但无 ACTIVE 密钥，请先激活签名密钥');
      }
      push('signing_enabled', Boolean(body.signingEnabled));
      before['signingEnabled'] = Boolean(body.signingEnabled);
    }

    if (sets.length === 0) return { ok: true, changed: false };

    await tx(async (t) => {
      await t.exec(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = $1`, params);
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'subscription.update',
        resourceType: 'subscription', resourceId: id, afterState: before,
      });
    });
    return { ok: true, changed: true, applied: before };
  });

  /**
   * 预览过滤结果。
   *
   * 存在的理由：过滤条件是"盲配"的 —— 用户设 minQuality=80 时无从知道
   * 到底还剩几个节点，只有保存后拉一次订阅才能看见。结果是要么筛空了
   * 才发现，要么反复试参数。这个接口让表单能实时回显"匹配 N 个节点"。
   *
   * 顺带把渲染结果也带回来（includeBody），省掉"保存 → 拉取 → 不满意 → 改"
   * 这一圈往返。
   */
  app.post('/subscriptions/preview', { preHandler: guard('subscription:read') }, async (req) => {
    const body = (req.body ?? {}) as {
      poolId?: string; nodeFilter?: unknown; nameTemplate?: unknown; routingMode?: unknown;
      extraRules?: unknown; format?: string; includeBody?: boolean;
    };
    if (!body.poolId) throw invalid('poolId 必填');
    const pool = await q1<{ key: string }>('SELECT key FROM resource_pools WHERE id = $1', [body.poolId]);
    if (!pool) throw notFound('资源池');

    const nodeFilter = normalizeNodeFilter(body.nodeFilter);
    const nameTemplate = normalizeTemplate(body.nameTemplate);
    const routingMode = normalizeRoutingMode(body.routingMode);
    const extraRules = normalizeRules(body.extraRules);

    const proxies = await loadExportProxies(body.poolId, pool.key, {
      node_filter: nodeFilter,
      name_template: nameTemplate,
    });

    const byProtocol: Record<string, number> = {};
    for (const p of proxies) byProtocol[p.protocol] = (byProtocol[p.protocol] ?? 0) + 1;

    const format = normalizeFormat(body.format, 'mihomo');
    const rendered = body.includeBody
      ? renderSubscription(format, pool.key, proxies, undefined, { routingMode, extraRules })
      : null;

    return {
      poolKey: pool.key,
      matched: proxies.length,
      byProtocol,
      // 只回样本：整份名单没有额外信息量，还会让响应体随池子规模膨胀
      sampleNames: proxies.slice(0, 10).map((p) => p.name),
      format,
      routingMode,
      ...(rendered
        ? { contentType: rendered.contentType, body: rendered.body.slice(0, 16_000) }
        : {}),
    };
  });

  app.delete('/subscriptions/:id', { preHandler: guard('subscription:write') }, async (req) => {
    const { id } = req.params as { id: string };
    const actor = actorOf(req);
    await tx(async (t) => {
      const n = await t.exec(
        'UPDATE subscriptions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [id],
      );
      if (n === 0) throw notFound('订阅');
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'subscription.revoke',
        resourceType: 'subscription', resourceId: id,
      });
      await emit(t, {
        type: EVENT_TYPES.SUBSCRIPTION_REVOKED,
        aggregateType: 'subscription', aggregateId: id, payload: {},
      });
    });
    return { ok: true };
  });

  /**
   * 重签发订阅 Token。
   *
   * 明文 Token 只在创建时返回一次，库里只有 sha256。用户把 URL 弄丢之后
   * 原来没有任何补救手段 —— 只能删掉重建，而重建会丢掉访问计数和历史版本。
   * 这里换掉 token_hash，旧 URL 立即失效（等价于一次凭据轮换），
   * 订阅本身、revision、版本历史都保留。
   */
  app.post(
    '/subscriptions/:id/rotate-token',
    { preHandler: guard('subscription:write') },
    async (req) => {
      const { id } = req.params as { id: string };
      const actor = actorOf(req);

      const token = opaqueToken('pf_sub');
      await tx(async (t) => {
        const n = await t.exec(
          `UPDATE subscriptions SET token_hash = $2, token_prefix = $3
           WHERE id = $1 AND revoked_at IS NULL`,
          [id, sha256Hex(token), token.slice(0, 12)],
        );
        if (n === 0) throw notFound('订阅');
        await audit(t, {
          actorType: actor.kind, actorId: actor.id, action: 'subscription.rotate_token',
          resourceType: 'subscription', resourceId: id,
          // 不记录新旧 token 本身，只记录轮换动作与新的前缀。
          afterState: { tokenPrefix: token.slice(0, 12) },
        });
      });

      return {
        id,
        token,
        tokenPrefix: token.slice(0, 12),
        url: `/api/v1/subscriptions/${token}`,
        warning: 'Token 仅显示一次，旧 URL 已立即失效',
      };
    },
  );

  app.get('/subscriptions/:id/versions', { preHandler: guard('subscription:read') }, async (req) => {    const { id } = req.params as { id: string };
    const rows = await q<Record<string, unknown>>(
      `SELECT version, revision, pool_version, content_hash, canonical_hash, signature, key_id,
              signature_version, issued_at, expires_at
       FROM subscription_versions WHERE subscription_id = $1 ORDER BY version DESC LIMIT 50`,
      [id],
    );
    return { items: rows };
  });

  /**
   * 管理端导出。
   *
   * 为什么需要它：明文 token 只在创建时出现一次，库里只有 sha256。
   * 也就是说「订阅页上的一个订阅」在刷新页面之后就再也拼不出下载地址了 ——
   * 想导出只能重建订阅，那会把访问计数和版本历史一起丢掉。
   * 这条路由用 JWT 鉴权，直接按订阅 id 导出，不依赖 token。
   *
   * 注意它**不做签名**：签名是对「发布内容」的承诺，只挂在 token 拉取路径上。
   * 这里导出的是同一份节点集合，只是给人在界面上直接拿走。
   */
  app.get('/subscriptions/:id/export', { preHandler: guard('subscription:read') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { format?: string; download?: string };

    const sub = await q1<{
      id: string; name: string; pool_id: string; pool_key: string; format: string; revoked_at: string | null;
      node_filter: SubscriptionNodeFilter | null; name_template: string | null;
      routing_mode: string; extra_rules: string[] | null;
    }>(
      `SELECT s.id, s.name, s.pool_id, p.key AS pool_key, s.format, s.revoked_at,
              s.node_filter, s.name_template, s.routing_mode, s.extra_rules
       FROM subscriptions s JOIN resource_pools p ON p.id = s.pool_id WHERE s.id = $1`,
      [id],
    );
    if (!sub) throw notFound('订阅');
    if (sub.revoked_at) throw invalid('订阅已撤销，无法导出');

    const proxies = await loadExportProxies(sub.pool_id, sub.pool_key, sub);
    const format = normalizeFormat(query.format, normalizeFormat(sub.format));
    const rendered = renderSubscription(format, sub.pool_key, proxies, undefined, {
      routingMode: normalizeRoutingMode(sub.routing_mode),
      extraRules: Array.isArray(sub.extra_rules) ? sub.extra_rules : [],
    });

    reply.header('Content-Type', rendered.contentType);
    reply.header('Cache-Control', 'no-store');
    reply.header('X-PF-Format', rendered.format);
    reply.header('X-PF-Nodes', String(proxies.length));

    // 导出接口默认就是下载：用户点「导出」的意图是拿到文件
    if (query.download !== '0') {
      reply.header('Content-Disposition', contentDisposition(sub.name, sub.pool_key, rendered.format, rendered.extension));
    }
    return reply.send(rendered.body);
  });

  // ── 渲染端点（订阅 Token 认证，非 JWT） ──
  app.get('/subscriptions/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const hash = sha256Hex(token);

    const sub = await q1<SubscriptionLookup>(
      `SELECT s.id, s.name, s.pool_id, p.key AS pool_key, s.format, s.signing_enabled,
              s.revision, s.expires_at, s.revoked_at,
              s.node_filter, s.name_template, s.routing_mode, s.extra_rules
       FROM subscriptions s JOIN resource_pools p ON p.id = s.pool_id
       WHERE s.token_hash = $1`,
      [hash],
    );

    // 不存在 / 已撤销 / 已过期 —— 三者统一 404，防枚举
    if (!sub || sub.revoked_at !== null) throw notFound('订阅');
    if (sub.expires_at && new Date(sub.expires_at) < new Date()) throw notFound('订阅');

    // 池的分级准入必须在这里再过一遍：订阅不能成为绕过 SEC-001 的通道
    const proxies = await loadExportProxies(sub.pool_id, sub.pool_key, sub);

    const routingMode = normalizeRoutingMode(sub.routing_mode);
    const extraRules = Array.isArray(sub.extra_rules) ? sub.extra_rules : [];

    // 内容指纹只覆盖**稳定字段**。
    // 把 issuedAt 算进指纹是个陷阱：它每次请求都变，会导致 revision 无限膨胀，
    // 且同一份内容每次拿到不同签名 —— 客户端缓存与验签都会失效。
    //
    // 分流设置必须算进来：它不改变节点集合，但改变了「发布内容」。
    // 不算的话，用户改了分流模式，客户端拿到的仍是旧 revision，
    // 部分客户端会认为"内容没变"而不重新拉取配置。
    const stable = {
      subscriptionId: sub.id,
      poolKey: sub.pool_key,
      format: sub.format,
      proxies,
      routingMode,
      extraRules,
    };
    const contentHash = sha256Hex(canonicalize(stable));

    const lastVersion = await q1<{
      version: number; revision: string; content_hash: string; signature: string | null;
      key_id: string | null; signature_version: number | null; content: string;
    }>(
      `SELECT version, revision, content_hash, signature, key_id, signature_version, content
       FROM subscription_versions WHERE subscription_id = $1 ORDER BY version DESC LIMIT 1`,
      [sub.id],
    );

    const defaultExpiry =
      sub.expires_at ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();

    let revision = Number(sub.revision);
    let payload: Record<string, unknown>;
    let signature: string | null = null;
    let keyId: string | null = null;
    let signatureVersion: number | null = null;

    if (lastVersion && lastVersion.content_hash === contentHash) {
      // 内容未变：**直接复用落库的那份 JSON**。
      // 不要用 issued_at / expires_at 列去重建载荷 —— 时间戳列往返一次
      // 就可能与当初签名的字符串产生细微差异，导致验签失败。
      // 落库的 content 就是被签名的那份字节，它是唯一真相。
      payload = JSON.parse(lastVersion.content) as Record<string, unknown>;
      revision = Number(lastVersion.revision);
      signature = lastVersion.signature;
      keyId = lastVersion.key_id;
      signatureVersion = lastVersion.signature_version;
    } else {
      revision += 1;
      const issuedAt = new Date().toISOString();
      const expiresAt = defaultExpiry;
      const signedPayload = { ...stable, issuedAt, expiresAt };

      // 先序列化，再对「序列化后解析回来的对象」做规范化与签名。
      // 这样签名对象与落库字节严格同源，不存在"签的是一份、存的是另一份"。
      const contentStr = JSON.stringify(signedPayload);
      const canonicalForSign = canonicalize(JSON.parse(contentStr));

      if (sub.signing_enabled) {
        const activeKey = await q1<{ key_id: string; public_key: string; private_key_ref: string; signature_version: number }>(
          `SELECT key_id, public_key, private_key_ref, signature_version
           FROM signing_keys WHERE status = 'ACTIVE' LIMIT 1`,
        );
        if (!activeKey) {
          throw new AppError('SIGNING_KEY_UNAVAILABLE', '签名已启用但无可用 ACTIVE 密钥');
        }
        const secret = await q1<{ ciphertext: string; nonce: string; key_version: number }>(
          'SELECT encode(ciphertext,\'base64\') AS ciphertext, encode(nonce,\'base64\') AS nonce, key_version FROM secrets WHERE ref = $1',
          [activeKey.private_key_ref],
        );
        if (!secret) throw new AppError('SIGNING_KEY_UNAVAILABLE', '私钥缺失');

        const pkcs8 = open({
          ciphertext: Buffer.from(secret.ciphertext, 'base64'),
          nonce: Buffer.from(secret.nonce, 'base64'),
          keyVersion: secret.key_version,
        });
        // 签名对象 = JCS 规范化 JSON，不是 YAML 字节流
        signature = ed25519Sign(canonicalForSign, pkcs8);
        keyId = activeKey.key_id;
        signatureVersion = activeKey.signature_version;
      }

      const canonicalHashValue = `sha256:${sha256Base64Url(canonicalForSign)}`;

      await tx(async (t) => {
        await t.exec(
          `INSERT INTO subscription_versions
             (id, subscription_id, version, revision, pool_version, content_hash, content,
              canonical_hash, signature, key_id, signature_version, issued_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            uuidv7(), sub.id,
            (lastVersion?.version ?? 0) + 1,
            revision,
            1,
            contentHash,
            contentStr,
            signature ? canonicalHashValue : null,
            signature,
            keyId,
            signatureVersion,
            issuedAt,
            expiresAt,
          ],
        );
        await t.exec('UPDATE subscriptions SET revision = $2 WHERE id = $1', [sub.id, revision]);
      });

      payload = signedPayload as unknown as Record<string, unknown>;
    }

    // 响应用载荷与签名对象同源：复用分支直接来自 content，新建分支即 signedPayload
    const canonicalHash = `sha256:${sha256Base64Url(canonicalize(payload))}`;
    const issuedAt = String(payload.issuedAt);
    const expiresAt = String(payload.expiresAt);

    // 访问计数与时间（不记录 token 明文）
    void exec(
      'UPDATE subscriptions SET last_accessed_at = now(), access_count = access_count + 1 WHERE id = $1',
      [sub.id],
    ).catch(() => {});

    /**
     * 格式选择：
     *   · `?format=` 覆盖订阅自带的 format —— 同一份订阅可以同时导给
     *     Clash（YAML）和 v2rayN（base64），不必为每种客户端建一份订阅
     *   · `format=json` 是**既有的离线验签信封**，必须优先拦截，
     *     否则会被当成节点格式名，静默回落到 YAML
     *   · 都不传时用订阅建库时选的格式
     */
    const q = req.query as { format?: string; download?: string };
    const envelope = q.format === 'json';
    const format = envelope ? null : normalizeFormat(q.format, normalizeFormat(sub.format));
    const rendered = format
      ? renderSubscription(format, sub.pool_key, proxies, undefined, { routingMode, extraRules })
      : null;

    reply.header('Content-Type', rendered?.contentType ?? 'text/yaml; charset=utf-8');
    reply.header('Cache-Control', 'private, max-age=300');
    reply.header('ETag', `"pool-${sub.pool_key}-v${revision}"`);
    reply.header('X-PF-Revision', String(revision));
    reply.header('X-PF-Issued-At', issuedAt);
    reply.header('X-PF-Expires-At', expiresAt);

    if (rendered) {
      reply.header('X-PF-Format', rendered.format);
      // 客户端按 URL 拉取时不该触发下载，只有显式 download=1 才加附件头
      if (q.download === '1' || q.download === 'true') {
        const base = sub.pool_key.replace(/[^A-Za-z0-9._-]/g, '-');
        reply.header(
          'Content-Disposition',
          `attachment; filename="${base}-${rendered.format}.${rendered.extension}"`,
        );
      }
    }

    if (signature) {
      reply.header('X-PF-Signature-Alg', 'Ed25519');
      reply.header('X-PF-Key-Id', keyId ?? '');
      reply.header('X-PF-Signature-Version', String(signatureVersion ?? 1));
      reply.header('X-PF-Canonical-Hash', canonicalHash);
      reply.header('X-PF-Signature', signature);
    }

    // 离线验签信封
    if (envelope) {
      reply.header('Content-Type', 'application/json; charset=utf-8');
      return reply.send({ payload, canonicalHash, signature, keyId, signatureVersion });
    }

    return reply.send(rendered!.body);
  });

  // ── 签名密钥管理（ADMIN） ──
  app.get('/signing-keys', { preHandler: guard('signing:manage') }, async () => {
    const rows = await q<Record<string, unknown>>(
      `SELECT key_id, algorithm, public_key, status, signature_version, not_before, not_after, activated_at
       FROM signing_keys ORDER BY created_at DESC`,
    );
    return { items: rows };
  });

  app.post('/signing-keys', { preHandler: guard('signing:manage') }, async (req) => {
    const body = (req.body ?? {}) as { keyId?: string };
    const actor = actorOf(req);
    const keyId = body.keyId ?? `pf-sub-${new Date().toISOString().slice(0, 7)}-${Math.random().toString(36).slice(2, 6)}`;
    const pair = generateSigningKeyPair(keyId);
    const ref = `secret://signing/${keyId}`;
    const envelope = seal(pair.privateKeyPkcs8);

    await tx(async (t) => {
      await t.exec(
        `INSERT INTO secrets (ref, kind, ciphertext, nonce, key_version, description)
         VALUES ($1, 'SIGNING_KEY', $2, $3, $4, $5)`,
        [ref, envelope.ciphertext, envelope.nonce, envelope.keyVersion, `订阅签名私钥 ${keyId}`],
      );
      await t.exec(
        `INSERT INTO signing_keys (key_id, algorithm, public_key, private_key_ref, status, signature_version)
         VALUES ($1, 'Ed25519', $2, $3, 'STANDBY', 1)`,
        [keyId, pair.publicKeyRaw, ref],
      );
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'signing.key.create',
        resourceType: 'signing_key', resourceId: keyId,
      });
    });

    // 私钥永不返回
    return { keyId, algorithm: 'Ed25519', publicKey: pair.publicKeyRaw, status: 'STANDBY' };
  });

  app.post('/signing-keys/:keyId/activate', { preHandler: guard('signing:manage') }, async (req) => {
    const { keyId } = req.params as { keyId: string };
    const actor = actorOf(req);
    await tx(async (t) => {
      await t.exec(`UPDATE signing_keys SET status = 'RETIRED', retired_at = now() WHERE status = 'ACTIVE'`);
      const n = await t.exec(
        `UPDATE signing_keys SET status = 'ACTIVE', activated_at = now() WHERE key_id = $1`,
        [keyId],
      );
      if (n === 0) throw notFound('签名密钥');
      await audit(t, {
        actorType: actor.kind, actorId: actor.id, action: 'signing.key.activate',
        resourceType: 'signing_key', resourceId: keyId,
      });
    });
    return { ok: true, active: keyId };
  });

  // 公钥分发：无认证，可缓存 1h
  app.get('/.well-known/proxyforge-signing-keys.json', async (_req, reply) => {
    const rows = await q<Record<string, unknown>>(
      `SELECT key_id, algorithm, public_key, status, signature_version, not_before, not_after
       FROM signing_keys WHERE status IN ('ACTIVE','RETIRED','STANDBY') ORDER BY created_at DESC`,
    );
    reply.header('Cache-Control', 'public, max-age=3600');
    return { keys: rows };
  });
}

/**
 * 附件文件名。
 *
 * 订阅名可能是中文（`公开实验池`），直接塞进 filename= 会在部分客户端上
 * 变成乱码或直接截断。所以给两份：ASCII 兜底 + RFC 5987 的 filename*。
 * 浏览器优先用 filename*，老客户端退回 ASCII 那份。
 */
function contentDisposition(name: string, poolKey: string, format: string, ext: string): string {
  const raw = `${name || poolKey}-${format}.${ext}`;
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/**
 * 取一个池的可发布节点，带上解密后的凭据。
 *
 * 抽成函数是因为有两个入口要用同一份数据：
 *   · `GET /subscriptions/:token` —— 客户端按 URL 拉取
 *   · `GET /subscriptions/:id/export` —— 已登录用户在界面上导出
 * 两边必须给出**完全一致**的节点集合，否则「界面上看到 48 个、客户端只收到 46 个」
 * 这类问题会非常难查。
 *
 * 分级准入在这里再过一遍：订阅与导出都不能成为绕过 SEC-001 的通道。
 *
 * 过滤与命名也放在这里 —— 它们必须发生在**同一处**，否则两个入口
 * 会因为"一个筛了一个没筛"而给出不同结果。
 */
async function loadExportProxies(
  poolId: string,
  poolKey: string,
  settings: { node_filter?: SubscriptionNodeFilter | null; name_template?: string | null } = {},
): Promise<ExportProxy[]> {
  const pool = await q1<{ allowed_tiers: TrustTier[] }>(
    'SELECT allowed_tiers FROM resource_pools WHERE id = $1',
    [poolId],
  );

  const endpoints = await q<EligibleEndpoint>(
    `SELECT v.id, v.protocol, v.host, v.port, v.trust_tier, v.quality_score, v.p50_ms,
            v.credential_ref, v.country_code
     FROM v_subscription_eligible_endpoints v
     JOIN resource_pool_members m ON m.endpoint_id = v.id AND m.pool_id = $1 AND m.suppressed = false
     WHERE v.trust_tier::text = ANY($2::text[])
     ORDER BY v.quality_score DESC, v.p50_ms ASC NULLS LAST
     LIMIT 500`,
    [poolId, pool?.allowed_tiers ?? []],
  );

  // 过滤在取数之后：500 条内存筛选是微秒级，没必要把条件翻成动态 SQL ——
  // 动态拼接的 WHERE 是这类接口最容易出的注入点。
  const filter = normalizeNodeFilter(settings.node_filter);
  const kept = applyNodeFilter(endpoints, filter);

  // 带认证的代理要把账号密码一并交给客户端，否则节点在 Clash 里永远是超时。
  // 凭据在库里是密文，这里一次性取出解密；解密失败不能拖垮整份订阅 ——
  // 一条坏凭据只让那一个节点不可用，其余照发。
  const credRefs = [...new Set(kept.map((e) => e.credential_ref).filter((x): x is string => !!x))];
  const creds = new Map<string, { username: string; password: string }>();
  if (credRefs.length > 0) {
    const rows = await q<{ ref: string; ciphertext: string; nonce: string; key_version: number }>(
      `SELECT ref, encode(ciphertext,'base64') AS ciphertext, encode(nonce,'base64') AS nonce, key_version
       FROM secrets WHERE ref = ANY($1::text[])`,
      [credRefs],
    );
    for (const r of rows) {
      try {
        const plain = JSON.parse(
          open({
            ciphertext: Buffer.from(r.ciphertext, 'base64'),
            nonce: Buffer.from(r.nonce, 'base64'),
            keyVersion: r.key_version,
          }),
        ) as { username?: string; password?: string };
        if (plain.username) creds.set(r.ref, { username: plain.username, password: plain.password ?? '' });
      } catch {
        /* 解密失败：跳过这条凭据，节点仍会发布但不可认证 */
      }
    }
  }

  const proxies = kept.map((e, i) => {
    const p: ExportProxy = {
      name: `pf-${String(i + 1).padStart(2, '0')}`,
      protocol: e.protocol,
      server: e.host,
      port: e.port,
      // char(2) 在 PG 里会补空格到定长，直接拼进节点名会变成 `pf-JP -01`
      country: e.country_code ? e.country_code.trim() : null,
    };
    const cred = e.credential_ref ? creds.get(e.credential_ref) : undefined;
    if (cred) {
      p.username = cred.username;
      p.password = cred.password;
    }
    return p;
  });

  return applyNameTemplate(proxies, settings.name_template, poolKey);
}
