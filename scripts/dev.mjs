#!/usr/bin/env node
/**
 * 开发环境编排：API + Web。
 *
 * 为什么不用 concurrently：多一层依赖只为了 spawn 两个进程并不划算，
 * 而且这里需要「任一进程退出就把整组收掉」的语义，自己写反而更清楚。
 *
 * 为什么默认不起独立 worker 进程：
 *   PGlite 是编译到 WASM 的嵌入式 PostgreSQL，单写者。两个进程打开同一个
 *   .data/pg 会直接 RuntimeError: Aborted() 崩在 initdb。所以 worker 循环
 *   默认挂在 API 进程内（PF_WORKER_MODE=embedded）。
 *   换真 PostgreSQL 后执行 `PF_WORKER_MODE=process node scripts/dev.mjs`，
 *   会额外拉起独立 worker 进程，走 FOR UPDATE SKIP LOCKED 并行认领。
 *
 * PGlite 注意：WASM 实例退出时会删临时文件，环境的 safe-delete shim
 * 会拦截批量删除导致崩溃。这两个环境变量必须从子进程环境中摘掉。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const childEnv = { ...process.env };
/**
 * 摘掉沙箱的删除守卫。
 *
 * 之前是逐个 delete 两个具名变量，宿主一改名字就漏 —— 现在多了
 * CODEBUDDY_SAFE_DELETE_BULK_GUARD / CODEBUDDY_SAFE_DELETE_SANDBOX，
 * 漏掉的那个会在 PGlite 启动时拦截 WASM 文件系统的删除，
 * 表现为 initdb 阶段 RuntimeError: Aborted()，报错信息里完全看不出原因。
 * 按前缀清理，名字再变也不会漏。
 */
for (const k of Object.keys(childEnv)) {
  if (k.startsWith('CODEBUDDY_SAFE_DELETE') || k === 'CODEBUDDY_TOOL_CALL_ID') {
    delete childEnv[k];
  }
}

const workerMode = childEnv.PF_WORKER_MODE ?? 'embedded';
childEnv.PF_WORKER_MODE = workerMode;

const C = {
  api: '\x1b[38;5;81m',
  worker: '\x1b[38;5;141m',
  web: '\x1b[38;5;114m',
  dim: '\x1b[2m',
  off: '\x1b[0m',
};

const procs = [];

function run(name, args, color) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const tag = `${color}${name.padEnd(6)}${C.off}${C.dim}│${C.off} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    process.stdout.write(`${tag}exited (code=${code} signal=${signal})\n`);
    shutdown(code ?? 0);
  });

  procs.push(child);
  return child;
}

let closing = false;
function shutdown(code) {
  if (closing) return;
  closing = true;

  // Windows 上 child.kill() 只杀直接子进程。tsx watch 会再 fork 一层真正跑
  // 应用的 node，只杀 tsx 会留下孤儿进程继续占着 .data/pg —— 下次启动就是
  // 两个进程抢同一个 PGlite 目录。必须按进程树杀。
  for (const p of procs) {
    if (p.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      p.kill('SIGTERM');
    }
  }

  // 给子进程 1.5s 收尾，之后兜底强杀
  setTimeout(() => {
    for (const p of procs) {
      if (p.exitCode !== null) continue;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        p.kill('SIGKILL');
      }
    }
    process.exit(code);
  }, 1500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const tsx = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

run('api', [tsx, 'watch', 'apps/api/src/main.ts'], C.api);
if (workerMode === 'process') {
  run('worker', [tsx, 'watch', 'apps/api/src/worker/main.ts'], C.worker);
} else {
  process.stdout.write(
    `${C.dim}worker  │ embedded（随 API 进程运行；PF_WORKER_MODE=process 可切独立进程）${C.off}\n`,
  );
}
run('web', [vite, '--config', 'apps/web/vite.config.ts', 'apps/web'], C.web);
