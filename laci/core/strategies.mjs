/**
 * LACI 新调度中心 · M2 · 策略注册表（strategies.mjs）
 *
 * 这里只做三件事，每件事都是一个**可注册的策略点**（主文档 §14.2）：
 *
 *   launchers  怎么起   spawn（现在唯一实现）        ← 以后 pty / attach 只注册新函数
 *   probers    怎么判活 http（现在唯一实现）          ← 以后 script
 *   stoppers   怎么停   kill-tree（现在唯一实现）     ← 以后 signal / http-unload
 *
 * 调用方永远拿注册表分派，**不写 `if (mode === 'package')` 这种链**：
 *
 *   const launch = launchers.get('spawn')
 *
 * 约定（runtime.mjs 依赖这些形状，改之前先改文档）：
 *
 *   launcher(ctx) → { child?, pid?, program?, args?, spawn? }
 *     ctx = { engine, plan, instance, instanceId, extraEnv }
 *
 *   prober(ctx)   → { ok, status?, models?, json?, error?, elapsedMs, aborted? }
 *     ctx = { url, timeoutMs, signal, engine, instanceId }   // 一次探测，循环/超时由 runtime 负责
 *
 *   stopper(ctx)  → { stopped, forced, code?, note? }
 *     ctx = { pid, child, graceMs, port, host, engine, instanceId, force }
 *
 * 本文件不 import runtime.mjs（避免循环依赖），只依赖 node: 内置模块。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/* ==========================================================================
 * 错误
 * ========================================================================== */

export class StrategyError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'StrategyError';
    this.kind = options.kind ?? null;
    this.key = options.key ?? null;
  }
}

/** 策略没注册：把「已注册的」列出来，别只甩一句 undefined */
export class StrategyNotRegisteredError extends StrategyError {
  constructor(kind, key, available) {
    super(`没有注册「${kind}」策略：${key}（已注册：${available || '空'}）`, { kind, key });
    this.name = 'StrategyNotRegisteredError';
    this.available = available;
  }
}

/** 起不来的进程：ENOENT / EACCES 这类，带上到底想执行什么 */
export class LaunchError extends StrategyError {
  constructor(message, options = {}) {
    super(message, { ...options, kind: 'launcher' });
    this.name = 'LaunchError';
    this.program = options.program ?? null;
    this.code = options.code ?? null;
  }
}

/* ==========================================================================
 * 注册表
 * ========================================================================== */

/**
 * 一个策略点 = 一张 key → 函数 的表。
 * 只允许新增 key，不允许在调用方写 if 链——这是这一层存在的全部理由。
 */
export class StrategyRegistry {
  constructor(kind) {
    this.kind = kind;
    this._items = new Map();
  }

  /** 注册；返回被注册的函数，方便 `export const x = reg.register(...)` */
  register(key, fn, meta = {}) {
    if (typeof key !== 'string' || key.trim() === '') {
      throw new StrategyError(`${this.kind} 注册需要一个非空字符串 key`, { kind: this.kind });
    }
    if (typeof fn !== 'function') {
      throw new StrategyError(`${this.kind} 策略「${key}」必须是函数，收到 ${typeof fn}`, {
        kind: this.kind,
        key,
      });
    }
    this._items.set(key, { kind: this.kind, key, fn, registeredAt: Date.now(), ...meta });
    return fn;
  }

  unregister(key) {
    return this._items.delete(key);
  }

  has(key) {
    return this._items.has(key);
  }

  /** 软查：拿不到返回 null（调用方要自己决定怎么降级） */
  tryGet(key) {
    return this._items.get(key)?.fn ?? null;
  }

  /** 硬查：拿不到直接抛，并列出可用 key —— 配置写错时错误信息要能自己解释 */
  get(key) {
    const hit = this._items.get(key);
    if (!hit) throw new StrategyNotRegisteredError(this.kind, key, this.keys().join(' / '));
    return hit.fn;
  }

  describe(key) {
    const hit = this._items.get(key);
    if (!hit) return null;
    const { fn, ...meta } = hit;
    return meta;
  }

  keys() {
    return [...this._items.keys()];
  }

  list() {
    return [...this._items.values()].map(({ fn, ...meta }) => meta);
  }

  get size() {
    return this._items.size;
  }
}

/* ==========================================================================
 * 策略点 1：launcher —— 怎么起
 * ========================================================================== */

/**
 * 把「引擎定义 + 命令行计划」翻译成真正要 spawn 的程序和参数。
 *
 * 为什么需要这层：Windows 上 .bat 不能直接 spawn（Node 会当二进制执行），
 * 必须经过 cmd.exe；.py / .ps1 要各自的解释器。这些是**启动方式**的细节，
 * 不该漏进 runtime 的状态机里。
 *
 * @returns {{ command: string, args: string[], windowsVerbatimArguments?: boolean, kind: string }}
 */
