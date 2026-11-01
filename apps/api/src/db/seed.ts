import { exec, q, q1, tx } from './client.js';
import { migrate } from './migrate.js';
import { hashPassword, seal, sha256Hex, generateSigningKeyPair } from '../shared/crypto.js';
import { uuidv7 } from '../shared/id.js';
import { dedupeKey } from '../shared/parser.js';
import type { TrustTier } from '@proxyforge/contracts';

/**
 * 种子数据。
 *
 * 原则：**这是 fixture，不是生产数据**。
 * 所有地址使用 RFC 5737 文档保留段（198.18.0.0/15、203.0.113.0/24），
 * 不会命中任何真实主机；`PF_PROBE_MODE=fixture` 时探针也返回合成结果。
 * 界面上必须能看到 "Fixture data" 标记 —— 不允许伪装成真实运营数据。
 */

// 确定性 PRNG，保证每次 seed 结果一致，回归可复现
let seedState = 0x2f6e2b1;
function rnd(): number {
  seedState = (seedState * 1664525 + 1013904223) >>> 0;
  return seedState / 0x100000000;
}
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const between = (a: number, b: number): number => Math.floor(a + rnd() * (b - a + 1));

const COUNTRIES = [
  { code: 'SG', region: 'Asia-Pacific', city: 'Singapore', isp: 'DigitalOcean', asn: 14061 },
  { code: 'JP', region: 'Asia-Pacific', city: 'Tokyo', isp: 'Vultr', asn: 20473 },
  { code: 'HK', region: 'Asia-Pacific', city: 'Hong Kong', isp: 'Alibaba Cloud', asn: 45102 },
  { code: 'US', region: 'North America', city: 'Ashburn', isp: 'AWS', asn: 16509 },
  { code: 'DE', region: 'Europe', city: 'Frankfurt', isp: 'Hetzner', asn: 24940 },
  { code: 'GB', region: 'Europe', city: 'London', isp: 'OVH', asn: 16276 },
  { code: 'NL', region: 'Europe', city: 'Amsterdam', isp: 'Leaseweb', asn: 28753 },
  { code: 'BR', region: 'South America', city: 'São Paulo', isp: 'Linode', asn: 63949 },
  { code: 'IN', region: 'Asia-Pacific', city: 'Mumbai', isp: 'AWS', asn: 16509 },
  { code: 'AU', region: 'Oceania', city: 'Sydney', isp: 'Vultr', asn: 20473 },
];

const PROTOCOLS = ['SOCKS5', 'SOCKS5', 'SOCKS5', 'HTTP', 'HTTP', 'HTTPS_CONNECT'] as const;

function docIp(): string {
  // 198.18.0.0/15 — RFC 2544 基准测试保留段，保证不可路由
  return `198.${18 + between(0, 1)}.${between(1, 254)}.${between(1, 254)}`;
}

interface EndpointSeed {
  id: string;
  tier: TrustTier;
  lifecycle: string;
  country: (typeof COUNTRIES)[number];
  protocol: (typeof PROTOCOLS)[number];
  host: string;
  port: number;
  quality: number;
  p50: number;
  p95: number;
  jitter: number;
  successRate: number;
  grant: boolean;
  origin: string;
}

