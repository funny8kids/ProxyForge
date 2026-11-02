/**
 * 内置网关引擎的功能验证。
 *
 * 不依赖任何公网代理：自己起一个最小 SOCKS5 上游（握手后回显），
 * 让 BuiltinEngine 通过它转发，再从客户端侧验证三种路径：
 *   1. SOCKS5 入站 → SOCKS5 上游
 *   2. HTTP CONNECT 入站 → SOCKS5 上游
 *   3. 普通 HTTP 请求入站（absolute-form 改写）→ SOCKS5 上游
 */
import net from 'node:net';
import { BuiltinEngine } from '../apps/api/src/modules/gateway/engine.ts';

const UPSTREAM_PORT = 19001;
const LISTEN_PORT = 19002;

// ── 最小 SOCKS5 上游：握手 → 回 200 → 把收到的字节原样回显 ──
function startUpstream() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let stage = 0;
      let acc = Buffer.alloc(0);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        if (stage === 2) {
          socket.write(Buffer.concat([Buffer.from('ECHO:'), chunk]));
          return;
        }
        acc = Buffer.concat([acc, chunk]);
        if (stage === 0 && acc.length >= 2) {
          const n = acc[1];
          if (acc.length < 2 + n) return;
          acc = acc.subarray(2 + n);
          stage = 1;
          socket.write(Buffer.from([0x05, 0x00]));
        }
        if (stage === 1 && acc.length >= 5) {
          const atyp = acc[3];
          let need = 0;
          if (atyp === 0x01) need = 10;
          else if (atyp === 0x03) need = 7 + acc[4];
          else need = 22;
          if (acc.length < need) return;
          acc = acc.subarray(need);
          stage = 2;
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (acc.length > 0) {
            socket.write(Buffer.concat([Buffer.from('ECHO:'), acc]));
            acc = Buffer.alloc(0);
          }
        }
      });
    });
    server.listen(UPSTREAM_PORT, '127.0.0.1', () => resolve(server));
  });
}

function readN(socket, n, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('读超时')), timeoutMs);
    const onData = (c) => {
      acc = Buffer.concat([acc, c]);
      if (acc.length >= n) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve(acc.subarray(0, n));
      }
    };
    socket.on('data', onData);
  });
}

function socks5Client(port, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', reject);
    s.on('connect', async () => {
      try {
        s.write(Buffer.from([0x05, 0x01, 0x00]));
        const hello = await readN(s, 2);
        if (hello[1] !== 0x00) throw new Error('上游不接受无认证');
        const h = Buffer.from(targetHost, 'utf8');
        const p = Buffer.alloc(2);
        p.writeUInt16BE(targetPort, 0);
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, p]));
        const rep = await readN(s, 10);
        // 应答是 VER(0) REP(1) RSV(2) ATYP(3)
        if (rep[1] !== 0x00) throw new Error(`CONNECT 被拒 code=${rep[1]}`);
        resolve(s);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function httpConnectClient(port, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.on('error', reject);
    s.on('connect', () => {
      s.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
      let acc = '';
      const onData = (c) => {
        acc += c.toString('latin1');
        if (acc.includes('\r\n\r\n')) {
          s.off('data', onData);
          if (/^HTTP\/1\.[01] 200/.test(acc)) resolve(s);
          else reject(new Error(`CONNECT 失败: ${acc.split('\r\n')[0]}`));
        }
      };
      s.on('data', onData);
    });
  });
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const upstream = await startUpstream();
const engine = new BuiltinEngine();

await engine.apply({
  instanceName: 'selftest',
  policies: [{
    policyKey: 'SELFTEST',
    listenPort: LISTEN_PORT,
    strategy: 'FASTEST',
    members: [{ endpointId: 'e1', host: '127.0.0.1', port: UPSTREAM_PORT, protocol: 'SOCKS5' }],
  }],
});

// 1. SOCKS5 入站
try {
  const c = await socks5Client(LISTEN_PORT, 'example.test', 443);
  c.write(Buffer.from('ping'));
  const echo = await readN(c, 9);
  check('SOCKS5 入站 → 上游转发', echo.toString() === 'ECHO:ping', echo.toString());
  c.destroy();
} catch (err) {
  check('SOCKS5 入站 → 上游转发', false, err.message);
}

// 2. HTTP CONNECT 入站
try {
  const c = await httpConnectClient(LISTEN_PORT, 'example.test', 443);
  c.write(Buffer.from('abc'));
  const echo = await readN(c, 8);
  check('HTTP CONNECT 入站 → 上游转发', echo.toString() === 'ECHO:abc', echo.toString());
  c.destroy();
} catch (err) {
  check('HTTP CONNECT 入站 → 上游转发', false, err.message);
}

// 3. 普通 HTTP 请求（absolute-form 改写）
try {
  const s = net.connect({ host: '127.0.0.1', port: LISTEN_PORT });
  await new Promise((r) => s.on('connect', r));
  s.write('GET http://example.test/path?q=1 HTTP/1.1\r\nHost: example.test\r\n\r\n');
  // 回显只有 8 字节左右，不能按固定长度读
  const text = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('读超时')), 4000);
    s.once('data', (c) => {
      clearTimeout(timer);
      resolve(c.toString('latin1'));
    });
  });
  check('普通 HTTP 请求改写为 origin-form', text.includes('GET /path?q=1 HTTP/1.1'), text.split('\r\n')[0] ?? '');
  s.destroy();
} catch (err) {
  check('普通 HTTP 请求改写为 origin-form', false, err.message);
}

// 4. 成员不可用时返回 502 而不是挂死
try {
  await engine.apply({
    instanceName: 'selftest',
    policies: [{
      policyKey: 'SELFTEST',
      listenPort: LISTEN_PORT,
      strategy: 'FASTEST',
      members: [{ endpointId: 'dead', host: '127.0.0.1', port: 19099, protocol: 'SOCKS5' }],
    }],
  });
  const s = net.connect({ host: '127.0.0.1', port: LISTEN_PORT });
  await new Promise((r) => s.on('connect', r));
  s.write('CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n');
  const buf = await readN(s, 39, 15000);
  check('上游不可用时返回 502', buf.toString('latin1').includes('502'), buf.toString('latin1').split('\r\n')[0] ?? '');
  s.destroy();
} catch (err) {
  check('上游不可用时返回 502', false, err.message);
}

await engine.stop();
upstream.close();

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