export function planSpawn(engine, plan) {
  const file = String(plan?.program ?? '');
  if (!file) throw new LaunchError('没有可执行的启动文件（engine.file 为空）', { program: null });

  const kind = normalizeKind(engine?.kind, file);
  const args = Array.isArray(plan?.args) ? plan.args.map((a) => String(a)) : [];

  if (process.platform === 'win32') {
    if (kind === 'bat') {
      // 整合包的 .bat 是主路径：必须过 cmd。用 /d /s /c + 整串加引号，
      // 这样带空格的路径和参数不会被 cmd 重新拆开。
      const comspec = process.env.ComSpec || 'cmd.exe';
      const line = [file, ...args].map(quoteCmdArg).join(' ');
      return {
        command: comspec,
        args: ['/d', '/s', '/c', `"${line}"`],
        windowsVerbatimArguments: true,
        kind,
      };
    }
    if (kind === 'ps1') {
      return {
        command: 'powershell.exe',
        args: [
          '-NoLogo',
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          file,
          ...args,
        ],
        kind,
      };
    }
  }

  if (kind === 'py') {
    // 每个引擎可以自带 venv（主文档 §5.2），所以解释器优先用引擎自己的
    const interpreter = engine?.interpreter || 'python';
    return { command: interpreter, args: [file, ...args], kind };
  }

  if (kind === 'sh') {
    return { command: 'sh', args: [file, ...args], kind };
  }

  // exe / 其它原生程序：原样执行
  return { command: file, args, kind };
}

/**
 * spawn 启动器（现在唯一实现）。
 * 关键点：等 'spawn' 事件再 resolve——spawn 的失败（ENOENT）是异步 'error' 事件，
 * 提前返回会让调用方拿着一个根本没起来的 pid 去判活。
 */
export async function spawnLauncher(ctx) {
  const { engine, plan, extraEnv } = ctx ?? {};
  const resolved = planSpawn(engine, plan);
  const env = { ...process.env, ...(plan?.env ?? {}), ...(extraEnv ?? {}) };
  const cwd = plan?.cwd || engine?.cwd || undefined;

  const child = await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(resolved.command, resolved.args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: resolved.windowsVerbatimArguments === true,
      });
    } catch (err) {
      reject(
        new LaunchError(`起不来：${err.message}（程序：${resolved.command}）`, {
          cause: err,
          program: resolved.command,
          code: err?.code,
        }),
      );
      return;
    }

    let settled = false;
    const cleanup = () => {
      proc.removeListener('spawn', onSpawn);
      proc.removeListener('error', onError);
    };
    const onSpawn = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(proc);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new LaunchError(`起不来：${err.message}（程序：${resolved.command}）`, {
          cause: err,
          program: resolved.command,
          code: err?.code,
        }),
      );
    };
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });

  return {
    child,
    pid: child.pid ?? null,
    program: plan?.program ?? resolved.command,
    args: plan?.args ?? [],
    spawn: resolved,
  };
}

/* ==========================================================================
 * 策略点 2：prober —— 怎么判活
 * ========================================================================== */

/**
 * 一次 GET /v1/models 探测。**只探一次**：循环、间隔、总超时归 runtime 管。
 * 这样「启动时每 900ms 探一次」和「对账时 2 秒探一次」可以复用同一个函数。
 */
export async function httpProber(ctx) {
  const { url, timeoutMs = 2000, signal } = ctx ?? {};
  const startedAt = Date.now();
  const result = {
    ok: false,
    url,
    status: null,
    models: null,
    json: null,
    error: null,
    aborted: false,
    elapsedMs: 0,
  };

  if (!url) {
    result.error = new Error('没有判活地址（engine.ready.url 为空）');
    return result;
  }

  try {
    const res = await httpGetJson(url, { timeoutMs, signal });
    result.status = res.status;
    result.json = res.json;
    result.models = extractModelIds(res.json);
    if (res.status >= 200 && res.status < 300) {
      // 200 + JSON 才算活：返回 HTML 的多半是自带网页（Strata 的 / 就是），不能当 API 就绪
      if (res.json === null) {
        result.error = new Error(`判活地址返回的不是 JSON（HTTP ${res.status}）`);
      } else {
        result.ok = true;
      }
    } else {
      result.error = new Error(`判活地址返回 HTTP ${res.status}`);
    }
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      result.aborted = true;
    }
    result.error = err instanceof Error ? err : new Error(String(err));
  }

  result.elapsedMs = Date.now() - startedAt;
  return result;
}