function buildEndpoints(): EndpointSeed[] {
  const out: EndpointSeed[] = [];

  // 私有代理 18：自有/付费，质量最好，可授予网关权限
  for (let i = 0; i < 18; i += 1) {
    const c = pick(COUNTRIES);
    const p50 = between(28, 90);
    out.push({
      id: uuidv7(),
      tier: 'PRIVATE_PROXY',
      lifecycle: i < 15 ? 'HEALTHY' : 'DEGRADED',
      country: c,
      protocol: pick(['SOCKS5', 'SOCKS5', 'HTTPS_CONNECT']),
      host: docIp(),
      port: 10000 + i,
      quality: between(88, 99),
      p50,
      p95: p50 + between(20, 60),
      jitter: between(3, 18),
      successRate: 0.97 + rnd() * 0.029,
      grant: true,
      origin: 'OWNED',
    });
  }

  // 已验证代理 26：商业供应商，质量次之，不进网关
  for (let i = 0; i < 26; i += 1) {
    const c = pick(COUNTRIES);
    const p50 = between(55, 190);
    out.push({
      id: uuidv7(),
      tier: 'VERIFIED_PROXY',
      lifecycle: i < 19 ? 'HEALTHY' : i < 23 ? 'DEGRADED' : 'UNAVAILABLE',
      country: c,
      protocol: pick(PROTOCOLS),
      host: docIp(),
      port: 20000 + i,
      quality: between(62, 92),
      p50,
      p95: p50 + between(30, 140),
      jitter: between(8, 45),
      successRate: 0.82 + rnd() * 0.16,
      grant: false,
      origin: 'PAID_PROVIDER',
    });
  }

  // 公开代理 78：数量最多，质量最差，只能进实验池
  for (let i = 0; i < 78; i += 1) {
    const c = pick(COUNTRIES);
    const p50 = between(90, 780);
    const life = i < 34 ? 'HEALTHY' : i < 52 ? 'DEGRADED' : i < 68 ? 'UNAVAILABLE' : i < 73 ? 'PENDING_VERIFICATION' : 'QUARANTINED';
    out.push({
      id: uuidv7(),
      tier: 'PUBLIC_PROXY',
      lifecycle: life,
      country: c,
      protocol: pick(PROTOCOLS),
      host: docIp(),
      port: 30000 + i,
      quality: between(18, 74),
      p50,
      p95: p50 + between(60, 400),
      jitter: between(20, 180),
      successRate: 0.35 + rnd() * 0.55,
      grant: false,
      origin: 'PUBLIC_PROXY',
    });
  }

  return out;
}

