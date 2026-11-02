import net from 'node:net';
import { createServer as createHttpServer } from 'node:http';

/**
 * 内置网关引擎。
 *
 * 为什么需要它：ADR-0004 选 gost 作为数据面引擎，但 gost 是外部二进制，
 * 没装就等于网关永远起不来 —— 那样 ProxyForge 只是一套配置管理系统，
 * 不是出口基础设施。所以这里实现一个**真的会转发**的内置引擎：
 *
 *   · 每个策略一个监听端口，同一端口同时说 HTTP 与 SOCKS5（按首字节嗅探）
 *   · 连接经上游成员（池里的端点）二次跳转 —— 这是"链式代理"，不是直连
 *   · 成员按策略选路，失败计数 + 冷却，避免反复撞死节点
 *
 * 安全边界（不靠配置，靠代码）：
 *   · 只绑回环地址，传 0.0.0.0 直接抛错
 *   · 不做透明代理，不接受非代理流量
 *   · 上游凭据只在内存在，不写日志
 */

export type UpstreamProtocol = 'HTTP' | 'HTTPS_CONNECT' | 'SOCKS4' | 'SOCKS5';

export interface Upstream {
  endpointId: string;
  host: string;
  port: number;
  protocol: UpstreamProtocol;
  username?: string;
  password?: string;
}

export interface PolicyRuntime {
  policyKey: string;
  listenPort: number;
  strategy: string;
  members: Upstream[];
}

export interface RuntimeSpec {
  instanceName: string;
  policies: PolicyRuntime[];
}

export interface PolicyStatus {
  policyKey: string;
  listenPort: number;
  members: number;
  /** 当前冷却中的成员数（连续失败后被暂时跳过） */
  cooling: number;
  accepted: number;
  rejected: number;
  activeConnections: number;
  lastError: string | null;
}

export interface EngineStatus {
  running: boolean;
  startedAt: string | null;
  policies: PolicyStatus[];
  lastError: string | null;
}

const DIAL_TIMEOUT_MS = 8000;
const FAIL_COOLDOWN_MS = 30_000;
const MAX_FAILS = 2;

interface MemberState {
  upstream: Upstream;
  fails: number;
  cooldownUntil: number;
  inFlight: number;
}

interface PolicyRuntimeState {
  policyKey: string;
  listenPort: number;
  strategy: string;
  members: MemberState[];
  cursor: number;
  server: net.Server | null;
  accepted: number;
  rejected: number;
  active: number;
  lastError: string | null;
}

function assertLoopback(host: string): void {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw new Error(`网关只允许绑定回环地址，收到 ${host}`);
  }
}

/**
 * 带持久缓冲的 socket 读取器。
 *
 * 为什么不用「读一段 → unshift 回去」：socket 处于 flowing 模式时
 * `unshift()` 推进去的字节可能被立刻重新发出，而此时监听器已经摘掉了，
 * 数据就静默丢失。表现是「上游明明回了 10 字节，我们只读到前 4 字节然后超时」。
 *
 * 所以这里自己持有缓冲区：所有读都从同一个 buf 里切，剩余部分天然保留，
 * 交接给 bridge 时再一次性还回 socket（此时先 pause，保证 unshift 安全）。
 */
class SocketReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private failure: Error | null = null;
  private ended = false;

  private readonly onData = (chunk: Buffer): void => {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.wake();
  };
  private readonly onError = (err: Error): void => {
    this.failure = err;
    this.wake();
  };
  private readonly onClose = (): void => {
    this.ended = true;
    this.wake();
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private wake(): void {
    const list = this.waiters.splice(0);
    for (const w of list) w();
  }

  /** 读到 match 返回的位置为止。match 返回 -1 表示「还不够」 */
  async readUntil(match: (buf: Buffer) => number, timeoutMs: number): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = match(this.buf);
      if (at >= 0) {
        const out = this.buf.subarray(0, at);
        this.buf = this.buf.subarray(at);
        return out;
      }
      if (this.failure) throw this.failure;
      if (this.ended) throw new Error('上游在握手完成前断开');
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error('上游握手超时');

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error('上游握手超时'));
        }, remain);
        const waiter = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(waiter);
      });
    }
  }

  /** 交接：摘掉监听、暂停流、把剩余字节还回去，之后可以安全 pipe */
  release(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    if (this.buf.length > 0) {
      // 先 pause 再 unshift：flowing 模式下 unshift 不保证被保留
      this.socket.pause();
      this.socket.unshift(this.buf);
      this.buf = Buffer.alloc(0);
    }
  }
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.on('error', () => socket.destroy());
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** 经上游建立到目标的隧道。返回的 socket 已处于「可以开始传数据」的状态 */
async function dialThrough(up: Upstream, targetHost: string, targetPort: number): Promise<net.Socket> {
  const socket = await connectTcp(up.host, up.port, DIAL_TIMEOUT_MS);
  const reader = new SocketReader(socket);

  try {
    if (up.protocol === 'SOCKS5') {
      // 问候：优先无认证，有凭据则声明用户名/密码方式
      const wantAuth = Boolean(up.username);
      socket.write(Buffer.from(wantAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
      const hello = await reader.readUntil( (b) => (b.length >= 2 ? 2 : -1), DIAL_TIMEOUT_MS);
      const method = hello[1] ?? 0xff;
      if (method === 0x02) {
        const user = Buffer.from(up.username ?? '', 'utf8');
        const pass = Buffer.from(up.password ?? '', 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const auth = await reader.readUntil( (b) => (b.length >= 2 ? 2 : -1), DIAL_TIMEOUT_MS);
        if (auth[1] !== 0x00) throw new Error('上游 SOCKS5 认证失败');
      } else if (method !== 0x00) {
        throw new Error(`上游 SOCKS5 拒绝认证方式（0x${method.toString(16)}）`);
      }

      const hostBuf = Buffer.from(targetHost, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
          hostBuf, portBuf,
        ]),
      );
      const reply = await reader.readUntil( (b) => (b.length >= 4 ? 4 : -1), DIAL_TIMEOUT_MS);
      // 应答格式是 VER(0) REP(1) RSV(2) ATYP(3) —— REP 在下标 1。
      // 请求格式才是 VER CMD RSV ATYP，两者只有前两位不同，极易写错。
      if (reply[1] !== 0x00) throw new Error(`上游 SOCKS5 连接被拒（REP=${reply[1]}）`);
      // 消费掉 BND.ADDR/BND.PORT，剩下的才是目标返回的数据。
      // 长度由 ATYP 决定，而 ATYP 就在刚才这 4 字节的第 4 位。
      const bndAtyp = reply[3];
      const bndLen = bndAtyp === 0x01 ? 6 : bndAtyp === 0x04 ? 18 : 3;
      await reader.readUntil( (b) => {
        if (b.length < 1) return -1;
        // 域名型：1 字节长度 + 域名 + 2 字节端口
        if (bndAtyp === 0x03) {
          const need = 1 + (b[0] ?? 0) + 2;
          return b.length >= need ? need : -1;
        }
        return b.length >= bndLen ? bndLen : -1;
      }, DIAL_TIMEOUT_MS);
      reader.release();
      return socket;
    }

    if (up.protocol === 'SOCKS4') {
      const ip = targetHost.match(/^\d+\.\d+\.\d+\.\d+$/);
      if (!ip) throw new Error('SOCKS4 不支持域名目标，需要 IPv4 字面量');
      const parts = targetHost.split('.').map(Number);
      const req = Buffer.alloc(9 + (up.username?.length ?? 0));
      req[0] = 0x04;
      req[1] = 0x01;
      req.writeUInt16BE(targetPort, 2);
      req[4] = parts[0]!; req[5] = parts[1]!; req[6] = parts[2]!; req[7] = parts[3]!;
      Buffer.from(up.username ?? '', 'utf8').copy(req, 8);
      socket.write(req);
      const res = await reader.readUntil( (b) => (b.length >= 8 ? 8 : -1), DIAL_TIMEOUT_MS);
      if (res[1] !== 0x5a) throw new Error(`上游 SOCKS4 连接被拒（code=${res[1]}）`);
      reader.release();
      return socket;
    }

    // HTTP / HTTPS_CONNECT：都是 CONNECT 隧道，差别只在代理本身是否 TLS，
    // 这里不支持 TLS-to-proxy（HTTPS_CONNECT 表示"该端点支持 CONNECT"）
    const authHeader = up.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${up.username}:${up.password ?? ''}`).toString('base64')}\r\n`
      : '';
    socket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`,
    );
    const head = await reader.readUntil( (b) => {
      const at = b.indexOf('\r\n\r\n');
      return at >= 0 ? at + 4 : -1;
    }, DIAL_TIMEOUT_MS);
    const statusLine = head.toString('latin1').split('\r\n')[0] ?? '';
    const code = Number(statusLine.split(' ')[1] ?? 0);
    if (code !== 200) throw new Error(`上游 HTTP CONNECT 返回 ${statusLine || '空响应'}`);
    reader.release();
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * 选一个上游成员。
 *
 * 三种策略在网关侧的差别其实很小 —— 真正的质量差异在编译期（成员集合已经筛过）。
 * 这里实现的是"可用性优先"：冷却中的成员跳过，全部冷却时才退化到全量轮询，
 * 否则一个策略的所有成员同时被标记失败就再也接不了任何连接。
 */
function pickMember(members: MemberState[]): MemberState | null {
  if (members.length === 0) return null;
  const now = Date.now();
  const healthy = members.filter((m) => m.cooldownUntil <= now);
  const pool = healthy.length > 0 ? healthy : members;
  // 负载优先：选在途连接最少的，平手时轮询
  pool.sort((a, b) => a.inFlight - b.inFlight || a.fails - b.fails);
  return pool[0] ?? null;
}

function markFail(m: MemberState): void {
  m.fails += 1;
  if (m.fails >= MAX_FAILS) {
    m.cooldownUntil = Date.now() + FAIL_COOLDOWN_MS;
    m.fails = 0;
  }
}

function markOk(m: MemberState): void {
  m.fails = 0;
  m.cooldownUntil = 0;
}

/** 把两个 socket 对接起来，任一方向断开就收掉整条连接 */
function bridge(client: net.Socket, upstream: net.Socket): void {
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = (): void => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
}

export class BuiltinEngine {
  private policies = new Map<string, PolicyRuntimeState>();
  private startedAt: string | null = null;
  private lastError: string | null = null;
  private running = false;

  status(): EngineStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      lastError: this.lastError,
      policies: [...this.policies.values()].map((p) => ({
        policyKey: p.policyKey,
        listenPort: p.listenPort,
        members: p.members.length,
        cooling: p.members.filter((m) => m.cooldownUntil > Date.now()).length,
        accepted: p.accepted,
        rejected: p.rejected,
        activeConnections: p.active,
        lastError: p.lastError,
      })),
    };
  }

  /**
   * 启动 / 热更新。
   *
   * 端口没变的策略保留原监听，只换成员集合 —— 否则每次成员漂移
   * （worker 每 15s 重算一次）都会导致现有连接被切断。
   */
  async apply(spec: RuntimeSpec, bindHost = '127.0.0.1'): Promise<void> {
    assertLoopback(bindHost);

    const seen = new Set<string>();
    for (const policy of spec.policies) {
      seen.add(policy.policyKey);
      const existing = this.policies.get(policy.policyKey);
      const members: MemberState[] = policy.members.map((u) => ({
        upstream: u, fails: 0, cooldownUntil: 0, inFlight: 0,
      }));

      if (existing && existing.listenPort === policy.listenPort) {
        existing.members = members;
        existing.strategy = policy.strategy;
        continue;
      }
      if (existing) await this.stopPolicy(policy.policyKey);

      const state: PolicyRuntimeState = {
        policyKey: policy.policyKey,
        listenPort: policy.listenPort,
        strategy: policy.strategy,
        members,
        cursor: 0,
        server: null,
        accepted: 0,
        rejected: 0,
        active: 0,
        lastError: null,
      };
      await this.startPolicy(state, bindHost);
      this.policies.set(policy.policyKey, state);
    }

    // 策略被删掉后要关掉对应端口
    for (const key of [...this.policies.keys()]) {
      if (!seen.has(key)) await this.stopPolicy(key);
    }

    this.running = true;
    this.startedAt = this.startedAt ?? new Date().toISOString();
  }

  private startPolicy(state: PolicyRuntimeState, bindHost: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ pauseOnConnect: true }, (socket) => {
        socket.once('data', (first: Buffer) => {
          // 把首字节还回流里再重新开始，否则握手处理器永远等不到数据。
          // pauseOnConnect + unshift 的组合里，pause 之后必须显式 resume ——
          // 少了这一步的表现是"连接建立了但一直超时"，非常难猜。
          socket.pause();
          socket.unshift(first);
          state.active += 1;
          const done = (): void => {
            state.active = Math.max(0, state.active - 1);
          };
          socket.on('close', done);
          if (first[0] === 0x05) {
            void this.handleSocks5(state, socket);
          } else {
            void this.handleHttp(state, socket);
          }
          socket.resume();
        });
        socket.resume();
      });

      server.once('error', (err: NodeJS.ErrnoException) => {
        const msg = err.code === 'EADDRINUSE'
          ? `端口 ${state.listenPort} 已被占用`
          : err.message;
        state.lastError = msg;
        this.lastError = `[${state.policyKey}] ${msg}`;
        reject(new Error(msg));
      });

      server.listen(state.listenPort, bindHost, () => {
        server.removeAllListeners('error');
        server.on('error', (err) => {
          state.lastError = err.message;
        });
        state.server = server;
        resolve();
      });
    });
  }

  private stopPolicy(key: string): Promise<void> {
    const state = this.policies.get(key);
    if (!state) return Promise.resolve();
    this.policies.delete(key);
    const server = state.server;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      server.close(() => resolve());
      // 已经建立的连接不强制断开，但要停止接受新连接
    });
  }

  async stop(): Promise<void> {
    for (const key of [...this.policies.keys()]) await this.stopPolicy(key);
    this.running = false;
    this.startedAt = null;
  }

  /** 记一次转发失败，并把结果反馈到成员健康度 */
  private fail(state: PolicyRuntimeState, member: MemberState | null, message: string): void {
    state.rejected += 1;
    state.lastError = message;
    if (member) markFail(member);
  }

  private async handleSocks5(state: PolicyRuntimeState, client: net.Socket): Promise<void> {
    let member: MemberState | null = null;
    const clientReader = new SocketReader(client);
    try {
      const greeting = await clientReader.readUntil( (b) => (b.length >= 2 ? 2 : -1), DIAL_TIMEOUT_MS);
      const nMethods = greeting[1] ?? 0;
      const methods = await clientReader.readUntil( (b) => (b.length >= nMethods ? nMethods : -1), DIAL_TIMEOUT_MS);
      // 只接受「无认证」：网关绑在回环地址上，鉴权由操作系统边界负责。
      // 如果将来要对外监听，这里必须先加用户名/密码校验。
      if (!methods.includes(0x00)) {
        client.end(Buffer.from([0x05, 0xff]));
        return;
      }
      client.write(Buffer.from([0x05, 0x00]));

      const reqHead = await clientReader.readUntil( (b) => (b.length >= 4 ? 4 : -1), DIAL_TIMEOUT_MS);
      const atyp = reqHead[3] ?? 0;
      let host = '';
      let port = 0;
      if (atyp === 0x01) {
        const rest = await clientReader.readUntil( (b) => (b.length >= 6 ? 6 : -1), DIAL_TIMEOUT_MS);
        host = [...rest.subarray(0, 4)].join('.');
        port = rest.readUInt16BE(4);
      } else if (atyp === 0x03) {
        const lenBuf = await clientReader.readUntil( (b) => (b.length >= 1 ? 1 : -1), DIAL_TIMEOUT_MS);
        const nameLen = lenBuf[0] ?? 0;
        const rest = await clientReader.readUntil( (b) => (b.length >= nameLen + 2 ? nameLen + 2 : -1), DIAL_TIMEOUT_MS);
        host = rest.subarray(0, nameLen).toString('utf8');
        port = rest.readUInt16BE(nameLen);
      } else {
        client.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }

      member = pickMember(state.members);
      if (!member) throw new Error('策略没有可用成员');

      member.inFlight += 1;
      const upstream = await dialThrough(member.upstream, host, port);
      markOk(member);
      state.accepted += 1;

      // 回一个成功响应（BND 用 0.0.0.0:0，客户端不关心真实绑定地址）
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      clientReader.release();
      bridge(client, upstream);
      client.on('close', () => { member!.inFlight = Math.max(0, member!.inFlight - 1); });
    } catch (err) {
      this.fail(state, member, err instanceof Error ? err.message : String(err));
      if (member) member.inFlight = Math.max(0, member.inFlight - 1);
      client.destroy();
    }
  }

  private async handleHttp(state: PolicyRuntimeState, client: net.Socket): Promise<void> {
    let member: MemberState | null = null;
    const clientReader = new SocketReader(client);
    try {
      const head = await clientReader.readUntil( (b) => {
        const at = b.indexOf('\r\n\r\n');
        return at >= 0 ? at + 4 : -1;
      }, DIAL_TIMEOUT_MS);

      const text = head.toString('latin1');
      const firstLine = text.split('\r\n')[0] ?? '';
      const [method, target] = firstLine.split(' ');
      if (!method || !target) throw new Error('HTTP 请求行无法解析');

      let host: string;
      let port: number;
      let isConnect = false;

      if (method.toUpperCase() === 'CONNECT') {
        isConnect = true;
        const [h, p] = target.split(':');
        host = h ?? '';
        port = Number(p ?? 443);
      } else {
        const u = new URL(target);
        host = u.hostname;
        port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      }
      if (!host || !Number.isFinite(port)) throw new Error(`目标地址无法解析：${target}`);

      member = pickMember(state.members);
      if (!member) throw new Error('策略没有可用成员');

      member.inFlight += 1;
      const upstream = await dialThrough(member.upstream, host, port);
      markOk(member);
      state.accepted += 1;

      if (isConnect) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        clientReader.release();
        bridge(client, upstream);
      } else {
        // 普通 HTTP 请求：隧道已建立到目标，把请求行从 absolute-form
        // 改写成 origin-form 再发出去，否则源站看不懂
        const u = new URL(target);
        const rewritten = text.replace(firstLine, `${method} ${u.pathname}${u.search} HTTP/1.1`);
        upstream.write(Buffer.from(rewritten, 'latin1'));
        clientReader.release();
        bridge(client, upstream);
      }
      client.on('close', () => { member!.inFlight = Math.max(0, member!.inFlight - 1); });
    } catch (err) {
      this.fail(state, member, err instanceof Error ? err.message : String(err));
      if (member) member.inFlight = Math.max(0, member.inFlight - 1);
      if (!client.destroyed) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    }
  }
}

/** 探测端口是否可监听（启动前预检，避免"配置成功但进程起不来"） */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createHttpServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}