/** 从 /v1/models 里取模型 id；兼容 {data:[…]} 和 {models:[…]} 两种写法 */
export function extractModelIds(json) {
  if (!json || typeof json !== 'object') return null;
  const arr = Array.isArray(json.data)
    ? json.data
    : Array.isArray(json.models)
      ? json.models
      : Array.isArray(json.data?.models)
        ? json.data.models
        : null;
  if (!arr) return null;
  return arr
    .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name ?? null)))
    .filter((id) => typeof id === 'string' && id !== '');
}

/** 最小 GET JSON 客户端：超时销毁请求、大小封顶、支持 AbortSignal */
export function httpGetJson(url, { timeoutMs = 2000, signal, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    let req;
    try {
      req = http.get(
        url,
        { signal, headers: { accept: 'application/json', 'user-agent': 'laci-runtime/0.2' } },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              req.destroy(new Error(`判活响应超过 ${maxBytes} 字节`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('error', (err) => finish(reject, err));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {
              json = null; // 不是 JSON 不抛，交给调用方判断（HTML 页面是常见情况）
            }
            finish(resolve, { status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        },
      );
      // 单次探测的超时用 req.setTimeout，超时就销毁——不销毁会一直占着 socket
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`判活超时（${timeoutMs}ms）`));
      });
      req.on('error', (err) => finish(reject, err));
    } catch (err) {
      finish(reject, err);
    }
  });
}

/* ==========================================================================
 * 策略点 3：stopper —— 怎么停
 * ========================================================================== */

/**
 * kill-tree：先请整棵树退出，宽限期没走就强杀整棵树。
 *
 * 为什么 Windows 上还要 /F：控制台引擎（ninfer 这类）不吃 WM_CLOSE，
 * 不带 /F 的 taskkill 基本立刻返回失败；所以「先礼」失败就不空等 graceMs，
 * 直接上 /F，避免每次关闭都干等 5 秒。
 */
export async function killTreeStopper(ctx) {
  const { pid, child = null, graceMs = 5000 } = ctx ?? {};
  const numericPid = Number(pid);

  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { stopped: true, forced: false, note: '没有 pid，视为已停' };
  }
  if (!isPidAlive(numericPid) && !isChildRunning(child)) {
    return { stopped: true, forced: false, note: '进程已经不在' };
  }

  // ① 先礼：请求整棵树退出（Windows 用 /T 遍历子进程，避免引擎的 wrapper 留下孙进程）
  let grace = null;
  if (process.platform === 'win32') {
    grace = await runQuiet('taskkill', ['/PID', String(numericPid), '/T']);
  } else {
    grace = signalProcessTree(numericPid, 'SIGTERM', child);
  }

  if (grace?.ok && graceMs > 0) {
    const gone = await waitPidGone(numericPid, graceMs, child);
    if (gone) return { stopped: true, forced: false, note: '已退出' };
  }

  // ② 后兵：强杀整棵树
  const forced = process.platform === 'win32'
    ? await runQuiet('taskkill', ['/PID', String(numericPid), '/T', '/F'])
    : signalProcessTree(numericPid, 'SIGKILL', child);

  const gone = await waitPidGone(numericPid, 5000, child);
  return {
    stopped: gone,
    forced: true,
    ok: forced?.ok ?? false,
    note: gone ? '已强制结束进程树' : '进程仍在（可能权限不足，或被别的会话持有）',
  };
}

/**
 * signal：只对主进程发信号，**不遍历子进程树**。
 * M1 的 stop.method 允许 `signal`，所以这里补上——不然用户存了 signal 却停不掉。
 * 默认仍是 kill-tree：Windows 上 SIGTERM 实际就是 TerminateProcess，孙进程会留下。
 */
export async function signalStopper(ctx) {
  const { pid, child = null, graceMs = 5000 } = ctx ?? {};
  const numericPid = Number(pid);

  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return { stopped: true, forced: false, note: '没有 pid，视为已停' };
  }
  if (!isPidAlive(numericPid) && !isChildRunning(child)) {
    return { stopped: true, forced: false, note: '进程已经不在' };
  }

  const polite = signalProcessTree(numericPid, 'SIGTERM', child);
  if (polite.ok && graceMs > 0 && (await waitPidGone(numericPid, graceMs, child))) {
    return { stopped: true, forced: false, note: '已退出（SIGTERM）' };
  }

  const forced = signalProcessTree(numericPid, 'SIGKILL', child);
  const gone = await waitPidGone(numericPid, 5000, child);
  return {
    stopped: gone,
    forced: true,
    ok: forced?.ok ?? false,
    note: gone ? '已强制结束（SIGKILL）' : '进程仍在（可能权限不足）',
  };
}

