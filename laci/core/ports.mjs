/**
 * core/ports.mjs —— 端口分配（M4）
 *
 * 规则（任务书 §端口 + 主文档 §5.3）：
 *   基址 = 模型 port（模型上的端口只是"基址"）> 引擎 defaultPort
 *   被占 → 基址往上找，最多 20 个；20 个都撞就报错，并把占用者列出来
 *
 * 端口是**实例级**的：同一个引擎起两个实例，第二个要走第二次分配。
 *
 * 为什么分配成功后还要在进程内"预留"：
 *   bind 测试只能证明"这一瞬间空"。真正 bind 的是几百毫秒后启动的引擎进程，
 *   两个并发加载完全可能同时判 18095 空。所以分配成功先在 holds 里占住，
 *   直到 release()、实例停止 releasePort()，或超过 TTL 自动失效（崩溃漏 release 不会永久漏）。
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { loadInstances } from './registry.mjs';

const execFileAsync = promisify(execFile);

/** 最多试多少个端口（含基址） */
export const PORT_TRIES = 20;

/** 固定端口：3101 控制台 / 8095 网关（00-总纲的共享契约），永远不参与引擎分配 */
export const DEFAULT_RESERVED_PORTS = Object.freeze([3101, 8095]);

/** 引擎实例端口的契约起点（没有引擎、也没给基址时的兜底） */
export const DEFAULT_ENGINE_PORT = 18095;

/** 分配预留的存活时间：正常 release 用不到它，它兜的是异常路径泄漏 */
export const PORT_LEASE_TTL_MS = 10 * 60 * 1000;

/** 只测回环地址：引擎就绑 127.0.0.1，而且绑 0.0.0.0 可能触发防火墙弹窗 */
const DEFAULT_HOST = '127.0.0.1';

const holds = new Map(); // port → { token, reason, at, ttlMs }
const ownerCache = new Map(); // port → { at, value }
let portSeq = 0;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function toInstanceMap(instances) {
  if (instances === undefined) {
    try {
      return toInstanceMap(loadInstances());
    } catch {
      // 数据层还没好 / 读失败：不因为端口判断把加载卡死
      return {};
    }
  }
  if (!instances) return {};
  if (instances instanceof Map) return Object.fromEntries(instances);
  if (Array.isArray(instances)) {
    return Object.fromEntries(
      instances.filter((item) => item && item.id).map((item) => [item.id, item]),
    );
  }
  return typeof instances === 'object' ? instances : {};
}

function instanceOnPort(port, instances) {
  const map = toInstanceMap(instances);
  for (const [instanceId, instance] of Object.entries(map)) {
    if (Number(instance?.port) !== Number(port)) continue;
    // 只有"真的占着端口"的状态才算：idle / error 的实例没有进程，
    // 把它算进来会让端口号一路往上爬（18095 → 18096 → …），
    // 明明上一个实例已经退出了。真正的占用由后面的 bind 测试确认。
    const phase = instance?.phase ?? (instance?.pid ? 'ready' : 'idle');
    if (phase === 'idle' || phase === 'error') continue;
    return {
      instanceId,
      pid: instance?.pid ?? null,
      phase: instance?.phase ?? null,
      source: 'instance',
    };
  }
  return null;
}

function purgeExpiredHolds(now = Date.now()) {
  for (const [port, hold] of holds) {
    if (now - hold.at >= hold.ttlMs) holds.delete(port);
  }
}

/**
 * 基址：显式 base > 模型 port > 引擎 defaultPort > 18095。
 * 注意模型上的 port 也只是基址——"端口必须落在模型上"是指优先级，不是写死。
 */
export function resolveBasePort({ engine = null, model = null, base } = {}) {
  for (const candidate of [base, model?.port, engine?.defaultPort]) {
    if (candidate == null || candidate === '') continue;
    const port = Number(candidate);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new RangeError(`端口基址不合法：${candidate}（应为 1–65535 的整数）`);
    }
    return port;
  }
  return DEFAULT_ENGINE_PORT;
}

/**
 * 探测单个端口能不能 bind。
 * @returns {Promise<{free:boolean, reason:string|null}>}
 */
export async function isPortFree(port, { host = DEFAULT_HOST } = {}) {
  const target = Number(port);
  if (!Number.isInteger(target) || target < 1 || target > 65535) {
    return { free: false, reason: '端口不合法' };
  }

  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (free, reason) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // 没进入 listening 就 close 会抛，忽略即可
      }
      resolve({ free, reason: reason ?? null });
    };

    server.unref();
    server.once('error', (err) => finish(false, err?.code || err?.message || 'listen error'));
    server.listen({ port: target, host, exclusive: true }, () => finish(true));
  });
}

// ---------------------------------------------------------------------------
// 占用者查询（错误信息要说清"是谁占的"）
// ---------------------------------------------------------------------------