export async function seed(): Promise<void> {
  await migrate(false);

  // schema 的 ensure_monthly_partitions() 只建「当月及未来」，
  // 但种子要写 14 天前的历史数据，跨月时目标分区还不存在。
  // 这里向前回填 3 个月，避免 23514（无匹配分区）。
  await exec(`
    DO $$
    DECLARE
      v_parent text;
      v_start  timestamptz;
      v_end    timestamptz;
      v_name   text;
      i        int;
    BEGIN
      FOREACH v_parent IN ARRAY ARRAY['health_checks','endpoint_metrics_hourly','gateway_traffic_samples','audit_events'] LOOP
        FOR i IN -3..0 LOOP
          v_start := date_trunc('month', now()) + (i || ' month')::interval;
          v_end   := v_start + interval '1 month';
          v_name  := v_parent || '_' || to_char(v_start, 'YYYYMM');
          EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                         v_name, v_parent, v_start, v_end);
        END LOOP;
      END LOOP;
    END $$;
  `);

  const existing = await q1<{ c: string }>('SELECT count(*)::text AS c FROM proxy_users');
  if (Number(existing?.c ?? 0) > 0) {
    console.log('已有数据，跳过 seed（如需重建请先 npm run db:reset）');
    return;
  }

  console.log('写入种子数据…');
  const t0 = performance.now();

  // ── 用户 ──
  const adminId = uuidv7();
  const operatorId = uuidv7();
  const viewerId = uuidv7();
  await exec(
    `INSERT INTO proxy_users (id, username, display_name, password_hash, role) VALUES
       ($1,'admin','Admin',$4,'ADMIN'),
       ($2,'operator','Operator',$4,'OPERATOR'),
       ($3,'viewer','Viewer',$4,'VIEWER')`,
    [adminId, operatorId, viewerId, hashPassword('proxyforge')],
  );

  // ── API Key（明文只在此处出现一次） ──
  const apiKeyPlain = 'pf_live_demo_key_do_not_use_in_production';
  await exec(
    `INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, scopes)
     VALUES ($1,$2,'demo-key',$3,$4,$5::text[])`,
    [uuidv7(), adminId, apiKeyPlain.slice(0, 12), sha256Hex(apiKeyPlain),
     ['resource:read', 'resource:write', 'pool:read', 'pool:write', 'trust:read', 'trust:review']],
  );

  // ── 来源 ──
  const sourceManual = uuidv7();
  const sourceGithub = uuidv7();
  const sourceFeed = uuidv7();
  await exec(
    `INSERT INTO resource_sources (id, key, name, type, url, format_hint, authorization_status, trust_level, last_synced_at, enabled)
     VALUES
       ($1,'manual-paste','Manual Paste','MANUAL',NULL,'text','AUTHORIZED',70, now(), true),
       -- 下面两个是占位示例，URL 指向 example.com。默认停用：留着 enabled=true 会让
       -- 每次「全部同步」都稳定产生 2 条 HTTP 404，把真正的失败淹没掉。
       -- 真实公开源由 POST /sources/catalog 导入（shared/sources-catalog.ts）。
       ($2,'gh-proxy-list','GitHub Proxy List','GITHUB_REPO','https://example.com/proxies.txt','text','UNKNOWN',40, now() - interval '2 hours', false),
       ($3,'vendor-feed-a','Vendor Feed A','API','https://example.com/api/proxies','json','AUTHORIZED',80, now() - interval '20 minutes', false)`,
    [sourceManual, sourceGithub, sourceFeed],
  );

  // ── 端点 ──
  const endpoints = buildEndpoints();

  for (const e of endpoints) {
    const ipId = uuidv7();
    const key = dedupeKey({
      protocol: e.protocol, host: e.host, port: e.port, username: null, password: null,
    });

    await exec(
      `INSERT INTO ip_assets (id, ip, ip_version, ip_type, ip_type_confidence, network_type,
         asn, as_org, country_code, region, city, isp, last_verified_at)
       VALUES ($1,$2,4,$3,'OBSERVED',$4,$5,$6,$7,$8,$9,$10, now())`,
      [
        ipId, e.host,
        e.tier === 'PUBLIC_PROXY' ? 'DYNAMIC' : 'STATIC',
        e.tier === 'PUBLIC_PROXY' ? 'DATACENTER' : pick(['DATACENTER', 'RESIDENTIAL']),
        e.country.asn, e.country.isp, e.country.code, e.country.region, e.country.city, e.country.isp,
      ],
    );

    await exec(
      `INSERT INTO proxy_endpoints
         (id, ip_asset_id, source_id, protocol, host, port, origin_type, authorization_status,
          trust_tier, explicit_gateway_grant, lifecycle_status, quality_score, display_name,
          expected_country, dedupe_key, tags, last_verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::text[], now() - ($17 || ' minutes')::interval)`,
      [
        e.id, ipId, e.tier === 'PRIVATE_PROXY' ? sourceFeed : sourceGithub,
        e.protocol, e.host, e.port, e.origin,
        e.lifecycle === 'PENDING_VERIFICATION' ? 'UNKNOWN' : 'AUTHORIZED',
        e.tier, e.grant, e.lifecycle, e.quality,
        `${e.country.code}-${e.protocol.toLowerCase()}-${String(e.port).slice(-2)}`,
        e.country.code, key,
        e.tier === 'PUBLIC_PROXY' ? ['public', 'unverified'] : e.tier === 'PRIVATE_PROXY' ? ['owned', 'core'] : ['vendor'],
        between(1, 600),
      ],
    );

    await exec(
      `INSERT INTO endpoint_health_state
         (endpoint_id, last_check_at, last_success_at, success, consecutive_failures,
          consecutive_successes, p50_ms, p95_ms, jitter_ms, success_rate_24h, quality_score, scored_at)
       VALUES ($1, now() - ($2 || ' minutes')::interval,
               CASE WHEN $3 THEN now() - ($2 || ' minutes')::interval ELSE NULL END,
               $3, $4, $5, $6, $7, $8, $9, $10, now())`,
      [
        e.id, between(1, 90), e.lifecycle === 'HEALTHY' || e.lifecycle === 'DEGRADED',
        e.lifecycle === 'HEALTHY' ? 0 : between(1, 6),
        e.lifecycle === 'HEALTHY' ? between(4, 40) : 0,
        e.p50, e.p95, e.jitter,
        Math.round(e.successRate * 10000) / 10000, e.quality,
      ],
    );
  }
  console.log(`  ✓ ${endpoints.length} 个端点`);

  // ── 健康检查历史（14 天，用于趋势图） ──
  // 按「行」组织，避免并行数组索引错位这类低级错误
  const histRows: unknown[][] = [];
  for (const e of endpoints) {
    if (e.lifecycle === 'PENDING_VERIFICATION' || e.lifecycle === 'QUARANTINED') continue;
    for (let d = 13; d >= 0; d -= 1) {
      const n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k += 1) {
        const ok = rnd() < e.successRate;
        histRows.push([
          e.id,
          `${d} days ${between(0, 20)} hours`,
          ok,
          ok ? 'NONE' : pick(['TCP_TIMEOUT', 'DNS_FAILURE', 'AUTH_FAILED', 'PROTOCOL_ERROR']),
          ok ? between(2, 20) : null,
          ok ? Math.max(8, e.p50 + between(-15, 40)) : null,
          ok ? between(20, 140) : null,
        ]);
      }
    }
  }

  const BATCH = 300;
  for (let i = 0; i < histRows.length; i += BATCH) {
    const chunk = histRows.slice(i, i + BATCH);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of chunk) {
      let idx = params.length + 1;
      const [endpointId, ago, success, reason, dnsMs, tcpMs, hsMs] = row as [
        string, string, boolean, string, number | null, number | null, number | null,
      ];
      tuples.push(
        `($${idx++}, now() - interval '${ago}', $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++})`,
      );
      params.push(endpointId, success, reason, dnsMs, tcpMs, hsMs);
    }
    await exec(
      `INSERT INTO health_checks (endpoint_id, checked_at, success, failure_reason, dns_ms, tcp_ms, handshake_ms)
       VALUES ${tuples.join(',')}`,
      params,
    );
  }
  console.log(`  ✓ ${histRows.length} 条健康检查记录`);

  // ── 资源池 ──
  const poolStable = uuidv7();
  const poolExperimental = uuidv7();
  const poolFast = uuidv7();

  await exec(
    `INSERT INTO resource_pools (id, key, name, description, purpose, min_quality, max_members,
       allowed_tiers, experimental, member_count)
     VALUES
       ($1,'STATIC_STABLE','Static Stable','长期稳定出口，仅限自有与已验证资源','production egress',70,40,
          '{PRIVATE_PROXY,VERIFIED_PROXY}'::trust_tier[], false, 0),
       ($2,'PUBLIC_EXPERIMENTAL','Public Experimental','公开代理实验池。可用性不等于合法性，不承担生产流量。',
          'connectivity experiments',0,120,'{PUBLIC_PROXY}'::trust_tier[], true, 0),
       ($3,'LOW_LATENCY_APAC','Low Latency APAC','亚太低延迟场景','regional acceleration',60,25,
          '{PRIVATE_PROXY,VERIFIED_PROXY}'::trust_tier[], false, 0)`,
    [poolStable, poolExperimental, poolFast],
  );

  await exec(
    `INSERT INTO resource_pool_rules (id, pool_id, rule_order, name, predicate) VALUES
       ($1,$2,1,'healthy & high quality','{"all":[{"field":"qualityScore","op":"gte","value":70},{"field":"lifecycleStatus","op":"in","value":["HEALTHY","DEGRADED"]}]}'::jsonb),
       ($3,$4,1,'any public proxy','{"all":[{"field":"trustTier","op":"in","value":["PUBLIC_PROXY"]}]}'::jsonb),
       ($5,$6,1,'apac low latency','{"all":[{"field":"qualityScore","op":"gte","value":60},{"field":"countryCode","op":"in","value":["SG","JP","HK","IN","AU"]}]}'::jsonb)`,
    [uuidv7(), poolStable, uuidv7(), poolExperimental, uuidv7(), poolFast],
  );

  // ── 池成员（直接落成员，不跑规则引擎，保证 seed 后即可用） ──
  for (const e of endpoints) {
    let poolId: string | null = null;
    if (e.tier === 'PRIVATE_PROXY' && e.quality >= 70) poolId = poolStable;
    else if (e.tier === 'VERIFIED_PROXY' && e.quality >= 70) poolId = poolStable;
    else if (e.tier === 'PUBLIC_PROXY') poolId = poolExperimental;

    if (poolId) {
      await exec(
        `INSERT INTO resource_pool_members (id, pool_id, endpoint_id, source, weight, suppressed)
         VALUES ($1,$2,$3,'AUTO',$4,$5) ON CONFLICT DO NOTHING`,
        [uuidv7(), poolId, e.id, between(50, 200), e.lifecycle === 'QUARANTINED'],
      );
    }
    if (['SG', 'JP', 'HK', 'IN', 'AU'].includes(e.country.code) && e.quality >= 60 && e.tier !== 'PUBLIC_PROXY') {
      await exec(
        `INSERT INTO resource_pool_members (id, pool_id, endpoint_id, source, weight)
         VALUES ($1,$2,$3,'AUTO',$4) ON CONFLICT DO NOTHING`,
        [uuidv7(), poolFast, e.id, between(80, 200)],
      );
    }
  }

  await exec(
    `UPDATE resource_pools p SET member_count =
       (SELECT count(*) FROM resource_pool_members m WHERE m.pool_id = p.id)`,
  );

  // ── 网关实例：正式与实验物理分离 ──
  const gwPrimary = uuidv7();
  const gwLab = uuidv7();
  await exec(
    `INSERT INTO gateway_instances (id, name, engine, bind_host, http_port, socks_port, status, last_seen_at)
     VALUES ($1,'gost-primary','gost','127.0.0.1',8080,1080,'APPLIED', now()),
            ($2,'gost-lab','gost','127.0.0.1',8095,1081,'APPLIED', now())`,
    [gwPrimary, gwLab],
  );

  // ── 策略 ──
  // 正式策略绑到 gost-primary，实验策略绑到 gost-lab。
  // 物理隔离不是靠命名约定，而是靠 instance_id 绑定 + 编译期过滤。
  await exec(
    `INSERT INTO routing_policies (id, key, name, strategy, pool_id, listen_port, priority, max_members, instance_id)
     VALUES
       ($1,'STATIC_STABLE','Static Stable','FASTEST',$2,18080,10,40,$5),
       ($3,'LOW_LATENCY_APAC','Low Latency APAC','WEIGHTED',$4,18081,20,25,$5),
       ($6,'PUBLIC_LAB','Public Lab (isolated)','FASTEST',$7,19080,90,50,$8)`,
    [uuidv7(), poolStable, uuidv7(), poolFast, gwPrimary, uuidv7(), poolExperimental, gwLab],
  );

  // ── AI Providers ──
  const aiDeepseek = uuidv7();
  const aiOpenrouter = uuidv7();
  const aiOllama = uuidv7();
  await exec(
    `INSERT INTO ai_providers (id, key, name, type, base_url, enabled, timeout_ms, budget_monthly_usd,
       spent_current_month, last_tested_at, last_test_ok, allow_private_network)
     VALUES
       ($1,'deepseek-main','DeepSeek','OPENAI_COMPATIBLE','https://api.deepseek.com',true,30000,50.00,12.4821, now() - interval '12 minutes', true, false),
       ($2,'openrouter','OpenRouter','OPENAI_COMPATIBLE','https://openrouter.ai/api/v1',true,45000,30.00,4.1103, now() - interval '40 minutes', true, false),
       ($3,'ollama-local','Ollama (local)','OLLAMA','http://127.0.0.1:11434',false,120000,NULL,0, now() - interval '3 hours', false, true)`,
    [aiDeepseek, aiOpenrouter, aiOllama],
  );

  const models: Array<[string, string, string, number, number]> = [
    [aiDeepseek, 'deepseek-chat', 'DeepSeek Chat', 0.00014, 0.00028],
    [aiDeepseek, 'deepseek-reasoner', 'DeepSeek Reasoner', 0.00055, 0.00219],
    [aiOpenrouter, 'anthropic/claude-sonnet-4', 'Claude Sonnet 4', 0.003, 0.015],
    [aiOpenrouter, 'meta-llama/llama-3.3-70b', 'Llama 3.3 70B', 0.00059, 0.00079],
    [aiOllama, 'qwen2.5:14b', 'Qwen 2.5 14B', 0, 0],
  ];
  const modelIds: Record<string, string> = {};
  for (const [pid, name, display, inCost, outCost] of models) {
    const id = uuidv7();
    modelIds[`${pid}:${name}`] = id;
    await exec(
      `INSERT INTO ai_models (id, provider_id, model_name, display_name, input_cost_per_1k, output_cost_per_1k, supports_json)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [id, pid, name, display, inCost, outCost],
    );
  }

  await exec(
    `INSERT INTO ai_task_bindings (id, task_type, provider_id, model_id, priority, max_tokens, temperature) VALUES
       ($1,'DISCOVERY',$2,$3,100,2000,0.2),
       ($4,'DISCOVERY',$5,$6,110,2000,0.3),
       ($7,'ANALYZER',$2,$8,100,4000,0.1),
       ($9,'CLASSIFIER',$2,$10,100,1000,0.0),
       ($11,'EVALUATOR',$5,$12,100,2000,0.0)`,
    [
      uuidv7(), aiDeepseek, modelIds[`${aiDeepseek}:deepseek-chat`],
      uuidv7(), aiOpenrouter, modelIds[`${aiOpenrouter}:meta-llama/llama-3.3-70b`],
      uuidv7(), modelIds[`${aiDeepseek}:deepseek-reasoner`],
      uuidv7(), modelIds[`${aiDeepseek}:deepseek-chat`],
      uuidv7(), modelIds[`${aiOpenrouter}:anthropic/claude-sonnet-4`],
    ],
  );

  // AI 用量记录（30 天）
  for (let d = 29; d >= 0; d -= 1) {
    const calls = between(8, 40);
    for (let i = 0; i < calls; i += 1) {
      const isDs = rnd() < 0.72;
      const pid = isDs ? aiDeepseek : aiOpenrouter;
      const mid = isDs ? modelIds[`${aiDeepseek}:deepseek-chat`] : modelIds[`${aiOpenrouter}:meta-llama/llama-3.3-70b`];
      const pt = between(300, 3000);
      const ct = between(100, 1200);
      const ok = rnd() > 0.04;
      await exec(
        `INSERT INTO ai_usage_records (provider_id, model_id, task_type, prompt_tokens, completion_tokens,
           cost_usd, latency_ms, success, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '${d} days' - interval '${between(0, 23)} hours')`,
        [pid, mid, pick(['DISCOVERY', 'ANALYZER', 'CLASSIFIER', 'EVALUATOR']), pt, ct,
         (pt / 1000) * 0.00014 + (ct / 1000) * 0.00028, between(400, 4200), ok],
      );
    }
  }

  // ── 网关流量采样（24h × 每小时） ──
  for (let h = 23; h >= 0; h -= 1) {
    const base = 800 + Math.round(Math.sin((h / 24) * Math.PI * 2) * 400) + between(-90, 90);
    await exec(
      `INSERT INTO gateway_traffic_samples (instance_id, policy_key, sampled_at, connections, bytes_in, bytes_out, errors)
       VALUES ($1,'STATIC_STABLE', now() - interval '${h} hours', $2, $3, $4, $5),
              ($6,'LOW_LATENCY_APAC', now() - interval '${h} hours', $7, $8, $9, $10)`,
      [
        gwPrimary, base, base * between(4000, 9000), base * between(12000, 26000), Math.max(0, Math.round(base * 0.008)),
        gwPrimary, Math.round(base * 0.42), Math.round(base * 0.42) * between(3000, 7000),
        Math.round(base * 0.42) * between(9000, 20000), Math.max(0, Math.round(base * 0.42 * 0.01)),
      ],
    );
  }

  // ── 签名密钥 ──
  const pair = generateSigningKeyPair('pf-sub-2026-11');
  const env = seal(pair.privateKeyPkcs8);
  await exec(
    `INSERT INTO secrets (ref, kind, ciphertext, nonce, key_version, description)
     VALUES ($1,'SIGNING_KEY',$2,$3,$4,'订阅签名私钥 pf-sub-2026-11')`,
    [`secret://signing/pf-sub-2026-11`, env.ciphertext, env.nonce, env.keyVersion],
  );
  await exec(
    `INSERT INTO signing_keys (key_id, algorithm, public_key, private_key_ref, status, signature_version, activated_at)
     VALUES ('pf-sub-2026-11','Ed25519',$1,'secret://signing/pf-sub-2026-11','ACTIVE',1, now())`,
    [pair.publicKeyRaw],
  );

  // ── 订阅 ──
  const subToken = 'pf_sub_demo0000000000000000000000';
  await exec(
    `INSERT INTO subscriptions (id, name, pool_id, format, token_hash, token_prefix, signing_enabled, expires_at, created_by)
     VALUES ($1,'Stable Egress',$2,'mihomo',$3,$4,true, now() + interval '90 days', $5)`,
    [uuidv7(), poolStable, sha256Hex(subToken), subToken.slice(0, 12), adminId],
  );

  // ── 晋升建议（待审） ──
  const pubCandidates = endpoints.filter((e) => e.tier === 'PUBLIC_PROXY' && e.quality > 60).slice(0, 4);
  for (const e of pubCandidates) {
    const days = between(6, 20);
    await exec(
      `INSERT INTO promotion_suggestions
         (id, endpoint_id, suggested_tier, current_tier, confidence, rationale,
          rationale_code, rationale_params, source)
       VALUES ($1,$2,'VERIFIED_PROXY','PUBLIC_PROXY',$3,$4,'STABLE_EXIT_IP',$5::jsonb,'AI')`,
      [uuidv7(), e.id, Math.round((0.62 + rnd() * 0.3) * 1000) / 1000,
       // rationale 是给 API 消费方与审计日志看的英文原文；界面渲染走
       // rationale_code + params，按用户当前语言出文案。
       `Online for ${days} consecutive days, exit IP unchanged, no header injection detected. Suggest a human review of the authorization source before promoting.`,
       JSON.stringify({ days })],
    );
  }

  // ── 审计事件 ──
  for (let i = 0; i < 40; i += 1) {
    const action = pick([
      'resource.import', 'endpoint.quarantine', 'pool.recompute', 'policy.update',
      'gateway.config.apply', 'subscription.create', 'ai.provider.update', 'auth.login',
    ]);
    await exec(
      `INSERT INTO audit_events (occurred_at, actor_type, actor_id, action, resource_type, resource_id, source_ip)
       VALUES (now() - interval '${between(1, 72)} hours', $1, $2, $3, $4, $5, '127.0.0.1')`,
      [pick(['USER', 'SYSTEM', 'SCHEDULER']), pick([adminId, operatorId, null]), action,
       pick(['endpoint', 'pool', 'policy', 'subscription', 'ai_provider']), uuidv7()],
    );
  }

  // ── 用规则引擎收敛池成员 ──
  // 上面直接落成员只是为了让首屏有数据、并保留演示用的调度权重。
  // 但那份"手写捷径"与 resource_pool_rules 里的谓词并不等价
  // （例如规则要求 lifecycleStatus ∈ {HEALTHY, DEGRADED}，捷径只看质量分）。
  // 不收敛的话，worker 第一次周期任务就会算出不同的成员集合，
  // 于是网关配置凭空多出一个新版本 —— 用户看到 v1→v2，内容却只差几个成员。
  // 所以种子结束前跑一遍真正的规则引擎，让持久化状态 = 规则会选出的状态。
  const { recomputePool } = await import('../modules/pool/index.js');
  for (const p of await q<{ id: string; key: string }>('SELECT id, key FROM resource_pools ORDER BY created_at ASC')) {
    const r = await recomputePool(p.id, adminId);
    if (r.added || r.removed) {
      console.log(`  ✓ 池成员已按规则收敛：${p.key}（+${r.added} / -${r.removed}）`);
    }
  }

  // ── 首次编译下发 ──
  // 种子结束后网关必须已经有一版生效配置，否则 Gateway 页首屏是空的，
  // 看起来像"编译功能坏了"。这里对每个实例各编译一次，实验实例自然拿到
  // 独立配置（正式段为空 + 隔离声明），正是要展示的真实状态。
  const { applyPolicies } = await import('../modules/policy/index.js');
  const instRows = await q<{ id: string; name: string }>(
    'SELECT id, name FROM gateway_instances ORDER BY created_at ASC, id ASC',
  );
  for (const inst of instRows) {
    const res = await applyPolicies(inst.id, adminId);
    const warn = res.warnings.length
      ? ' · ' + res.warnings.map((w) => `${w.code}×${w.count ?? 0}`).join(', ')
      : '';
    console.log(`  ✓ 网关配置已编译：${inst.name} → v${res.version}（${res.memberCount} 成员${warn}）`);
  }

  console.log(`  ✓ 种子完成 (${Math.round(performance.now() - t0)}ms)`);
  console.log('');
  console.log('  登录凭据：admin / proxyforge');
  console.log(`  API Key：${apiKeyPlain}`);
  console.log(`  订阅 Token：${subToken}`);
}

const entry = process.argv[1];
if (entry?.endsWith('seed.ts') || entry?.endsWith('seed.js')) {
  await seed();
  process.exit(0);
}