/* ==========================================================================
 * 公共小工具（runtime / M3 / M6 都会用）
 * ========================================================================== */

/** pid 还活着吗。EPERM 表示存在但没权限 → 算活着 */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/** 我们自己持有的 child 是否还在跑（pid 检查在 Windows 上偶尔会有回收延迟，双保险） */
export function isChildRunning(child) {
  if (!child) return false;
  return child.exitCode === null && child.signalCode === null;
}

/** 端口现在能连上吗（连上=true；拒绝/超时=false） */
export function isPortOpen(port, { host = '127.0.0.1', timeoutMs = 500 } = {}) {
  const n = Number(port);
  if (!Number.isInteger(n) || n <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ port: n, host });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/** 等端口释放。停实例后用它确认「端口真的释放」（M2 验收） */
export async function waitForPortClosed(port, { host = '127.0.0.1', timeoutMs = 5000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port, { host }))) return true;
    await delay(intervalMs);
  }
  return !(await isPortOpen(port, { host }));
}

/** 等 pid 消失；child 退出也算 */
export async function waitPidGone(pid, timeoutMs = 5000, child = null) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (!isChildRunning(child) && !isPidAlive(pid)) return true;
    if (!isPidAlive(pid)) return true;
    await delay(100);
  }
  return !isPidAlive(pid);
}

/* ==========================================================================
 * 内部工具
 * ========================================================================== */

/** kind 归一：引擎写的和文件后缀哪个先到用哪个，都认不出来就当原生 exe */
export function normalizeKind(kind, file) {
  const k = String(kind ?? '').toLowerCase();
  if (k === 'bat' || k === 'cmd') return 'bat';
  if (k === 'py' || k === 'python') return 'py';
  if (k === 'ps1' || k === 'powershell') return 'ps1';
  if (k === 'sh') return 'sh';
  if (k === 'exe') return 'exe';

  const ext = path.extname(String(file ?? '')).toLowerCase();
  const byExt = { '.bat': 'bat', '.cmd': 'bat', '.py': 'py', '.ps1': 'ps1', '.sh': 'sh', '.exe': 'exe' };
  return byExt[ext] ?? 'exe';
}

/** cmd 参数加引号：cmd 没有反斜杠转义，含空格/特殊符号才加引号 */
export function quoteCmdArg(value) {
  const s = String(value ?? '');
  if (s === '') return '""';
  if (!/[\s"&|<>^()]/.test(s)) return s;
  return `"${s}"`;
}

function signalProcessTree(pid, signal, child) {
  try {
    if (child && isChildRunning(child)) {
      child.kill(signal);
      return { ok: true };
    }
    // 负 pid = 进程组（detached 启动时才有）；先试组，失败再试单进程
    try {
      process.kill(-pid, signal);
      return { ok: true };
    } catch {
      process.kill(pid, signal);
      return { ok: true };
    }
  } catch (err) {
    return { ok: false, error: err };
  }
}

function runQuiet(command, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err, code: null });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略：杀不掉也只能这样 */
      }
      resolve({ ok: false, error: new Error(`${command} 超时`), code: null });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err, code: null });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

/* ==========================================================================
 * 默认注册表
 * ========================================================================== */

/** 造一套全新的默认注册表（测试用；也方便将来做多套配置） */
export function createDefaultRegistries() {
  const launchers = new StrategyRegistry('launcher');
  launchers.register('spawn', spawnLauncher, {
    description: 'child_process.spawn（.bat 走 cmd，.py/.ps1 走各自解释器）',
  });

  const probers = new StrategyRegistry('prober');
  probers.register('http', httpProber, { description: 'GET /v1/models，2xx + JSON 判活' });

  const stoppers = new StrategyRegistry('stopper');
  stoppers.register('kill-tree', killTreeStopper, {
    description: '先请整棵树退出，宽限期后 taskkill /T /F 强杀',
  });
  stoppers.register('signal', signalStopper, {
    description: '只发信号给主进程（SIGTERM→SIGKILL），不遍历子进程树',
  });

  return { launchers, probers, stoppers };
}

/**
 * 模块级单例：`import { launchers } from './strategies.mjs'` 直接注册新策略即可。
 * runtime 默认用这三个；要隔离就自己 createDefaultRegistries()。
 */
export const { launchers, probers, stoppers } = createDefaultRegistries();

export const DEFAULT_LAUNCHER = 'spawn';
export const DEFAULT_PROBER = 'http';
export const DEFAULT_STOPPER = 'kill-tree';
