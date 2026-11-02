import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { lookup } from 'node:dns/promises';
import type { CheckFailureReason, ProxyProtocol } from '@proxyforge/contracts';

/**
 * 分层探针（L1–L5）。
 *
 * 设计要点：**失败必须能定位到层**。
 * 只说"不可用"没有运维价值——要能区分 DNS 挂了、TCP 被拒、TLS 握手失败、
 * 还是代理协议本身认证失败。这就是 failed_layer 字段存在的理由。
 *
 * L1 DNS   L2 TCP   L3 TLS   L4 协议握手   L5 出口 IP
 */

export interface ProbeTarget {
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string | null;
  password?: string | null;
}

export interface ProbeResult {
  success: boolean;
  failedLayer: number | null;
  failureReason: CheckFailureReason;
  dnsMs: number | null;
  tcpMs: number | null;
  handshakeMs: number | null;
  totalMs: number;
  exitIp: string | null;
  exitCountry: string | null;
  errorDetail: string | null;
}

const DEFAULT_TIMEOUT = 4000;

/**
 * 给任意 Promise 加超时。
 *
 * 原实现有两个致命问题，两个都会**杀掉整个进程**：
 *   1. 定时器从不 clear。即使 lookup 早就返回了，4 秒后定时器照样触发，
 *      于是每一次成功探测也会在 4 秒后执行一次 onTimeout。
 *   2. onTimeout 是「抛出异常」，而它是在 setTimeout 回调里被调用的 ——
 *      那个位置没有任何 catch，异常直接变成 uncaughtException。
 * 结果：跑一次验证 → 4 秒后 API 进程退出。而且 worker 会自动认领
 * PENDING 任务，一条坏记录就能让服务反复崩溃。
 *
 * 现在：定时器在 race 落定时清掉，抛出的异常转成 rejection，
 * 由调用方的 try/catch 接住并归到 DNS_FAILURE 层。
 */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (err) {
        reject(err);
      }
    }, ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function probe(target: ProbeTarget, timeoutMs = DEFAULT_TIMEOUT): Promise<ProbeResult> {
  const t0 = performance.now();
  const base: ProbeResult = {
    success: false,
    failedLayer: null,
    failureReason: 'NONE',
    dnsMs: null,
    tcpMs: null,
    handshakeMs: null,
    totalMs: 0,
    exitIp: null,
    exitCountry: null,
    errorDetail: null,
  };

  // ── L1 DNS ──
  const dnsStart = performance.now();
  let address: string;
  try {
    const res = await withTimeout(lookup(target.host), timeoutMs, () => {
      throw Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' });
    });
    address = res.address;
    base.dnsMs = Math.round(performance.now() - dnsStart);
  } catch (err) {
    base.failedLayer = 1;
    base.failureReason = 'DNS_FAILURE';
    base.errorDetail = errText(err);
    base.totalMs = Math.round(performance.now() - t0);
    return base;
  }

  // ── L2 TCP ──
  const tcpStart = performance.now();
  let socket: Socket;
  try {
    socket = await connectTcp(address, target.port, timeoutMs);
    base.tcpMs = Math.round(performance.now() - tcpStart);
  } catch (err) {
    base.failedLayer = 2;
    base.failureReason = classifyTcpError(err);
    base.errorDetail = errText(err);
    base.totalMs = Math.round(performance.now() - t0);
    return base;
  }

  try {
    // ── L3 TLS（仅 HTTPS_CONNECT 需要先与目标建立 TLS 再发 CONNECT） ──
    // 注意：这里刻意不做"到代理的 TLS"，因为 HTTPS 代理的 TLS 是端到端的；
    // 我们验证的是代理能否完成 CONNECT 隧道。
    const hsStart = performance.now();

    // ── L4 协议握手 + L5 出口 IP ──
    const exit = await negotiate(socket, target, timeoutMs);
    base.handshakeMs = Math.round(performance.now() - hsStart);

    if (exit.ok) {
      base.success = true;
      base.exitIp = exit.exitIp;
      base.exitCountry = exit.exitCountry;
    } else {
      base.failedLayer = 4;
      base.failureReason = exit.reason;
      base.errorDetail = exit.detail;
    }
  } finally {
    socket.destroy();
  }

  base.totalMs = Math.round(performance.now() - t0);
  return base;
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = netConnect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(Object.assign(new Error('tcp timeout'), { code: 'ETIMEOUT' }));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

interface Negotiation {
  ok: boolean;
  reason: CheckFailureReason;
  detail: string | null;
  exitIp: string | null;
  exitCountry: string | null;
}

/**
 * 通过代理请求 http://ip-api.com/json —— 这是业界通用做法：
 * 拿到的是**代理的出口 IP**，与期望出口 IP 不一致即判定 EXIT_MISMATCH。
 */
async function negotiate(
  socket: Socket,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<Negotiation> {
  try {
    if (target.protocol === 'SOCKS5') {
      const greeting = await socks5Handshake(socket, target, timeoutMs);
      if (greeting && !greeting.ok) return greeting;
      return await requestExitIp(socket, timeoutMs);
    }
    if (target.protocol === 'SOCKS4') {
      const greeting = await socks4Handshake(socket, target, timeoutMs);
      if (!greeting.ok) return greeting;
      return await requestExitIp(socket, timeoutMs);
    }

    // HTTP / HTTPS_CONNECT
    return await httpProxyProbe(socket, target, timeoutMs);
  } catch (err) {
    return {
      ok: false,
      reason: 'TIMEOUT',
      detail: errText(err),
      exitIp: null,
      exitCountry: null,
    };
  }
}

/**
 * HTTP 代理探活：一次绝对 URI 往返。
 *
 * 为什么不用 CONNECT（早期实现就是这么写的，两个问题）：
 *
 *   1. **假阴性**。CONNECT 测的是隧道能力，而相当一部分免费 HTTP 代理
 *      只做正向代理转发、不支持 CONNECT。用 CONNECT 探会把它们全判死，
 *      可它们在 Clash 里对 http:// 站点依然是能用的。
 *   2. **慢一倍**。CONNECT 成功之后隧道保持打开，读响应只能等超时；
 *      再来一次 GET 才是第二次往返。绝对 URI 一次就拿到出口 IP。
 *
 * 代价是没测隧道能力。这个取舍是刻意的：先把"这个代理到底通不通"
 * 判准，比在同一个布尔值里混两个语义更重要。
 */
async function httpProxyProbe(
  socket: Socket,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<Negotiation> {
  const lines = [
    'GET http://ip-api.com/json HTTP/1.1',
    'Host: ip-api.com',
    'User-Agent: ProxyForge-Probe/1.0',
    'Accept: application/json',
    'Connection: close',
  ];
  // 需要认证的代理不带头会直接回 407，看起来像"协议错误"，
  // 排障时会被误判成代理不支持转发。
  if (target.username) {
    const token = Buffer.from(`${target.username}:${target.password ?? ''}`, 'utf8').toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  socket.write([...lines, '', ''].join('\r\n'));

  const raw = await readUntil(socket, timeoutMs, (s) => s.includes('\r\n\r\n') && s.includes('}'));
  const head = raw.slice(0, Math.max(0, raw.indexOf('\r\n\r\n')));
  const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(head)?.[1];

  if (status === '407') {
    return { ok: false, reason: 'AUTH_FAILED', detail: head.slice(0, 160), exitIp: null, exitCountry: null };
  }
  if (status !== '200') {
    return {
      ok: false,
      reason: 'PROTOCOL_ERROR',
      detail: head.slice(0, 160) || '代理无响应',
      exitIp: null,
      exitCountry: null,
    };
  }

  return parseExitIp(raw);
}

/** 从响应里抠出出口 IP。抽出来是因为三种协议都要走这一段。 */
function parseExitIp(raw: string): Negotiation {
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return { ok: false, reason: 'PROTOCOL_ERROR', detail: '出口探测无 JSON 响应', exitIp: null, exitCountry: null };
  }
  let parsed: { query?: string; countryCode?: string };
  try {
    parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { query?: string; countryCode?: string };
  } catch {
    return { ok: false, reason: 'PROTOCOL_ERROR', detail: '出口探测响应不是合法 JSON', exitIp: null, exitCountry: null };
  }
  return {
    ok: true,
    reason: 'NONE',
    detail: null,
    exitIp: parsed.query ?? null,
    exitCountry: parsed.countryCode ?? null,
  };
}

/** 隧道已建立（SOCKS）后，在隧道内发一次普通请求取出口 IP。 */
async function requestExitIp(socket: Socket, timeoutMs: number): Promise<Negotiation> {
  const get = [
    'GET /json HTTP/1.1',
    'Host: ip-api.com',
    'User-Agent: ProxyForge-Probe/1.0',
    'Accept: application/json',
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  socket.write(get);
  const raw = await readUntil(socket, timeoutMs, (s) => s.includes('}'));
  const status = /^HTTP\/1\.[01]\s+(\d{3})/.exec(raw)?.[1];
  if (status && status !== '200') {
    return { ok: false, reason: 'PROTOCOL_ERROR', detail: raw.slice(0, 160), exitIp: null, exitCountry: null };
  }
  return parseExitIp(raw);
}

/**
 * SOCKS4 / SOCKS4a 握手。
 *
 * 早期版本没有这段：`negotiate` 只对 SOCKS5 走握手，SOCKS4 直接落到裸 GET，
 * 于是全部 SOCKS4 端点必然失败 —— 那 4,516 条候选不管死活都会被判死。
 * 这种"某一类协议整体 0 存活"的结果看起来像数据质量问题，实际是探针缺失。
 *
 * 这里发 SOCKS4a 请求（DSTIP=0.0.0.1，域名跟在末尾），
 * 好处是不必在本地先把目标域名解析成 IPv4 —— 让代理自己去解析，
 * 也顺便避免本地 DNS 结果与代理侧出口不一致造成的假阴性。
 */
function socks4Handshake(
  socket: Socket,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<Negotiation> {
  const host = 'ip-api.com';
  const port = 80;
  const user = Buffer.from(target.username ?? '', 'utf8');
  const req = Buffer.concat([
    Buffer.from([0x04, 0x01]), // VN=4, CD=1 CONNECT
    Buffer.from([port >> 8, port & 0xff]),
    Buffer.from([0x00, 0x00, 0x00, 0x01]), // SOCKS4a：无效 IP，域名在后面
    user,
    Buffer.from([0x00]),
    Buffer.from(host, 'utf8'),
    Buffer.from([0x00]),
  ]);
  socket.write(req);

  return readBytes(socket, 8, timeoutMs).then((reply) => {
    if (!reply) {
      return { ok: false, reason: 'TIMEOUT' as CheckFailureReason, detail: 'SOCKS4 握手无响应', exitIp: null, exitCountry: null };
    }
    // 第二字节 0x5a = granted，0x5b = rejected
    const code = reply[1] ?? 0xff;
    if (code === 0x5a) {
      return { ok: true, reason: 'NONE' as CheckFailureReason, detail: null, exitIp: null, exitCountry: null };
    }
    return {
      ok: false,
      reason: (code === 0x5b ? 'PROTOCOL_ERROR' : 'AUTH_FAILED') as CheckFailureReason,
      detail: `SOCKS4 CONNECT 被拒 code=0x${code.toString(16)}`,
      exitIp: null,
      exitCountry: null,
    };
  });
}

async function socks5Handshake(
  socket: Socket,
  target: ProbeTarget,
  timeoutMs: number,
): Promise<Negotiation | null> {
  // 方法协商：有凭据时同时提供「无认证」和「用户名密码」(0x02)，
  // 由服务端选。只给 0x00 的话，带认证的代理会直接回 0xFF 拒绝全部方法。
  const hasAuth = Boolean(target.username);
  socket.write(Buffer.from(hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
  const greet = await readBytes(socket, 2, timeoutMs);
  if (!greet || greet[0] !== 0x05) {
    return { ok: false, reason: 'PROTOCOL_ERROR', detail: 'SOCKS5 握手无响应', exitIp: null, exitCountry: null };
  }
  if (greet[1] === 0xff) {
    return {
      ok: false,
      reason: 'AUTH_FAILED',
      detail: hasAuth ? 'SOCKS5 拒绝提供的认证方式' : 'SOCKS5 拒绝全部认证方式（该代理可能需要用户名密码）',
      exitIp: null,
      exitCountry: null,
    };
  }
  if (greet[1] === 0x02) {
    if (!hasAuth) {
      return { ok: false, reason: 'AUTH_FAILED', detail: '代理要求用户名密码，但该端点没有凭据', exitIp: null, exitCountry: null };
    }
    // RFC 1929：VER=0x01 | ULEN | UNAME | PLEN | PASSWD
    const u = Buffer.from(target.username!, 'utf8');
    const pw = Buffer.from(target.password ?? '', 'utf8');
    socket.write(
      Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]),
    );
    const auth = await readBytes(socket, 2, timeoutMs);
    if (!auth || auth[0] !== 0x01 || auth[1] !== 0x00) {
      return {
        ok: false,
        reason: 'AUTH_FAILED',
        detail: `SOCKS5 认证失败 status=0x${(auth?.[1] ?? 0).toString(16)}`,
        exitIp: null,
        exitCountry: null,
      };
    }
  }

  // CONNECT ip-api.com:80
  const hostBytes = Buffer.from('ip-api.com', 'utf8');
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBytes.length]),
      hostBytes,
      Buffer.from([0x00, 0x50]),
    ]),
  );
  const reply = await readBytes(socket, 10, timeoutMs);
  if (!reply || reply[0] !== 0x05 || reply[1] !== 0x00) {
    const code = reply?.[1];
    return {
      ok: false,
      reason: code === 0x02 ? 'AUTH_FAILED' : 'PROTOCOL_ERROR',
      detail: `SOCKS5 CONNECT 失败 rep=0x${(code ?? 0).toString(16)}`,
      exitIp: null,
      exitCountry: null,
    };
  }
  return null; // 成功，继续走通用 GET
}