/**
 * 从 netstat 输出里找出监听某端口的 PID。
 * 单独导出：os 级查询要起子进程，有些环境跑不了，至少这层解析能拿真实输出回放测试。
 *
 * 真实行：`  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2464`
 */
export function parseNetstatOwner(output, port) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (!match || Number(match[1]) !== Number(port)) continue;
    return { pid: Number(match[2]) };
  }
  return null;
}

/**
 * 从 tasklist 的 CSV 输出里取进程名。
 * 真实行：`"chrome.exe","1234","Console","1","123,456 K"`
 */
export function parseTasklistName(output) {
  const line = String(output ?? '')
    .split(/\r?\n/)
    .find((item) => item.trim());
  if (!line) return null;
  const first = line.trim().split('","')[0].replace(/^"+|"+$/g, '');
  return first || null;
}

async function windowsProcessName(pid) {
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    return parseTasklistName(stdout);
  } catch {
    return null;
  }
}

async function windowsOwner(port) {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const found = parseNetstatOwner(stdout, port);
    if (!found) return null;
    return { pid: found.pid, name: await windowsProcessName(found.pid), source: 'os' };
  } catch {
    // netstat 不在 / 被安全软件拦 / 沙箱不许起子进程：
    // 降级成"不知道谁占的"，但端口不可用这件事已经判断出来了
  }
  return null;
}

async function unixOwner(port) {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const line = String(stdout)
      .split(/\r?\n/)
      .filter(Boolean)[1];
    if (!line) return null;
    const cols = line.trim().split(/\s+/);
    return { pid: Number(cols[1]) || null, name: cols[0] || null, source: 'os' };
  } catch {
    return null;
  }
}

/**
 * 谁占着这个端口。
 * 先看自己的实例表（那是最可信的），再问系统（netstat/tasklist 或 lsof）。
 * @returns {Promise<{pid:number|null,name:string|null,source:'instance'|'os',instanceId?:string}|null>}
 */
export async function whoOccupies(port, { instances, cacheMs = 3000 } = {}) {
  const target = Number(port);
  const now = Date.now();

  const cached = ownerCache.get(target);
  if (cacheMs > 0 && cached && now - cached.at < cacheMs) return cached.value;

  const owner = instanceOnPort(target, instances) ?? (await (process.platform === 'win32' ? windowsOwner(target) : unixOwner(target)));

  if (cacheMs > 0) ownerCache.set(target, { at: now, value: owner });
  return owner;
}

// ---------------------------------------------------------------------------
// 分配 / 释放
// ---------------------------------------------------------------------------

/**
 * 分配一个可用端口（异步）。
 *
 * @param {object} options
 * @param {object|null} [options.engine]  引擎定义（defaultPort 作为基址）
 * @param {object|null} [options.model]   模型定义（port 覆盖基址）
 * @param {number} [options.base]         直接指定基址（优先级最高）
 * @param {string} [options.host]         bind 测试地址，默认 127.0.0.1
 * @param {number} [options.maxTries]     最多试几个，默认 20
 * @param {number[]} [options.reservedPorts] 额外保留端口（除 3101/8095 外）
 * @param {number[]} [options.excludePorts]  本次不可用的端口
 * @param {object|Map} [options.instances] 实例表，默认从 registry 读
 * @param {string} [options.reason]       写到预留里的备注（谁在为哪个实例抢端口）
 * @param {number} [options.ttlMs]        预留存活时间
 * @returns {Promise<{port:number, base:number, tried:number[], release:Function}>}
 *          lease 上带 toString/valueOf/toJSON，误当数字用也能拿到端口号。
 * @throws {PortAllocationError} 20 个都撞了
 */
