import { exec, q, q1, tx } from '../../db/client.js';
import { audit } from '../../shared/events.js';
import { uuidv7 } from '../../shared/id.js';
import { sha256Hex } from '../../shared/crypto.js';
import { checkPublicUrl, normalizeUrl } from '../../shared/url.js';
import { detectFormat, extractEntries } from '../../shared/extract.js';
import { parseProxyLine } from '../../shared/parser.js';
import { chat } from './client.js';

/**
 * AI 发现任务执行器。
 *
 * 核心立场：**模型只负责"提候选"，采纳与否由本地探测决定。**
 *
 * LLM 给出的 URL 会大量幻觉 —— 域名拼错、路径 404、指向需要登录的页面。
 * 直接把模型输出写进 `resource_sources` 等于把幻觉变成数据。所以每条候选
 * 都必须过三道本地检查：
 *
 *   1. URL 合法性 + SSRF（不能是 127.0.0.1 / 169.254.169.254）
 *   2. 真实可达（HTTP 200 且有内容）
 *   3. 内容可解析（至少解析出 1 条 host:port）
 *
 * 三道都过才入库，且入库时 `enabled = false` + `authorization_status = 'UNKNOWN'`
 * —— AI 可以建议"去这里看看"，但不能替用户决定"这些代理可以用"。
 */

/** 单次任务最多采纳几条。放开会一次性灌进几十个未经确认的源 */
const MAX_ACCEPT = 6;
/** 候选探测上限，防止模型一次吐 50 条把任务拖成几分钟 */
const MAX_CANDIDATES = 12;
const PROBE_TIMEOUT_MS = 12_000;
const PROBE_MAX_BYTES = 2_000_000;

export interface ProposedSource {
  url: string;
  name: string;
  formatHint: string;
  protocols: string[];
  reason: string;
  confidence: number;
  /** 本地检查结论 */
  status: 'ACCEPTED' | 'DUPLICATE' | 'INVALID' | 'UNREACHABLE' | 'EMPTY' | 'UNPARSABLE' | 'OVER_LIMIT';
  detail: string;
  entryCount: number;
  detectedFormat: string;
  /** 推断出的默认协议，决定列表里无 scheme 的行按什么解析 */
  protocolHint: string;
  sourceId: string | null;
}

export interface DiscoveryOutcome {
  taskId: string;
  ok: boolean;
  proposed: number;
  accepted: number;
  durationMs: number;
  model: string | null;
  error: string | null;
  items: ProposedSource[];
}

interface LlmSourceItem {
  url?: unknown;
  name?: unknown;
  formatHint?: unknown;
  protocols?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

/**
 * 从 URL 派生一个**可读**的 source key。
 *
 * 只用 hostname 不够：`raw.githubusercontent.com` 上挂了成百上千个列表，
 * 全都会塌缩成 `ai-raw-githubusercontent-com-xxxxxx`，界面上完全分不清谁是谁。
 * 所以带上路径里的仓库名与文件名：`ai-gh-thespeedx-http-4f1a2`。
 *
 * 末尾保留 5 位哈希，保证同仓库不同路径也不会撞 key。
 */
function sourceKeyOf(url: string): string {
  const u = new URL(url);
  const host = u.hostname
    .replace(/^www\./, '')
    .replace(/^raw\.githubusercontent\.com$/, 'gh')
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const slug = (s: string): string => s.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  const parts = segs.length >= 2 ? [slug(segs[0]!), slug(segs[segs.length - 1]!)] : segs.map(slug);
  const uniq = parts.filter((p, i) => p && parts.indexOf(p) === i);

  const base = ['ai', host, ...uniq].filter(Boolean).join('-');
  const tail = sha256Hex(normalizeUrl(url)).slice(0, 5);
  return `${base}-${tail}`.slice(0, 60);
}

function sourceTypeOf(format: string): 'API' | 'CSV_FEED' | 'WEB_PAGE' {
  if (format === 'json') return 'API';
  if (format === 'csv') return 'CSV_FEED';
  return 'WEB_PAGE';
}

/**
 * 推断列表里默认的协议。
 *
 * 不做这一步会出实质错误：`monosans/proxy-list/proxies/socks5.txt` 里全是
 * `host:port`，没有 scheme 前缀，解析器只能按默认协议走 —— 默认 HTTP 的话
 * 整个 SOCKS5 列表会被当成 HTTP 代理入库，之后所有验证必然全挂，
 * 而且错得无声无息（表现只是"这批候选存活率特别低"）。
 *
 * 优先级：URL 里的关键词 > 模型声明的 protocols > HTTP。
 */
function inferProtocolHint(url: string, protocols: string[]): 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS4' | 'SOCKS5' {
  const hay = url.toLowerCase();
  if (/socks5|socks-5|socks_5/.test(hay)) return 'SOCKS5';
  if (/socks4|socks-4|socks_4/.test(hay)) return 'SOCKS4';