/**
 * 读到"够了"为止。
 *
 * 判定条件由调用方给：HTTP 要等响应头和 JSON 都到齐，隧道内的 GET 只要 JSON。
 * 早期版本硬编码"包含 } 就算完"，对 CONNECT 响应永远不成立 ——
 * 于是每一次成功的 CONNECT 都要白等满超时才继续，
 * 单次探测从 100ms 变成 4s，直接把探测吞吐砍掉一个数量级。
 *
 * 两个监听器都在落定时摘掉：探针是高频调用的，泄漏的 'close' 监听
 * 会让同一个 socket 上堆积几十个回调，最终触发 MaxListenersExceededWarning。
 */
function readUntil(
  socket: Socket,
  timeoutMs: number,
  done: (raw: string) => boolean,
): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', finish);
      socket.off('error', finish);
      resolve(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    const onData = (c: Buffer): void => {
      buf += c.toString('utf8');
      if (done(buf)) finish();
    };
    socket.on('data', onData);
    socket.once('close', finish);
    socket.once('error', finish);
  });
}

function readBytes(socket: Socket, n: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const finish = (v: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) finish(buf.subarray(0, n));
    };
    const onClose = (): void => finish(buf.length >= n ? buf.subarray(0, n) : null);
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

function classifyTcpError(err: unknown): CheckFailureReason {
  const code = (err as { code?: string }).code;
  if (code === 'ETIMEOUT') return 'TCP_TIMEOUT';
  if (code === 'ECONNREFUSED') return 'TCP_REFUSED';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'TCP_TIMEOUT';
  if (code === 'ECONNRESET') return 'UNSTABLE';
  return 'TCP_TIMEOUT';
}