export async function allocPort({
  engine = null,
  model = null,
  base,
  host = DEFAULT_HOST,
  maxTries = PORT_TRIES,
  reservedPorts = [],
  excludePorts = [],
  instances,
  reason = null,
  ttlMs = PORT_LEASE_TTL_MS,
} = {}) {
  const startPort = resolveBasePort({ engine, model, base });
  const reserved = new Set([...DEFAULT_RESERVED_PORTS, ...reservedPorts].map(Number));
  const excluded = new Set(excludePorts.map(Number));
  const knownInstances = toInstanceMap(instances);
  const tries = Math.max(1, Number.isInteger(Number(maxTries)) ? Number(maxTries) : PORT_TRIES);

  purgeExpiredHolds();

  const attempts = [];
  for (let offset = 0; offset < tries; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) {
      attempts.push({ port, reason: '超出端口范围（>65535）' });
      break;
    }
    if (reserved.has(port)) {
      attempts.push({ port, reason: '保留端口（控制台 / 网关）' });
      continue;
    }
    if (excluded.has(port)) {
      attempts.push({ port, reason: '本次排除（调用方指定）' });
      continue;
    }
    purgeExpiredHolds();
    const held = holds.get(port);
    if (held) {
      attempts.push({ port, reason: `本进程已预留（${held.reason ?? '未说明'}）` });
      continue;
    }
    const instance = instanceOnPort(port, knownInstances);
    if (instance) {
      attempts.push({
        port,
        reason: `实例 ${instance.instanceId} 正在使用（phase ${instance.phase ?? '未知'}）`,
      });
      continue;
    }

    const probe = await isPortFree(port, { host });
    if (probe.free) {
      // await 期间别的分配可能已经抢占了同一个端口：提交前再看一眼预留表，
      // 这次检查到写入是同一个同步片段，不会被插队。
      if (holds.has(port)) {
        attempts.push({ port, reason: '并发分配中已被抢先占用' });
        continue;
      }
      const token = `port-${++portSeq}`;
      const lease = {
        port,
        base: startPort,
        token,
        reason,
        tried: attempts.map((item) => item.port),
        createdAt: Date.now(),
        release() {
          return releasePortLease(lease);
        },
        // 方便 `--port ${lease}` / `lease + 0` 这类误把 lease 当数字的写法
        toString() {
          return String(port);
        },
        valueOf() {
          return port;
        },
        toJSON() {
          return port;
        },
      };
      holds.set(port, { token, reason, at: Date.now(), ttlMs });
      return lease;
    }

    attempts.push({
      port,
      reason: probe.reason === 'EADDRINUSE' ? '被占用' : `不可用（${probe.reason ?? '未知原因'}）`,
    });
  }

  // 全撞了：补上占用者信息再报错（任务书要求"列出占用者"）
  const detailed = [];
  for (const attempt of attempts) {
    const owner = await whoOccupies(attempt.port, { instances: knownInstances, cacheMs: 0 });
    detailed.push({ ...attempt, owner });
  }
  throw new PortAllocationError(startPort, detailed, tries);
}

/** 端口分配失败：带结构化 attempts，界面可以直接摊开给用户看 */
export class PortAllocationError extends Error {
  constructor(basePort, attempts, maxTries) {
    super(buildPortErrorMessage(basePort, attempts, maxTries));
    this.name = 'PortAllocationError';
    this.code = 'EPORTALLOC';
    this.basePort = basePort;
    this.attempts = attempts;
    this.maxTries = maxTries;
  }
}

function buildPortErrorMessage(basePort, attempts, maxTries) {
  const triedPorts = attempts.map((item) => item.port);
  const range =
    triedPorts.length > 1
      ? `${Math.min(...triedPorts)}–${Math.max(...triedPorts)}`
      : String(triedPorts[0] ?? basePort);
  const triedCount = Math.min(attempts.length || maxTries, maxTries);

  const lines = [`端口 ${range} 全部不可用（从 ${basePort} 往上试了 ${triedCount} 个）`];
  for (const attempt of attempts) {
    const owner = attempt.owner;
    let detail = '';
    if (owner) {
      const bits = [];
      // reason 里已经点过名的不要重复报第二遍
      if (owner.instanceId && !attempt.reason.includes(owner.instanceId)) {
        bits.push(`实例 ${owner.instanceId}`);
      }
      if (owner.name && !attempt.reason.includes(owner.name)) bits.push(owner.name);
      if (owner.pid) bits.push(`PID ${owner.pid}`);
      detail = bits.length ? ` —— ${bits.join('，')}` : '';
    }
    lines.push(`  ${attempt.port}  ${attempt.reason}${detail}`);
  }
  return lines.join('\n');
}

function releasePortLease(lease) {
  const held = holds.get(lease.port);
  if (!held || held.token !== lease.token) return false;
  holds.delete(lease.port);
  return true;
}

/** 实例停了 / 启动失败时按端口号释放（调用方只留了数字时用） */
export function releasePort(port) {
  return holds.delete(Number(port));
}

/** 退出 / 测试时清空 */
export function releaseAllPorts() {
  holds.clear();
  ownerCache.clear();
}

/** 当前被本进程预留的端口（测试 / 调试用） */
export function heldPorts() {
  purgeExpiredHolds();
  return [...holds.keys()].sort((a, b) => a - b);
}

/**
 * 给界面做"这个端口现在什么情况"的预览。
 * @returns {Promise<{port:number, free:boolean, reason:string|null, owner:object|null}>}
 */
export async function checkPort(port, { host = DEFAULT_HOST, instances } = {}) {
  const target = Number(port);
  const owner = await whoOccupies(target, { instances });
  const probe = await isPortFree(target, { host });
  return {
    port: target,
    free: probe.free && !owner,
    reason: probe.reason,
    owner,
  };
}