  const declared = protocols.map((p) => p.toUpperCase());
  if (declared.includes('SOCKS5')) return 'SOCKS5';
  if (declared.includes('SOCKS4')) return 'SOCKS4';
  if (declared.includes('HTTPS_CONNECT') || declared.includes('HTTPS')) return 'HTTPS_CONNECT';
  return 'HTTP';
}

interface ProbeResult {
  reachable: boolean;
  detail: string;
  entryCount: number;
  format: string;
  contentHash: string | null;
}

/**
 * 探测一个候选 URL 是否真的是一份可解析的代理列表。
 *
 * 只读前 2MB 且只解析前 4000 条 —— 目标是"判断有没有料"，
 * 不是"完整同步"。完整同步交给正常的手动/定时同步流程。
 */
async function probeCandidate(url: string, hint: string, protocolHint: 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS4' | 'SOCKS5'): Promise<ProbeResult> {
  const empty = (detail: string): ProbeResult => ({
    reachable: false, detail, entryCount: 0, format: '-', contentHash: null,
  });

  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { 'user-agent': 'ProxyForge/1.0 (ai-discovery)' },
      redirect: 'follow',
    });
  } catch (err) {
    return empty(`请求失败：${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) return empty(`HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > PROBE_MAX_BYTES * 4) return empty(`响应过大（${Math.round(declared / 1024)} KB）`);

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return empty(`读取响应失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.length > PROBE_MAX_BYTES) text = text.slice(0, PROBE_MAX_BYTES);
  if (!text.trim()) return empty('响应为空');

  const format = detectFormat(text, hint === '-' ? null : hint);
  const { entries } = extractEntries(text, hint === '-' ? null : hint, protocolHint);

  // 逐行试解析，只统计"真的能变成 host:port"的行。
  // extractEntries 可能把 HTML 里的任意文本都当成候选行，这里必须实际解析一遍。
  let parseable = 0;
  let protocol: 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS4' | 'SOCKS5' = protocolHint;
  for (const e of entries.slice(0, 4000)) {
    const parsed = parseProxyLine(e.raw, e.protocolHint ?? protocolHint);
    if ('error' in parsed) continue;
    parseable += 1;
    if (parseable === 1) protocol = parsed.protocol;
  }

  if (parseable === 0) {
    return {
      reachable: true, detail: `可达但解析不出代理（${format}，${entries.length} 行）`,
      entryCount: 0, format, contentHash: sha256Hex(text),
    };
  }

  return {
    reachable: true,
    detail: `可达 · ${format} · ${parseable} 条可解析 · 首个协议 ${protocol}`,
    entryCount: parseable,
    format,
    contentHash: sha256Hex(text),
  };
}

function buildPrompt(existing: Array<{ key: string; url: string | null; name: string }>, query: string | null): string {
  const existingList = existing
    .filter((s) => s.url)
    .slice(0, 40)
    .map((s) => `- ${s.url}  (${s.key})`)
    .join('\n');

  return [
    '你是公开代理资源目录的检索助手。任务：找出**新的**、可直接用 HTTP GET 获取的公开代理列表地址。',
    '',
    query ? `本次的检索方向：${query}` : '本次不限定方向，优先补充 HTTP 与 SOCKS5 列表。',
    '',
    '硬性要求：',
    '- 只推荐返回纯文本 / JSON / CSV 的列表，内容形如 `host:port`、`host:port:user:pass` 或 `scheme://host:port`',
    '- 不要推荐需要登录、需要 JS 渲染、需要付费的页面',
    '- 不要推荐 ss:// vmess:// trojan:// vless:// 这类节点订阅',
    '- 不要重复下面「已有来源」里的地址',
    '- 只输出你确信真实存在且当前可访问的地址；不确定就不要写',
    '',
    '已有来源（不要重复）：',
    existingList || '（暂无）',
    '',
    '输出 JSON，结构如下：',
    '{',
    '  "sources": [',
    '    {',
    '      "url": "https://example.com/list.txt",',
    '      "name": "简短中文名",',
    '      "formatHint": "text",',
    '      "protocols": ["HTTP", "SOCKS5"],',
    '      "reason": "为什么认为这个地址有可用列表",',
    '      "confidence": 0.8',
    '    }',
    '  ]',
    '}',
    'formatHint 取 text / json / csv 之一；confidence 取 0 到 1，表示你对"地址真实且内容可解析"的把握。',
    '最多给出 8 条。如果确实找不到新的，就返回 {"sources": []}。',
  ].join('\n');
}