const errText = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

// ─────────────────────────────────────────────────────────────
// 评分：质量分不是"延迟越低越好"的单一维度
// 成功率权重最高——一个 20ms 但 60% 失败率的节点毫无价值
// ─────────────────────────────────────────────────────────────

/**
 * 质量分。
 *
 * 成功率占 70 分 —— 一个 20ms 但 60% 失败率的节点毫无价值，这条权重不该被
 * 延迟挤掉。延迟 20 分、抖动 10 分。
 *
 * 延迟分档刻意定在「300ms 满分 / 3000ms 归零」，而不是最初的
 * 「100ms 满分 / 2000ms 归零」。原因不是心软，是**区分度**：
 * 免费公开代理的 p50 实测集中在 500–900ms（跨境链路，物理下限摆在那里），
 * 按 100ms 满分算，600ms 和 1200ms 都挤在 14 分和 8 分之间，
 * 而这两者的实际体验差一倍。档位贴合真实分布，排序才有意义 ——
 * 用户从 300 个节点里挑前 20 个，靠的就是这个排序。
 *
 * 为什么不把「代理到探测目标的跨境 RTT」从延迟里剔出去：那部分确实是
 * 地理距离造成的，但免费代理的用途本来就是访问境外服务，跨境 RTT 是
 * 用户真实承担的成本，不是测量噪声。剔掉它反而会让一批"本地很快、
 * 出网很慢"的节点排到前面去。
 */
export function qualityScore(input: {
  successRate: number;
  p50Ms: number | null;
  jitterMs: number | null;
}): number {
  const ratePart = input.successRate * 70; // 70 分权重
  // 从未成功过的节点 p50 是 null，按最差档算 —— 不能当成"0ms 很快"
  const latency = input.p50Ms ?? 3000;
  const latencyPart = Math.max(0, Math.min(20, ((3000 - latency) / 2700) * 20));
  const jitter = input.jitterMs ?? 500;
  const jitterPart = Math.max(0, Math.min(10, ((400 - jitter) / 400) * 10));
  return Math.round((ratePart + latencyPart + jitterPart) * 100) / 100;
}

export { tlsConnect };
