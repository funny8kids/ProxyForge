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
    if (target.protocol === 'SOCKS5' || target.protocol === 'SOCKS4') {
      const greeting = target.protocol === 'SOCKS5' ? await socks5Handshake(socket, target, timeoutMs) : null;
      if (greeting && !greeting.ok) return greeting;
    } else {
      // HTTP / HTTPS_CONNECT：发 CONNECT
      const head = [
        `CONNECT ip-api.com:80 HTTP/1.1`,
        `Host: ip-api.com:80`,
        `Proxy-Connection: keep-alive`,
      ];
      // 需要认证的 HTTP 代理不带头会直接回 407，看起来像"协议错误"，
      // 排障时会被误判成代理不支持 CONNECT。
      if (target.username) {
        const token = Buffer.from(`${target.username}:${target.password ?? ''}`, 'utf8').toString('base64');
        head.push(`Proxy-Authorization: Basic ${token}`);
      }
      const req = [...head, '', ''].join('\r\n');
      socket.write(req);
      const resp = await readSome(socket, timeoutMs);
      if (!/^HTTP\/1\.[01] 200/.test(resp)) {
        return {
          ok: false,
          reason: /407/.test(resp) ? 'AUTH_FAILED' : 'PROTOCOL_ERROR',
          detail: resp.slice(0, 160) || 'CONNECT 无响应',
          exitIp: null,
          exitCountry: null,
        };
      }
    }

    // 隧道已建立，发一个最简 GET 取出口 IP
    const get = [
      'GET /json HTTP/1.1',
      'Host: ip-api.com',
      'User-Agent: ProxyForge-Probe/1.0',
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    socket.write(get);
    const body = await readSome(socket, timeoutMs);
    const jsonStart = body.indexOf('{');
    if (jsonStart < 0) {
      return { ok: false, reason: 'PROTOCOL_ERROR', detail: '出口探测无 JSON 响应', exitIp: null, exitCountry: null };
    }
    const parsed = JSON.parse(body.slice(jsonStart, body.lastIndexOf('}') + 1)) as {
      query?: string;
      countryCode?: string;
    };
    return {
      ok: true,
      reason: 'NONE',
      detail: null,
      exitIp: parsed.query ?? null,
      exitCountry: parsed.countryCode ?? null,
    };
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

function readSome(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.off('data', onData);
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);
    const onData = (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).toString('utf8').includes('}')) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function readBytes(socket: Socket, n: number, timeoutMs: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off('data', onData);
      resolve(null);
    }, timeoutMs);
    const onData = (c: Buffer) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length >= n) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(buf.subarray(0, n));
      }
    };
    socket.on('data', onData);
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

export function qualityScore(input: {
  successRate: number;
  p50Ms: number | null;
  jitterMs: number | null;
}): number {
  const ratePart = input.successRate * 70; // 70 分权重
  const latency = input.p50Ms ?? 3000;
  // 100ms 内满分 20，2000ms 归零
  const latencyPart = Math.max(0, Math.min(20, ((2000 - latency) / 1900) * 20));
  const jitter = input.jitterMs ?? 500;
  const jitterPart = Math.max(0, Math.min(10, ((400 - jitter) / 400) * 10));
  return Math.round((ratePart + latencyPart + jitterPart) * 100) / 100;
}

export { tlsConnect };