function coerceItems(data: unknown): LlmSourceItem[] {
  if (!data || typeof data !== 'object') return [];
  const raw = (data as { sources?: unknown }).sources;
  return Array.isArray(raw) ? (raw as LlmSourceItem[]) : [];
}

/**
 * 执行一条发现任务。
 *
 * 不抛异常：任务状态与错误都写回 `ai_discovery_tasks`，
 * 让失败在界面上可见，而不是消失在 worker 日志里。
 */
export async function runDiscoveryTask(taskId: string): Promise<DiscoveryOutcome> {
  const t0 = Date.now();
  const outcome: DiscoveryOutcome = {
    taskId, ok: false, proposed: 0, accepted: 0,
    durationMs: 0, model: null, error: null, items: [],
  };

  const task = await q1<{ id: string; query: string | null; status: string }>(
    'SELECT id, query, status FROM ai_discovery_tasks WHERE id = $1',
    [taskId],
  );
  if (!task) {
    outcome.error = '任务不存在';
    return outcome;
  }

  // 认领：只允许从 PENDING / RUNNING(超时) 进入，避免重复执行
  const claimed = await exec(
    `UPDATE ai_discovery_tasks
     SET status = 'RUNNING', started_at = now(), attempts = attempts + 1,
         lease_owner = 'worker', lease_expires_at = now() + interval '5 minutes'
     WHERE id = $1 AND status IN ('PENDING','RUNNING')
       AND (lease_expires_at IS NULL OR lease_expires_at < now() OR status = 'PENDING')`,
    [taskId],
  );
  if (claimed === 0) {
    outcome.error = '任务已被其他执行者认领或已结束';
    return outcome;
  }

  const fail = async (message: string): Promise<DiscoveryOutcome> => {
    outcome.error = message;
    outcome.durationMs = Date.now() - t0;
    await exec(
      `UPDATE ai_discovery_tasks
       SET status = 'FAILED', finished_at = now(), error_message = $2
       WHERE id = $1`,
      [taskId, message.slice(0, 800)],
    );
    return outcome;
  };

  const existing = await q<{ key: string; url: string | null; name: string }>(
    'SELECT key, url, name FROM resource_sources ORDER BY created_at DESC LIMIT 200',
  );
  const existingUrls = new Set(
    existing.filter((s) => s.url).map((s) => normalizeUrl(s.url as string)),
  );

  const llm = await chat({
    taskType: 'DISCOVERY',
    json: true,
    // 不指定 thinking —— DISCOVERY 默认开思考。关掉会让模型对
    // 「你确信存在的地址」这类问题直接返回空数组（实测）。
    messages: [
      { role: 'system', content: '你是严谨的资源目录检索助手，只输出合法 JSON，不输出任何解释。' },
      { role: 'user', content: buildPrompt(existing, task.query) },
    ],
  });

  if (!llm.ok) return fail(llm.error ?? '模型调用失败');
  outcome.model = llm.modelName;

  const items = coerceItems(llm.data).slice(0, MAX_CANDIDATES);
  outcome.proposed = items.length;
  if (items.length === 0) {
    outcome.ok = true;
    outcome.durationMs = Date.now() - t0;
    await exec(
      `UPDATE ai_discovery_tasks
       SET status = 'SUCCEEDED', finished_at = now(), model_name = $2,
           proposed_sources = '[]'::jsonb,
           result_summary = jsonb_build_object('proposed', 0, 'accepted', 0, 'note', '模型未给出候选')
       WHERE id = $1`,
      [taskId, llm.modelName],
    );
    return outcome;
  }

  const seen = new Set<string>();
  const accepted: ProposedSource[] = [];

  for (const item of items) {
    const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
    const entry: ProposedSource = {
      url: rawUrl,
      name: typeof item.name === 'string' ? item.name.slice(0, 80) : '',
      formatHint: typeof item.formatHint === 'string' ? item.formatHint : '-',
      protocols: Array.isArray(item.protocols) ? item.protocols.map(String).slice(0, 4) : [],
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 300) : '',
      confidence: typeof item.confidence === 'number' ? Math.min(1, Math.max(0, item.confidence)) : 0,
      status: 'INVALID',
      detail: '',
      entryCount: 0,
      detectedFormat: '-',
      protocolHint: 'HTTP',
      sourceId: null,
    };

    if (!rawUrl) {
      entry.detail = '模型未给出 URL';
      outcome.items.push(entry);
      continue;
    }

    const check = checkPublicUrl(rawUrl);
    if (!check.ok) {
      entry.detail = check.reason;
      outcome.items.push(entry);
      continue;
    }
    const normalized = normalizeUrl(rawUrl);
    if (existingUrls.has(normalized) || seen.has(normalized)) {
      entry.status = 'DUPLICATE';
      entry.detail = '与已有来源重复';
      outcome.items.push(entry);
      continue;
    }
    seen.add(normalized);

    // 先推断协议再判上限：超限的条目也要在结果里显示正确的协议，
    // 否则用户看到的是"这条是 HTTP"而被拒，容易误判成推断逻辑坏了。
    const protocolHint = inferProtocolHint(rawUrl, entry.protocols);
    entry.protocolHint = protocolHint;

    if (accepted.length >= MAX_ACCEPT) {
      entry.status = 'OVER_LIMIT';
      entry.detail = `超过单次采纳上限（${MAX_ACCEPT}）`;
      outcome.items.push(entry);
      continue;
    }

    const probe = await probeCandidate(rawUrl, entry.formatHint, protocolHint);
    entry.entryCount = probe.entryCount;
    entry.detectedFormat = probe.format;
    entry.detail = probe.detail;

    if (!probe.reachable) {
      entry.status = 'UNREACHABLE';
      outcome.items.push(entry);
      continue;
    }
    if (probe.entryCount === 0) {
      entry.status = 'UNPARSABLE';
      outcome.items.push(entry);
      continue;
    }

    // 三道检查都过 —— 入库，但保持停用 + 未授权
    const sourceId = uuidv7();
    const key = sourceKeyOf(rawUrl);
    try {
      await tx(async (t) => {
        await t.exec(
          `INSERT INTO resource_sources
             (id, key, name, type, url, format_hint, authorization_status, trust_level,
              enabled, sync_interval_seconds, config, notes)
           VALUES ($1,$2,$3,$4,$5,$6,'UNKNOWN',30,false,21600,$7,$8)`,
          [
            sourceId, key,
            entry.name || new URL(rawUrl).hostname,
            sourceTypeOf(probe.format), rawUrl, probe.format,
            JSON.stringify({
              // 同步流程靠这个字段决定"没有 scheme 前缀的行按什么协议解析"
              protocolHint,
              discoveredBy: 'AI',
              taskId,
              model: llm.modelName,
              confidence: entry.confidence,
              reason: entry.reason,
              probedEntries: probe.entryCount,
              contentHash: probe.contentHash,
            }),
            '由 AI 发现并本地探测通过，等待人工启用。授权状态未知，不可用于任何订阅。',
          ],
        );
        await audit(t, {
          actorType: 'SYSTEM', actorId: null,
          action: 'source.ai_discover',
          resourceType: 'resource_source', resourceId: sourceId,
          afterState: { url: rawUrl, key, entries: probe.entryCount, format: probe.format },
        });
      });
      entry.status = 'ACCEPTED';
      entry.sourceId = sourceId;
      accepted.push(entry);
    } catch (err) {
      // key 冲突（同主机不同路径已存在）不应该让整个任务失败
      entry.status = 'DUPLICATE';
      entry.detail = `入库失败（可能 key 冲突）：${err instanceof Error ? err.message : String(err)}`;
    }
    outcome.items.push(entry);
  }

  outcome.accepted = accepted.length;
  outcome.ok = true;
  outcome.durationMs = Date.now() - t0;

  await exec(
    `UPDATE ai_discovery_tasks
     SET status = 'SUCCEEDED', finished_at = now(), model_name = $2,
         proposed_sources = $3::jsonb,
         result_summary = jsonb_build_object(
           'proposed', $4::int, 'accepted', $5::int,
           'rejected', ($4::int - $5::int),
           'durationMs', $6::int,
           'note', '已采纳的来源为停用状态，需人工启用'
         )
     WHERE id = $1`,
    [taskId, llm.modelName, JSON.stringify(outcome.items), outcome.proposed, outcome.accepted, outcome.durationMs],
  );

  return outcome;
}
