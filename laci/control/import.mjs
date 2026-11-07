/**
 * LACI 新调度中心 · M3 导入
 * ============================================================================
 * 职责（只做这三件事，别的都不做）：
 *   1. scanPackage(dir)        整合包扫描：脚本 / 引擎 / 模型
 *   2. parseBat(file)          bat 解析：set→env、cd→cwd、命令行→argv+params
 *   3. probe / startProbe      试启动：spawn + 端口差集 + 自动判活 + 工具探测
 *
 * 导出：
 *   scanPackage(dir, opts)                  整合包扫描（纯读）
 *   parseBat(file)                          bat 解析（纯读）
 *   probe(engine, model, opts)              试启动，等结束 → 最终结果（M6 在用）
 *   startProbe(engine, model, opts)         试启动，立刻返回可取消的 session（实时进度用）
 *   buildDraft(scan, opts)                  扫描 + 解析 → { engine, model } 草稿（不写盘）
 *   previewCommand(engine, model)           保存前拿空模型干跑模板（§5.4.1）
 *   applyProbeResult(engine, model, result) 把探到的端口 / 判活 / 工具能力写回草稿
 *   renderArgv / buildSpawnCommand / displayCommandLine / inferKind
 *   listListeningPorts()                    netstat 的 LISTENING 快照
 *   cleanupEphemeral(opts)                  清试启动孤儿（控制台启动时调，§5.5.2）
 *
 * 边界：
 *   ❌ 不算显存（M4）、不启停正式实例（M2）、不暴露 HTTP（M6）、不渲染界面（M7）
 *   ✅ 试启动的那个进程例外——它必须登记成 `ephemeral: true`（§5.5.2）
 *
 * 依赖：
 *   - M1 `core/registry.mjs`：`loadInstances() / saveInstances(map)`，以及（可选）
 *     `listEngines() / listModels()` 用来避免 id 重复。
 *   - M2 `core/runtime.mjs`：**本模块不直接使用**。试启动要探的是"未知端口"，
 *     而 M2 的 InstanceRuntime 判活轮询需要已知 `ready.url`；让 M2 去猜端口只会把
 *     两套探测逻辑搅在一起。试启动只通过 instances.json 让 M2 看见它（`ephemeral: true`）。
 *     M2 的对账/空闲卸载应当跳过 `ephemeral` 的条目（见报告里的待办）。
 *
 * 为什么 M1 用**惰性 dynamic import**（和 server.mjs 里 `await import('./core/runtime.mjs')` 同一套路）：
 *   scanPackage / parseBat / previewCommand 是纯函数，不该因为 M1 还没落地就整文件 import 失败；
 *   真正碰数据的路径（probe 登记、buildDraft 查重）在调用时才解析依赖。
 *
 * 本文件零依赖，只用 node: 内置模块。
 */

import { spawn, execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

// ===========================================================================
// 0. 常量
// ===========================================================================

/** 模型文件后缀——扫描和 bat 参数识别共用这一份，别处不许再写一遍 */
export const MODEL_EXTENSIONS = Object.freeze(['.gguf', '.ninfer', '.safetensors']);

/** 启动脚本后缀：优先 .bat / .cmd */
export const SCRIPT_EXTENSIONS = Object.freeze(['.bat', '.cmd']);

/**
 * 判活路径的尝试顺序（§5.5 第 4 条）。
 * 判定标准只有一个：**HTTP 200 且返回 JSON**。
 * 返回 HTML 不算——Strata 的 `/` 就是一个网页，不能当判活用。
 */
export const READY_PATHS = Object.freeze(['/v1/models', '/health', '/healthz', '/api/health', '/']);

const MODEL_EXTS = new Set(MODEL_EXTENSIONS);
const SCRIPT_EXTS = new Set(SCRIPT_EXTENSIONS);
const EXTRA_LAUNCH_EXTS = new Set(['.ps1', '.py', '.sh']);
const EXE_EXTS = new Set(['.exe', '.com']);
/** 扫描时值得 stat 一次的后缀（stat 是为了拿大小，别对每个文件都 stat） */
const SCAN_EXTS = new Set([...SCRIPT_EXTS, ...EXE_EXTS, ...MODEL_EXTS, ...EXTRA_LAUNCH_EXTS]);

const DEFAULT_ENGINE_PORT = 18095; // 00-总纲：引擎端口基址
const CONTROL_PORT = 3101;
const GATEWAY_PORT = 8095;
/** 自己的固定端口永远不可能是"引擎新开的端口" */
const DENY_PORTS = new Set([CONTROL_PORT, GATEWAY_PORT]);

const DEFAULT_STALL_MS = 30_000; // §5.5：30 秒一行输出都没有、也没新端口 → 提示等输入
const DEFAULT_TOOLS_TIMEOUT_MS = 20_000; // §5.5.1：工具探测超时 → null，不阻塞导入（别让保存流程干等）
const MAX_PROBE_LIFETIME_MS = 30 * 60_000; // 安全上限：关掉页面后 M6 不会取消时，防它永远挂着
const HTTP_TIMEOUT_MS = 1_200; // 单次判活请求，够本地服务用，别拖住 3 秒一轮的扫描
const SCAN_INTERVAL_MS = 3_000; // §5.5：每 3 秒扫一次端口
const MAX_SCAN_DEPTH = 3; // 整合包再深就说明不是常规结构了
const MAX_SCAN_ENTRIES = 20_000; // 防止 30GB 的 Strata 包把扫描拖死
const MAX_LOG_LINES = 200; // §5.5：抓前 200 行
const MAX_EVENT_BUFFER = 1_000; // SSE 重放缓冲
const MAX_LINE_CHARS = 4_000; // 单行日志展示上限
const MAX_HTTP_BODY = 512 * 1024; // 判活响应体上限，超过当"不是 JSON"

/** 这些目录与导入无关，扫到了也只会浪费时间（尤其是自带 venv 的 Strata） */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '__pycache__',
  '.venv', 'venv', 'site-packages', '.cache', '.conda', 'pkgs',
  '$recycle.bin', 'system volume information', 'windows', 'winsxs'
]);

/** 解释器家族：bat 里常见的两种"先起解释器再跑脚本" */
const PYTHON_BASES = new Set(['python', 'python3', 'py', 'pythonw']);
const POWERSHELL_BASES = new Set(['powershell', 'pwsh']);

/** 辅助命令：这些行不会成为引擎，切换成 custom 后也不会再执行（§5.4.2 要列出来） */
const UTILITY_COMMANDS = new Set([
  'copy', 'xcopy', 'robocopy', 'move', 'del', 'erase', 'rmdir', 'rd', 'mkdir', 'md',
  'ren', 'rename', 'attrib', 'icacls', 'takeown', 'mklink', 'curl', 'wget', 'certutil',
  'reg', 'regedit', 'setx', 'sc', 'net', 'taskkill', 'tasklist', 'nvidia-smi', 'wmic',
  'tar', '7z', '7za', 'unzip', 'expand', 'compact', 'fsutil', 'bcdedit', 'shutdown',
  'powershell_ise', 'explorer', 'notepad'
]);

/** 完全无害、忽略掉也不影响启动的 shell 内建命令 */
const BENIGN_BUILTINS = new Set([
  'echo', 'title', 'color', 'cls', 'chcp', 'pause', 'prompt', 'mode',
  'timeout', 'verify', 'break', 'exit', 'setlocal', 'endlocal'
]);

/** 包管理器 / 版本控制：bat 里出现基本是"装依赖"，不是引擎 */
const PACKAGE_MANAGER_COMMANDS = new Set([
  'pip', 'pip3', 'conda', 'mamba', 'micromamba', 'uv', 'poetry', 'pipenv',
  'npm', 'npx', 'yarn', 'pnpm', 'winget', 'choco', 'scoop',
  'git', 'cargo', 'go', 'dotnet', 'nuget', 'vcpkg'
]);

/** 控制流 / 交互命令：出现任意一个就"不能拆"（§5.4） */
const BLOCKING_COMMANDS = new Set(['if', 'else', 'for', 'call', 'choice', 'goto', 'start']);

// ---------------------------------------------------------------------------
// 模型/参数识别表（bat 解析用）
// ---------------------------------------------------------------------------

/** 已知"这个 flag 后面跟的是模型文件/目录" */
const MODEL_FLAGS = new Map([
  ['-m', 'model'],
  ['--model', 'model'],
  ['--model-path', 'model'],
  ['--model-file', 'model'],
  ['--gguf', 'gguf'],
  ['--native', 'native'],
  ['--ple-gguf', 'pleGguf'],
  ['--expert-profile', 'expertProfile'],
  ['--pack', 'pack'],
  ['--mtp', 'mtp'],
  ['--tokenizer', 'tokenizer'],
  ['--control-vector-scaled', 'controlVectorScaled']
]);

/** 这些 flag 的值一定是目录（§5.2 的 kind: dir） */
const DIR_FLAGS = new Set(['--pack', '--mtp', '--tokenizer']);

/** 能映射成模板变量 {xxx} 的数值/字符串参数。
 *  `templated: false` 的（gpuLayers / threads）只记下来给界面参考，**不改成模板变量**——
 *  统一变量表里没有它们，硬塞 `{gpuLayers}` 会让 M1 的校验和别的引擎模板对不上。 */
const PARAM_FLAGS = new Map([
  ['--port', { key: 'port', type: 'int' }],
  ['--listen-port', { key: 'port', type: 'int' }],
  ['-c', { key: 'maxContext', type: 'int' }],
  ['--ctx', { key: 'maxContext', type: 'int' }],
  ['--ctx-size', { key: 'maxContext', type: 'int' }],
  ['--context-size', { key: 'maxContext', type: 'int' }],
  ['--max-context', { key: 'maxContext', type: 'int' }],
  ['--n-ctx', { key: 'maxContext', type: 'int' }],
  ['--host', { key: 'host', type: 'string' }],
  ['--listen', { key: 'host', type: 'string' }],
  ['--bind', { key: 'host', type: 'string' }],
  ['-ngl', { key: 'gpuLayers', type: 'int', templated: false }],
  ['--n-gpu-layers', { key: 'gpuLayers', type: 'int', templated: false }],
  ['--gpu-layers', { key: 'gpuLayers', type: 'int', templated: false }],
  ['-t', { key: 'threads', type: 'int', templated: false }],
  ['--threads', { key: 'threads', type: 'int', templated: false }]
]);

/** §5.4.1 里"声明是数字就必须是数字"的字段（M1 是权威，这里只是保存前干跑一遍） */
const NUMERIC_PARAMS = new Set([
  'maxContext', 'kvWindow', 'kvHeadroomMib', 'prefillChunk', 'hostKvMib',
  'draftTokens', 'visionMaxMerged', 'port', 'gpuLayers', 'threads', 'seed'
]);

// ===========================================================================
// 1. 基础工具（路径 / 进程 / 引号 / id）
// ===========================================================================

/** @returns {Promise<boolean>} */
async function fileExists(target) {
  try {
    const st = await fsp.stat(target);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(target) {
  try {
    const st = await fsp.stat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** 单引号在 bat 里没有特殊含义，这里只处理双引号；用于打印/预览 */
function quoteWin(text) {
  const value = String(text ?? '');
  if (value === '') return '""';
  if (!/[\s"&|<>^()]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function comspec() {
  return process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
}

function isPidAlive(pid) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (err) {
    // EPERM = 进程在，只是没权限；ESRCH = 真没了
    return err?.code === 'EPERM';
  }
}

/**
 * 杀进程树。
 * Windows 上必须用 taskkill /T，否则 cmd.exe 死了、它拉起的引擎还占着显存。
 * 这里**故意不依赖 M2 的 stopper**：控制台重启后要清孤儿时，手里只有一个 pid，
 * 没有 InstanceRuntime 对象可调；这个函数是两条路（试启动 / 清孤儿）的共同底座。
 */
function killTree(pid, { timeoutMs = 8_000 } = {}) {
  const target = Number(pid);
  if (!Number.isInteger(target) || target <= 0) {
    return Promise.resolve({ ok: false, error: '无效的 pid' });
  }

  if (process.platform !== 'win32') {
    try {
      process.kill(target, 'SIGKILL');
      return Promise.resolve({ ok: true });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err.message });
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn('taskkill.exe', ['/pid', String(target), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (err) {
      done({ ok: false, error: err.message });
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经退出了 */ }
      done({ ok: false, error: 'taskkill 超时' });
    }, timeoutMs);

    child.once('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err.message });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      // taskkill 找不到进程时返回 128，这时进程已经不在了，对调用方也算成功
      done({ ok: code === 0 || code === 128, code });
    });
  });
}

/** 把一个名字变成可读的 id（保留中文/数字/点，其余压成 -） */
function slugify(input, fallback = 'item') {
  let text = String(input ?? '').trim().toLowerCase();
  text = text.replace(/['"“”‘’]/g, '');
  text = text.replace(/[^\p{L}\p{N}.-]+/gu, '-');
  text = text.replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (text.length > 48) text = text.slice(0, 48).replace(/[-.]+$/, '');
  return text || fallback;
}

/** base、base-2、base-3…… 找一个没被占用的 id（大小写不敏感，Windows 上尤其如此） */
function uniqueId(base, taken) {
  const isTaken = (value) => Boolean(taken) && (taken.has(value) || taken.has(value.toLowerCase()));
  if (!isTaken(base)) return base;
  for (let i = 2; i < 1_000; i++) {
    const candidate = `${base}-${i}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${base}-${randomBytes(2).toString('hex')}`;
}

function firstInteger(...values) {
  for (const value of values) {
    const num = Number(value);
    if (Number.isInteger(num) && num > 0 && num < 65_536) return num;
  }
  return null;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isInteger(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 去掉目录末尾的斜杠（`%~dp0` 自带一个尾斜杠，cwd 里留着不好看也不便于比较） */
function stripTrailingSep(target) {
  const text = String(target ?? '');
  return text.length > 3 ? text.replace(/[\\/]+$/, '') : text;
}

// ===========================================================================
// 2. 数据层（M1）惰性加载
// ===========================================================================

let registryPromise = null;

/**
 * 解析 `control/../core/registry.mjs`。
 * 拿不全就返回 null，**降级而不是崩**：
 *   - 扫描 / 解析 / 预览完全不碰数据层；
 *   - probe 没有数据层时仍然能试启动，只是不登记（会在事件里明说）。
 */
async function loadRegistry() {
  if (!registryPromise) {
    registryPromise = (async () => {
      try {
        const mod = await import('../core/registry.mjs');
        if (typeof mod.loadInstances === 'function' && typeof mod.saveInstances === 'function') {
          return {
            loadInstances: mod.loadInstances,
            saveInstances: mod.saveInstances,
            listEngines: typeof mod.listEngines === 'function' ? mod.listEngines : null,
            listModels: typeof mod.listModels === 'function' ? mod.listModels : null
          };
        }
        return null;
      } catch {
        return null;
      }
    })();
  }
  return registryPromise;
}

/** 从注册表里拿已有 id（避免导入草稿撞 id）；拿不到就当空 */
async function takenIds(registry) {
  const engines = new Set();
  const models = new Set();
  if (!registry) return { engines, models };
  try {
    if (registry.listEngines) {
      for (const item of (await registry.listEngines()) ?? []) {
        if (item?.id) {
          engines.add(String(item.id));
          engines.add(String(item.id).toLowerCase());
        }
      }
    }
    if (registry.listModels) {
      for (const item of (await registry.listModels()) ?? []) {
        if (item?.id) {
          models.add(String(item.id));
          models.add(String(item.id).toLowerCase());
        }
      }
    }
  } catch {
    // 数据层坏了不该拦住导入，id 冲突留给保存时的 409
  }
  return { engines, models };
}

// ===========================================================================
// 3. 整合包扫描
// ===========================================================================

/** 递归找候选文件；只 stat 认识的后缀，且跳过明显的无关目录 */
async function walkFiles(root, { maxDepth = MAX_SCAN_DEPTH, maxEntries = MAX_SCAN_ENTRIES } = {}) {
  const files = [];
  const errors = [];
  let visited = 0;
  let truncated = false;
  const stack = [{ dir: root, depth: 0 }];

  outer:
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push({ dir, message: err?.message ?? String(err) });
      continue;
    }

    for (const dirent of dirents) {
      if (++visited > maxEntries) {
        truncated = true;
        break outer;
      }
      if (dirent.isSymbolicLink()) continue; // 防环

      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (depth >= maxDepth) continue;
        if (SKIP_DIRS.has(dirent.name.toLowerCase())) continue;
        stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!dirent.isFile()) continue;

      const ext = path.extname(dirent.name).toLowerCase();
      if (!SCAN_EXTS.has(ext)) continue;

      let size = 0;
      try {
        size = (await fsp.stat(full)).size;
      } catch {
        continue; // 读到一半被删/没权限，跳过
      }
      files.push({
        path: full,
        relPath: path.relative(root, full),
        name: dirent.name,
        ext,
        size,
        depth
      });
    }
  }

  return { files, errors, truncated, visited };
}

/**
 * 启动脚本打分：只在"多个到底选哪个"时用来排序，不参与任何正确性判断。
 * 根目录优先；名字像"启动/start/run"的加分；像"安装/依赖/更新"的减分。
 */
function scriptScore(file) {
  const name = file.name.toLowerCase();
  let score = 0;
  if (file.depth === 0) score += 40;
  else score -= file.depth * 5;

  if (/(start|启动|run|launch|serve|server|一键|开始)/i.test(name)) score += 30;
  // 名字就叫 start.bat / 启动.bat 的最像"主入口"，比 python启动.bat 更优先
  if (/^(start|run|launch|serve|启动|开始|一键启动)\.(bat|cmd)$/i.test(name)) score += 15;
  if (/(install|setup|安装|deps|dependency|依赖|download|下载|update|更新|uninstall|卸载|repair|修复|config|配置|env|环境)/.test(name)) score -= 80;
  if (file.ext === '.bat') score += 2; // 同分时 .bat 略优先于 .cmd（都支持，只是习惯）
  return score;
}

function publicFile(file) {
  return {
    path: file.path,
    relPath: file.relPath,
    name: file.name,
    size: file.size,
    depth: file.depth
  };
}

/**
 * 扫一个整合包文件夹。
 *
 * 规则（§5.4 / 任务书）：
 *   - 启动脚本优先 `.bat` / `.cmd`；**多个就全部返回**，让上层让用户选（不替用户决定）
 *   - 没有脚本时才找最大的 `.exe` 当引擎
 *   - 模型文件 `.gguf` / `.ninfer` / `.safetensors`；多个也全部返回
 *
 * 纯读，不写盘、不起进程。
 *
 * @param {string} dir 文件夹
 * @param {{maxDepth?: number, maxEntries?: number}} [opts]
 * @returns {Promise<object>}
 */
export async function scanPackage(dir, opts = {}) {
  if (!dir) throw new TypeError('scanPackage 需要一个文件夹路径');

  const root = path.resolve(String(dir));
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat) {
    const err = new Error(`找不到这个文件夹：${root}`);
    err.code = 'ENOENT';
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`这不是文件夹：${root}；单个 .bat / .exe 请走「导入引擎」`);
    err.code = 'ENOTDIR';
    throw err;
  }

  const maxDepth = clampInt(opts.maxDepth, 0, 8, MAX_SCAN_DEPTH);
  const maxEntries = clampInt(opts.maxEntries, 1, 500_000, MAX_SCAN_ENTRIES);
  const walked = await walkFiles(root, { maxDepth, maxEntries });

  const scripts = [];
  const exes = [];
  const models = [];
  const otherLaunchers = [];

  for (const file of walked.files) {
    if (SCRIPT_EXTS.has(file.ext)) {
      const { score, ...rest } = { ...publicFile(file), score: scriptScore(file) };
      scripts.push({ ...rest, priority: score });
    } else if (EXE_EXTS.has(file.ext)) {
      exes.push(publicFile(file));
    } else if (MODEL_EXTS.has(file.ext)) {
      models.push({ ...publicFile(file), format: file.ext.slice(1) });
    } else if (EXTRA_LAUNCH_EXTS.has(file.ext)) {
      otherLaunchers.push({ ...publicFile(file), kind: file.ext.slice(1) });
    }
  }

  scripts.sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.relPath.localeCompare(b.relPath));
  exes.sort((a, b) => b.size - a.size || a.relPath.localeCompare(b.relPath));
  models.sort((a, b) => b.size - a.size || a.relPath.localeCompare(b.relPath));
  otherLaunchers.sort((a, b) => a.relPath.localeCompare(b.relPath));

  const warnings = [];
  if (scripts.length > 1) {
    warnings.push(`找到 ${scripts.length} 个启动脚本——让用户选一个（已按"最像启动器的"排序）`);
  }
  if (scripts.length === 0) {
    if (exes.length > 0) warnings.push('没有 .bat / .cmd，按最大的 .exe 当引擎');
    else warnings.push('这个文件夹里既没有启动脚本，也没有 .exe——可能选错目录了');
  }
  if (models.length === 0) {
    warnings.push('没找到模型文件（.gguf / .ninfer / .safetensors），可以导入后在引擎里再添加');
  } else if (models.length > 1) {
    warnings.push(`找到 ${models.length} 个模型文件——让用户选一个`);
  }
  if (scripts.length === 0 && otherLaunchers.length > 0) {
    warnings.push(`只找到 ${otherLaunchers.length} 个 .py/.ps1/.sh，没有双击就能跑的脚本；按「导入引擎」处理`);
  }
  if (walked.truncated) {
    warnings.push(`文件太多，扫描到 ${walked.visited} 个条目就停了——结果可能不全`);
  }
  if (walked.errors.length > 0) {
    warnings.push(`有 ${walked.errors.length} 个子目录读不了（权限），已跳过`);
  }

  /* 启动脚本里如果 --config 指了一份 JSON（Strata 这种），把里面的真实参数读出来：
     package 模式下 bat 只负责转发，参数全在那个 JSON 里，bat 自身看不出 MTP/视觉/量化。
     顺序：主启动脚本 → 包里的配置目录 → 其它脚本。整合包常见"外层入口 bat 只调 ps1"，
     真正的引擎启动和配置在别处，所以后面还要兜底。 */
  const readStrataConfig = async (abs) => {
    const raw = await fsp.readFile(abs, 'utf8').then((t) => JSON.parse(t.replace(/^\uFEFF/, ''))).catch(() => null);
    if (!looksLikeStrataConfig(raw)) return null;
    const reasoning = await detectReasoningCapability({ cwd: root }, abs, raw);
    return {
      file: abs,
      relPath: path.relative(root, abs),
      summary: { ...summarizeStrataConfig(raw, abs), reasoning },
      reasoning,
    };
  };
  const configInScript = async (scriptPath) => {
    if (!scriptPath) return null;
    const text = await fsp.readFile(scriptPath, 'utf8').catch(() => '');
    const rel = configPathInScript(text);
    if (!rel) return null;
    return readStrataConfig(resolveConfigRef(rel, scriptPath, root));
  };

  let config = await configInScript(scripts[0] && scripts[0].path);
  let configScript = config ? scripts[0].path : null;
  if (!config) {
    const isProjectJson = (name) => /^(package|tsconfig|jsconfig|settings)\.json$/i.test(name);
    const hits = [];
    for (const dir of [root, path.join(root, '05-config'), path.join(root, 'config'), path.join(root, 'configs'), path.join(root, 'conf')]) {
      for (const name of await fsp.readdir(dir).catch(() => [])) {
        if (/\.json$/i.test(name) && !isProjectJson(name)) hits.push(path.join(dir, name));
      }
    }
    const score = (p) => {
      const n = path.basename(p).toLowerCase();
      return (/(64k|131k|32k|override|backup|\.bak)/.test(n) ? 10 : 0) + n.length / 100;
    };
    hits.sort((a, b) => score(a) - score(b));
    for (const candidate of hits.slice(0, 20)) {
      const hit = await readStrataConfig(candidate);
      if (hit) { config = hit; break; }
    }
  }
  if (!config) {
    for (const script of scripts.slice(1, 8)) {
      const hit = await configInScript(script.path);
      if (hit) { config = hit; configScript = script.path; break; }
    }
  }

  return {
    dir: root,
    name: path.basename(root),
    /** 全部脚本候选（已排序）；多个必须让用户选 */
    scripts,
    /** 建议的脚本 = 第一名（上层仍应把 scripts 全展示） */
    script: scripts[0] ?? null,
    /** 没有脚本时按规则挑的最大 exe；有脚本时为 null（规则如此，但 exes 仍然返回） */
    engine: scripts.length === 0 ? (exes[0] ?? null) : null,
    exes,
    otherLaunchers,
    models,
    model: models[0] ?? null,
    /** 启动脚本 --config 指向的 JSON（目前只认 Strata 形状）；package 模式的真实参数在这 */
    config,
    /** 真正常量指向那份配置的启动脚本（可能不是 scripts[0]） */
    configScript,
    /** 这个包是不是"参数都在配置文件里"：导入时按「原样运行」更诚实 */
    configBacked: Boolean(config),
    warnings,
    truncated: walked.truncated,
    scanned: walked.files.length,
    errors: walked.errors
  };
}

// ===========================================================================
// 3.5 配置文件（Strata 这类：参数不在 bat 里，而在 --config 指向的 JSON 里）
// ===========================================================================

/**
 * 形状像不像 Strata 的 config JSON。
 * 只认两个关键字段，不认版本：`args` 数组 + `exe` 或 `model_name`。
 */
function looksLikeStrataConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!Array.isArray(raw.args)) return false;
  return typeof raw.exe === 'string' || typeof raw.model_name === 'string';
}

// ---------------------------------------------------------------------------
// 3.6 思考能力探测（D4 / §5.3 的可写性）
//
// 思考等级能不能调，是引擎决定的：Strata 这种把默认档放在配置文件顶层
// `reasoning_effort` 的引擎能写；没有这个键、或者根本不用配置文件启动的引擎
// 写了也是白写。所以这里先探测，界面只按探测结果给控件——探测不到就显示
// "不适用"，别给一个点了没反应的控件（就是 2026-11-07 那个 bug）。
// ---------------------------------------------------------------------------

/** 引擎认的思考等级（Strata 只认这四档；别的引擎可以在档案里自己声明 levels） */
export const REASONING_LEVELS = Object.freeze(['none', 'low', 'medium', 'high']);
export const REASONING_EFFORT_KEY = 'reasoning_effort';
export const REASONING_BUDGET_KEY = 'reasoning_budget_tokens';

/** server.py 探测缓存：{ [file]: { mtimeMs, supported } }（每开一次弹窗不重读 600KB） */
const reasoningProbeCache = new Map();

/**
 * 引擎档案里手写的"能力声明"（`engine.reasoning`）。
 * 形状不对就当没声明——校验会单独报，这里只负责取。
 */
export function declaredReasoning(engine) {
  const raw = engine && engine.reasoning;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mode = String(raw.mode || '').toLowerCase();
  if (mode === 'none') return null;
  if (mode !== 'config' && mode !== 'argv') return null;
  const levels = Array.isArray(raw.levels) && raw.levels.length
    ? raw.levels.map((level) => String(level)).filter(Boolean)
    /* argv 型（模型档案 + 命令行模板）沿用模型档案那 7 档；config 型是引擎自己的值域 */
    : (mode === 'config' ? REASONING_LEVELS.slice() : ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  return {
    mode,
    key: mode === 'config'
      ? (typeof raw.key === 'string' && raw.key.trim() ? raw.key.trim() : REASONING_EFFORT_KEY)
      : null,
    budgetKey: mode === 'config'
      ? (typeof raw.budgetKey === 'string' && raw.budgetKey.trim() ? raw.budgetKey.trim() : REASONING_BUDGET_KEY)
      : null,
    levels: levels.length ? levels : REASONING_LEVELS.slice(),
    source: 'engine',
  };
}

function ancestorDirs(dir, up = 4) {
  const out = [];
  let cur = dir ? path.resolve(dir) : '';
  for (let i = 0; i < up && cur; i += 1) {
    out.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/** 读一个 server.py，判断这个 pack 的 serve 版本认不认配置里的 reasoning_effort（#1641）。 */
async function probeReasoningServer(file) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  const cached = reasoningProbeCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  /* #1641 的两个特征：配置键 reasoning_effort、以及把 args 里的 --reasoning-effort 提上来 */
  const supported = text.includes('lift_reasoning_effort_arg')
    || /cfg\.get\(["']reasoning_effort["']\)/.test(text);
  const value = { file, mtimeMs: stat.mtimeMs, supported };
  reasoningProbeCache.set(file, value);
  return value;
}

async function findReasoningServer(roots) {
  for (const root of roots) {
    for (const rel of [['01-runtime', 'serve', 'server.py'], ['serve', 'server.py']]) {
      const probe = await probeReasoningServer(path.join(root, ...rel));
      if (probe && probe.supported) return probe;
    }
  }
  return null;
}

/**
 * 这个引擎能不能写思考等级？能就返回能力描述，不能返回 null。
 *
 * 顺序：档案里手写的声明 > 配置里已经有这个键 > pack 的 serve/server.py 认这个键。
 * 三条都不成立 = 不知道 = 界面显示"不适用"（不猜）。
 */
export async function detectReasoningCapability(engine, configFile, raw) {
  const declared = declaredReasoning(engine);
  if (declared) return declared;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)
    && typeof raw[REASONING_EFFORT_KEY] === 'string' && raw[REASONING_EFFORT_KEY]) {
    return {
      mode: 'config',
      key: REASONING_EFFORT_KEY,
      budgetKey: REASONING_BUDGET_KEY,
      levels: REASONING_LEVELS.slice(),
      source: 'config',
    };
  }

  const roots = [];
  if (configFile) roots.push(...ancestorDirs(path.dirname(configFile)));
  if (engine && typeof engine.cwd === 'string' && engine.cwd) roots.push(path.resolve(engine.cwd));
  if (engine && typeof engine.configFile === 'string' && engine.configFile) {
    roots.push(...ancestorDirs(path.dirname(engine.configFile)));
  }
  const server = await findReasoningServer([...new Set(roots)]);
  if (server) {
    return {
      mode: 'config',
      key: REASONING_EFFORT_KEY,
      budgetKey: REASONING_BUDGET_KEY,
      levels: REASONING_LEVELS.slice(),
      source: 'server',
      file: server.file,
    };
  }
  return null;
}

/**
 * 把 config 的 args 归纳成界面要显示的几项。
 *
 * 为什么需要：package 模式跑的是 bat，模型档案里的 params 根本不参与启动；
 * 真正生效的是这份 JSON。界面要显示就显示这里的值，而不是默认值。
 */
export function summarizeStrataConfig(raw, file) {
  const args = Array.isArray(raw && raw.args) ? raw.args.map(String) : [];
  const valueOf = (flag) => {
    const i = args.lastIndexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag) => args.includes(flag);
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const spec = num(valueOf('--spec'));
  const specOn = spec != null && spec > 0;
  const mtpPath = has('--mtp');

  return {
    file: file || null,
    model: raw.model_name || null,
    modelFile: valueOf('--native') || null,
    openBrowser: raw.open_browser === false ? false : (raw.open_browser === true ? true : null),
    port: num(raw.port) ?? num(valueOf('--port')),
    maxContext: num(valueOf('--max-context')),
    kvDtype: valueOf('--kv'),
    kvResident: num(valueOf('--kv-resident')),
    residentBudgetGib: num(valueOf('--resident-budget-gib')),
    mtp: mtpPath || specOn,
    spec: specOn ? 'mtp' : null,
    draftTokens: specOn ? spec : null,
    vision: has('--vision'),
    reasoningBudget: num(raw.reasoning_budget_tokens),
    reasoningEffort: typeof raw[REASONING_EFFORT_KEY] === 'string' && raw[REASONING_EFFORT_KEY]
      ? raw[REASONING_EFFORT_KEY]
      : null,
    exe: raw.exe || null,
    cwd: raw.cwd || null
  };
}

/** 从启动脚本文本里找 `--config "xxx.json"` / `"--config" "xxx.json"` / `-Config "xxx.json"`（bat 可能是 GBK，但路径是 ASCII，能认） */
function configPathInScript(text) {
  const s = String(text || '');
  /* 注意 flag 本身也可能被引号包着（bat 里常见 "--config" "x.json"），引号要吃掉 */
  const re = /(?:^|[\s"'])[-/]{1,2}config"?\s*(?:=\s*|\s+)"([^"\r\n]+?\.json)"|(?:^|[\s"'])[-/]{1,2}config"?\s*(?:=\s*|\s+)([^\s"']+\.json)/i;
  const m = s.match(re);
  if (!m) return '';
  return String(m[1] || m[2] || '').trim();
}

/** 脚本里的配置路径可能是 `%~dp005-config\x.json`（相对 bat 所在目录） */
function resolveConfigRef(raw, scriptFile, baseDir) {
  let ref = String(raw || '').trim();
  ref = ref.replace(/%~dp0/gi, path.dirname(scriptFile) + path.sep);
  if (path.isAbsolute(ref)) return path.normalize(ref);
  return path.resolve(baseDir || path.dirname(scriptFile), ref);
}

/** 简单的 Windows 命令行分词：双引号整体算一个，其余按空白切 */
function tokenizeCommandLine(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}

/**
 * 找脚本里真正启动引擎的那一行（可能用 ^ 续行），把参数切出来。
 * 只认带 .exe 且带 --flag 的行；echo / if / set 这些跳过。
 */
function engineInvocationTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    if (/^(::|rem(\s|$)|@rem(\s|$)|echo(\s|\.|$))/i.test(line)) continue;

    const joined = [line];
    while (joined.length < 20 && /\^\s*$/.test(joined[joined.length - 1]) && i + 1 < lines.length) {
      joined[joined.length - 1] = joined[joined.length - 1].replace(/\^\s*$/, '');
      joined.push(lines[++i].trim());
    }
    const full = joined.join(' ');
    if (/\.exe\b/i.test(full) && /--[a-z]/i.test(full)) return tokenizeCommandLine(full);
  }
  return [];
}

/** 把脚本里的 set / setlocal 环境变量读出来（够用就行，不做变量展开） */
function scriptEnvMap(text) {
  const env = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^@+/, '');
    const m = line.match(/^set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?$/i);
    if (m) env[m[1].toUpperCase()] = m[2];
  }
  return env;
}

/** 把脚本里的 %VAR% / %~dp0 展开成真实路径（最多三轮，够处理 %MODEL% 里再套 %PACK% 的情况） */
function resolveScriptToken(token, env, scriptFile) {
  const dir = scriptFile ? path.dirname(scriptFile) : '';
  let out = String(token || '');
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    out = out.replace(/%~dp0/gi, dir ? dir + '\\' : '');
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => {
      const value = env && env[String(name).toUpperCase()];
      return value != null ? String(value) : m;
    });
    if (out === before) break;
  }
  return out;
}

/**
 * 把"参数写在启动脚本命令行里"的引擎（ninfer 这种）归纳成界面要显示的值。
 * 返回 null = 这一行里没有能认出来的参数，别拿它冒充配置。
 */
export function summarizeLaunchArgs(tokens, env, file) {
  const args = Array.isArray(tokens) ? tokens.map(String) : [];
  const valueOf = (flag) => {
    const i = args.lastIndexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const has = (flag) => args.includes(flag);
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  /* 第一个不是 flag 的参数就是模型文件（ninfer 是位置参数） */
  let modelFile = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i].startsWith('-')) break;
    const resolved = resolveScriptToken(args[i], env, file);
    /* 只认模型文件；python/ps1 这种"脚本本身"不算（否则会被当成"脚本写死了模型"） */
    if (/\.(ninfer|gguf|safetensors)$/i.test(resolved)) modelFile = resolved;
    break;
  }

  const spec = num(valueOf('--spec'));
  const specOn = spec != null && spec > 0;
  const envMap = env || {};
  const kvWindow = num(envMap.NINFER_KV_WINDOW);

  const summary = {
    file: file || null,
    source: 'script',
    model: valueOf('--model-id'),
    modelFile,
    port: num(valueOf('--port')),
    maxContext: num(valueOf('--max-context')),
    kvWindow,
    kvDtype: valueOf('--kv-dtype') || valueOf('--kv'),
    kvResident: num(valueOf('--kv-resident')),
    hostKvMib: num(valueOf('--host-kv-mib')),
    kvHeadroomMib: num(valueOf('--kv-headroom-mib')),
    prefillChunk: num(valueOf('--prefill-chunk')),
    mtp: has('--mtp') || specOn,
    spec: specOn ? 'mtp' : null,
    draftTokens: num(valueOf('--draft-tokens')) ?? (specOn ? spec : null),
    vision: has('--vision'),
    visionResidency: valueOf('--vision-residency'),
    visionMaxMerged: num(valueOf('--vision-max-merged')),
    reasoningBudget: num(valueOf('--default-thinking-budget')),
    env: envMap
  };

  const known = ['maxContext', 'kvDtype', 'vision', 'mtp', 'hostKvMib', 'prefillChunk', 'port', 'kvWindow'];
  const recognized = known.some((key) => {
    const v = summary[key];
    return v != null && v !== false;
  });
  return recognized ? summary : null;
}


/**
 * 找一个引擎真正在用的配置文件。
 * 顺序：engine.configFile → 启动脚本里的 --config → 工作目录里形状像 Strata config 的 json。
 */
export async function findEngineConfig(engine) {
  if (!engine || typeof engine !== 'object') return { ok: true, found: false };

  const candidates = [];
  if (typeof engine.configFile === 'string' && engine.configFile) candidates.push(engine.configFile);

  const file = String(engine.file || '');
  if (file && /\.(bat|cmd)$/i.test(file)) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const rel = configPathInScript(text);
    if (rel) candidates.push(resolveConfigRef(rel, file, engine.cwd || path.dirname(file)));
  }

  const tryRead = async (candidate) => {
    const raw = await fsp.readFile(candidate, 'utf8').then((t) => JSON.parse(t.replace(/^\uFEFF/, ''))).catch(() => null);
    if (!looksLikeStrataConfig(raw)) return null;
    const reasoning = await detectReasoningCapability(engine, candidate, raw);
    return {
      ok: true,
      found: true,
      file: candidate,
      config: { ...summarizeStrataConfig(raw, candidate), reasoning },
      reasoning,
    };
  };

  for (const candidate of candidates) {
    const hit = await tryRead(candidate).catch(() => null);
    if (hit) return hit;
  }

  /* package 引擎：参数直接写在启动脚本的命令行里（ninfer 这种，没有 --config） */
  if (file && /\.(bat|cmd)$/i.test(file)) {
    const text = await fsp.readFile(file, 'utf8').catch(() => '');
    const summary = summarizeLaunchArgs(engineInvocationTokens(text), scriptEnvMap(text), file);
    /* 原样运行脚本：启动命令写死在脚本里，模型档案里的思考参数进不了命令行 → 不可写 */
    if (summary) return { ok: true, found: true, file, config: { ...summary, reasoning: null }, reasoning: null };
  }

  // 兜底：工作目录里找（根目录 + 常见的配置子目录；最多看 20 个 json）
  const cwd = engine.cwd || (file ? path.dirname(file) : '');
  if (cwd) {
    const isProjectJson = (name) => /^(package|tsconfig|jsconfig|settings)\.json$/i.test(name);
    const hits = [];
    for (const name of await fsp.readdir(cwd).catch(() => [])) {
      if (/\.json$/i.test(name) && !isProjectJson(name)) hits.push(path.join(cwd, name));
    }
    for (const dir of ['05-config', 'config', 'configs', 'conf']) {
      const sub = path.join(cwd, dir);
      for (const name of await fsp.readdir(sub).catch(() => [])) {
        if (/\.json$/i.test(name) && !isProjectJson(name)) hits.push(path.join(sub, name));
      }
    }
    /* 优先名字短、不带 64k/131k/override 这类变体后缀的（通常是默认配置） */
    const score = (p) => {
      const n = path.basename(p).toLowerCase();
      return (/(64k|131k|32k|override|backup|\.bak)/.test(n) ? 10 : 0) + n.length / 100;
    };
    hits.sort((a, b) => score(a) - score(b));
    for (const candidate of hits.slice(0, 20)) {
      const hit = await tryRead(candidate).catch(() => null);
      if (hit) return hit;
    }
  }

  return { ok: true, found: false };
}

/**
 * 把界面上改的 7 个参数写回配置文件（外科手术：只动认识的 flag，其余原样保留）。
 *
 * 为什么不做"整份 JSON 编辑器"：配置里还有 pack / native / ple / control-vector 这些
 * 模型专属参数，重写成一份通用结构会把它们弄丢。这里只在 args 里替换/增删对应项。
 */
export function applyConfigValues(raw, values, options = {}) {
  if (!looksLikeStrataConfig(raw)) {
    const err = new Error('不是认识的配置文件格式（缺少 args / exe）');
    err.code = 'EINVAL';
    throw err;
  }
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const before = args.slice();
  const changed = [];
  const v = values && typeof values === 'object' ? values : {};
  /* 思考等级写哪个键、认哪些档，由探测出来的能力决定（没有能力就不许写） */
  const reasoningKey = typeof options.reasoningKey === 'string' && options.reasoningKey
    ? options.reasoningKey
    : null;
  const reasoningLevels = Array.isArray(options.reasoningLevels) && options.reasoningLevels.length
    ? options.reasoningLevels.map(String)
    : REASONING_LEVELS.slice();
  const budgetKey = typeof options.budgetKey === 'string' && options.budgetKey
    ? options.budgetKey
    : REASONING_BUDGET_KEY;

  const argValue = (flag) => {
    const i = args.lastIndexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  const same = (a, b) => String(a ?? '') === String(b ?? '');
  const setValue = (flag, value) => {
    const i = args.lastIndexOf(flag);
    if (i >= 0 && i + 1 < args.length) args[i + 1] = String(value);
    else args.push(flag, String(value));
  };
  const drop = (flag, withValue = true) => {
    const i = args.lastIndexOf(flag);
    if (i >= 0) args.splice(i, withValue ? 2 : 1);
  };
  const setSwitch = (flag, on) => {
    const has = args.includes(flag);
    if (on && !has) args.push(flag);
    if (!on && has) drop(flag, false);
  };
  const num = (value, label, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) {
      const err = new Error(`${label} 超出范围（${min}–${max}）`);
      err.code = 'EINVAL';
      throw err;
    }
    return Math.round(n);
  };

  if (v.maxContext != null && v.maxContext !== '') {
    const n = num(v.maxContext, '上下文', 256, 1048576);
    if (!same(argValue('--max-context'), n)) { setValue('--max-context', n); changed.push('maxContext'); }
  }
  if (v.kvDtype) {
    if (!same(argValue('--kv'), v.kvDtype)) { setValue('--kv', String(v.kvDtype)); changed.push('kvDtype'); }
  }
  if (v.kvResident != null && v.kvResident !== '') {
    const n = num(v.kvResident, 'KV resident', 0, 1048576);
    if (!same(argValue('--kv-resident'), n)) { setValue('--kv-resident', n); changed.push('kvResident'); }
  }
  if (v.draftTokens != null && v.draftTokens !== '') {
    const n = num(v.draftTokens, '草稿数', 0, 15);
    if (n > 0) {
      if (!same(argValue('--spec'), n)) { setValue('--spec', n); changed.push('draftTokens'); }
    } else if (args.includes('--spec')) {
      drop('--spec');
      drop('--spec-min-p');
      changed.push('draftTokens');
    }
  }
  if (v.mtp != null) {
    const on = Boolean(v.mtp);
    const idx = args.lastIndexOf('--mtp');
    const hasMtp = idx >= 0 && idx + 1 < args.length;
    if (on && !hasMtp) {
      /* 关掉时把 --mtp 目录一起摘了，这里用记下来的目录恢复；没有目录就报错 */
      const dir = typeof raw.mtp_dir === 'string' ? raw.mtp_dir : '';
      if (!dir) {
        const err = new Error('打开 MTP 需要 --mtp 目录，配置文件里没有，先在文件里手动加');
        err.code = 'EINVAL';
        throw err;
      }
      args.push('--mtp', dir);
      if (!args.includes('--spec-min-p') && raw.spec_min_p != null) args.push('--spec-min-p', String(raw.spec_min_p));
      changed.push('mtp');
    } else if (!on && hasMtp) {
      raw.mtp_dir = args[idx + 1];
      args.splice(idx, 2);
      /* --spec / --spec-min-p 是 MTP 的配套参数，跟着收起来，恢复时再放回去 */
      const si = args.lastIndexOf('--spec');
      if (si >= 0) {
        if (si + 1 < args.length) raw.spec_value = args[si + 1];
        args.splice(si, 2);
      }
      const pi = args.lastIndexOf('--spec-min-p');
      if (pi >= 0) {
        if (pi + 1 < args.length) raw.spec_min_p = args[pi + 1];
        args.splice(pi, 2);
      }
      changed.push('mtp');
    }
  }
  if (v.vision != null) {
    const on = Boolean(v.vision);
    if (on !== args.includes('--vision')) { setSwitch('--vision', on); changed.push('vision'); }
  }
  if (v.reasoningBudget != null && v.reasoningBudget !== '') {
    const n = num(v.reasoningBudget, '思考预算', 0, 1000000);
    if (!same(raw[budgetKey], n)) { raw[budgetKey] = n; changed.push('reasoningBudget'); }
  }
  if (v.reasoningEffort != null && v.reasoningEffort !== '') {
    if (!reasoningKey) {
      const err = new Error('这个引擎没有可写的思考等级配置键');
      err.code = 'EINVAL';
      throw err;
    }
    const level = String(v.reasoningEffort);
    if (!reasoningLevels.includes(level)) {
      const err = new Error(`思考等级只能是 ${reasoningLevels.join(' / ')}（引擎不认 ${level}）`);
      err.code = 'EINVAL';
      throw err;
    }
    if (!same(raw[reasoningKey], level)) { raw[reasoningKey] = level; changed.push('reasoningEffort'); }
  }

  if (typeof v.openBrowser === 'boolean') {
    if (raw.open_browser !== v.openBrowser) { raw.open_browser = v.openBrowser; changed.push('openBrowser'); }
  }

  raw.args = args;
  /* args_written 只是同一份内容的历史副本；只有它和改动前完全一致时才跟着改 */
  if (Array.isArray(raw.args_written)
    && raw.args_written.length === before.length
    && raw.args_written.every((item, i) => String(item) === String(before[i]))) {
    raw.args_written = args.slice();
  }

  return { changed };
}

/** 备份文件用的时间戳：20261106-194500 */
function backupStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 写回配置文件：冲突检测 → 备份 → 原子替换。
 * 返回 { ok, changed, backup, config, mtimeMs }；参数没变就什么都不写。
 */
export async function writeEngineConfig(file, values, { expectedMtimeMs = null, reasoningKey = null, reasoningLevels = null, budgetKey = null } = {}) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) {
    const err = new Error(`找不到配置文件：${file}`);
    err.code = 'ENOENT';
    throw err;
  }
  if (expectedMtimeMs != null && Math.abs(Number(stat.mtimeMs) - Number(expectedMtimeMs)) > 1) {
    const err = new Error('配置文件在磁盘上被改过了，请重新加载后再保存');
    err.code = 'ECONFLICT';
    throw err;
  }

  const text = await fsp.readFile(file, 'utf8');
  let raw;
  try {
    raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  } catch {
    const err = new Error('配置文件不是合法 JSON');
    err.code = 'EINVAL';
    throw err;
  }
  if (!looksLikeStrataConfig(raw)) {
    const err = new Error('不是认识的配置文件格式（缺少 args / exe）');
    err.code = 'EINVAL';
    throw err;
  }

  const { changed } = applyConfigValues(raw, values, { reasoningKey, reasoningLevels, budgetKey });
  const summary = summarizeStrataConfig(raw, file);
  if (!changed.length) {
    return { ok: true, changed: [], backup: null, config: summary, mtimeMs: stat.mtimeMs };
  }

  const backup = `${file}.bak-${backupStamp()}`;
  await fsp.copyFile(file, backup);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(raw, null, 1), 'utf8');
  await fsp.rename(tmp, file);
  const after = await fsp.stat(file);
  return { ok: true, changed, backup, config: summary, mtimeMs: after.mtimeMs };
}

/** 脚本里 `cd /d "..."` 指向的工作目录（解析 %VAR% / %~dp0） */
function scriptWorkingDir(text, scriptFile, env) {
  const m = String(text || '').match(/^\s*cd\s+\/d\s+"?([^"\r\n]+)"?/im);
  if (m) {
    const resolved = resolveScriptToken(m[1].trim(), env, scriptFile);
    if (resolved) return resolved;
  }
  return path.dirname(scriptFile);
}

/**
 * 把"启动脚本跑某个固定模型"的引擎转成"按参数运行"：
 * 程序从 bat 换成 exe，脚本里那个模型文件换成 `{model}`，`--port` / `--model-id` / `--host`
 * 换成模板变量，env 也一并搬过来。
 *
 * 这样点哪个模型就起哪个，不再受脚本写死的那一个限制。
 * 只对"命令里直接跑 exe + 带一个模型文件参数"的脚本成立；python/py 脚本、
 * 参数在配置文件里的（Strata）会返回 ok:false 并说明原因。
 */
export async function convertScriptEngine(engine) {
  const scriptFile = engine && engine.file ? String(engine.file) : '';
  if (!scriptFile || !/\.(bat|cmd)$/i.test(scriptFile)) {
    return { ok: false, reason: '这个引擎不是用 .bat/.cmd 启动的，不需要转换' };
  }
  const text = await fsp.readFile(scriptFile, 'utf8').catch(() => '');
  if (!text) return { ok: false, reason: '读不了启动脚本' };

  const tokens = engineInvocationTokens(text);
  if (!tokens.length) return { ok: false, reason: '从脚本里解析不出启动命令' };
  const env = scriptEnvMap(text);
  const cwd = scriptWorkingDir(text, scriptFile, env);
  const programRaw = resolveScriptToken(tokens[0], env, scriptFile);
  const program = path.isAbsolute(programRaw) ? programRaw : path.resolve(cwd, programRaw);
  if (!/\.exe$/i.test(program)) {
    return { ok: false, reason: '启动命令不是直接跑 exe（可能是 python / 脚本），没法按模型切换' };
  }

  /* 第一个非 flag 参数通常是模型文件 */
  let modelIdx = -1;
  for (let i = 1; i < tokens.length; i += 1) {
    if (tokens[i].startsWith('-')) break;
    modelIdx = i;
    break;
  }
  if (modelIdx < 0 || !/\.(ninfer|gguf|safetensors)$/i.test(resolveScriptToken(tokens[modelIdx] || '', env, scriptFile))) {
    return { ok: false, reason: '启动命令里没有模型文件参数（模型可能写在配置文件里），没法按模型切换' };
  }

  const argv = [];
  let hasVision = false;
  for (let i = 1; i < tokens.length; i += 1) {
    if (i === modelIdx) { argv.push('{model}'); continue; }
    const token = tokens[i];
    /* 视觉三连抽出来放进 capabilityArgs：没有视觉组件的模型（比如破甲文本模型）就不加 */
    if (token === '--vision') { hasVision = true; continue; }
    if (token === '--vision-residency' || token === '--vision-max-merged') { hasVision = true; i += 1; continue; }
    /* 端口 / 模型名 / 绑定地址换成模板变量，交给 LACI 决定 */
    if (token === '--port' || token === '--model-id' || token === '--host') {
      argv.push(token, token === '--port' ? '{port}' : (token === '--model-id' ? '{modelId}' : '{host}'));
      i += 1; // 跳过原来的值
      continue;
    }
    argv.push(token);
  }
  if (!argv.includes('--model-id')) argv.push('--model-id', '{modelId}');
  if (!argv.includes('--port')) argv.push('--port', '{port}');

  const capabilityArgs = Object.assign({}, engine.capabilityArgs || {});
  if (hasVision) {
    capabilityArgs.vision = ['--vision', '--vision-residency', '{visionResidency}', '--vision-max-merged', '{visionMaxMerged}'];
  }
  /* 把脚本里的字面值存成 presetParams：模型创建/预填时用（没有配置文件也有默认值可读） */
  const presetSummary = summarizeLaunchArgs(tokens, env, scriptFile) || {};
  const presetParams = {
    maxContext: presetSummary.maxContext,
    kvDtype: presetSummary.kvDtype,
    kvWindow: presetSummary.kvWindow,
    kvResident: presetSummary.kvResident,
    hostKvMib: presetSummary.hostKvMib,
    kvHeadroomMib: presetSummary.kvHeadroomMib,
    prefillChunk: presetSummary.prefillChunk,
    mtp: presetSummary.mtp,
    spec: presetSummary.spec,
    draftTokens: presetSummary.draftTokens,
    vision: presetSummary.vision,
  };
  /* 脚本里带 --spec/--draft-tokens 就声明 MTP 能力，别让转换后丢掉 */
  if (argv.includes('--spec') || argv.includes('--draft-tokens')) {
    capabilityArgs.mtp = ['--spec', '{spec}', '--draft-tokens', '{draftTokens}'];
  }

  /* 只保留真正的运行参数，路径辅助变量（PACK/MODEL）不搬 */
  const envOut = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'PACK' || key === 'MODEL' || key === 'PORT') continue;
    envOut[key] = resolveScriptToken(value, env, scriptFile);
  }
  /* KV 窗口交给模型档案（每个模型可以不一样） */
  if (envOut.NINFER_KV_WINDOW) envOut.NINFER_KV_WINDOW = '{kvWindow}';

  const warnings = [];
  if (/[\\/]/.test(envOut.PATH || '')) warnings.push('脚本里有 PATH 改写，没有搬过来');

  return {
    ok: true,
    engine: {
      ...engine,
      mode: 'custom',
      kind: 'exe',
      file: program,
      cwd: path.dirname(program),
      interpreter: null,
      fileSlots: [{ key: 'model', label: '模型文件', kind: 'file' }],
      argv: templatizeArgv(argv),
      env: Object.keys(envOut).length ? envOut : null,
      presetParams,
      capabilityArgs: Object.keys(capabilityArgs).length ? capabilityArgs : null,
      why: '从 ' + path.basename(scriptFile) + ' 转换而来：模型由模型档案决定，点哪个起哪个',
    },
    warnings,
  };
}

/** 这些 flag 的值应该由模型档案决定（而不是写死在引擎里） */
const TEMPLATE_FLAGS = new Map([
  ['--max-context', 'maxContext'],
  ['--kv-headroom-mib', 'kvHeadroomMib'],
  ['--prefill-chunk', 'prefillChunk'],
  ['--host-kv-mib', 'hostKvMib'],
  ['--kv-dtype', 'kvDtype'],
  ['--default-reasoning-effort', 'thinkingEffort'],
  ['--default-thinking-budget', 'thinkingBudget'],
]);

/** 把 argv 里的字面量换成模板变量：--max-context 131072 → --max-context {maxContext} */
export function templatizeArgv(argv) {
  const list = Array.isArray(argv) ? argv.map(String) : [];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const key = TEMPLATE_FLAGS.get(list[i]);
    if (key && i + 1 < list.length && !String(list[i + 1]).startsWith('{')) {
      out.push(list[i], `{${key}}`);
      i += 1;
      continue;
    }
    out.push(list[i]);
  }
  return out;
}

/** 对已经是 custom 的引擎做一次"数值模板化"（不动文件，只换 argv/env 里的字面量） */
export function templatizeEngine(engine) {
  if (!engine || typeof engine !== 'object') return null;
  const argv = templatizeArgv(engine.argv);
  let env = engine.env && typeof engine.env === 'object' ? { ...engine.env } : engine.env;
  if (env && typeof env.NINFER_KV_WINDOW === 'string' && env.NINFER_KV_WINDOW && !env.NINFER_KV_WINDOW.startsWith('{')) {
    env = { ...env, NINFER_KV_WINDOW: '{kvWindow}' };
  }
  return { ...engine, argv, env };
}

// ===========================================================================
// 4. bat 解析
// ===========================================================================//
// 支持哪些写法（验收清单在报告里也列了）：
//   ✅ 注释：`::`、`rem`、`@rem`
//   ✅ `@echo off` / `echo` / `title` / `color` / `cls` / `chcp` / `pause` / `timeout`（无害，忽略）
//   ✅ `set VAR=value`、`set "VAR=value"`（值里的 %VAR% 当场展开）
//   ✅ `cd /d %~dp0`、`cd ..`、`pushd` / `popd`（→ cwd）
//   ✅ `%~dp0` `%~f0` `%~n0` `%~x0` `%~p0` `%~d0` `%CD%` `%VAR%` `%%` / 延迟展开 `!VAR!`（尽力）
//   ✅ 一行多条：`cd /d %~dp0 && .\engine.exe --port 8080`
//   ✅ 引号路径：`"C:\Program Files\x\llama-server.exe" -m "model.gguf"`
//   ✅ 行尾 `^` 续行
//   ✅ 解释器：`python server.py`、`powershell -File serve.ps1`、`cmd /c run.bat`
//   ❌ `if` / `else` / `for` / `call` / `choice` / `goto` / `start` / `|` / `||` / `>` 重定向
//      → 不算"能拆"，但**仍然尽力把能认的都认出来**，并把转不过去的行逐行列出来（§5.4.2）
//
// 关键决策：
//   1. 初始 cwd = bat 所在目录。双击 bat 时 cmd 的当前目录就是脚本目录，
//      这样没写 `cd` 的脚本也不会把相对路径算错。
//   2. 不认识的辅助命令（copy / mkdir / reg / 安装器 …）标成 severity:'skipped'：
//      它们不会让解析"不成立"，但切换后确实不会执行，必须让用户看到（§5.4.2 的确认框）。
//      只有控制流 / 交互命令才是 severity:'blocker'（= 不能拆）。
//   3. 展开不了的 `%VAR%` **保持字面量**（cmd 实际会展开成空串）。宁可让用户看到
//      `%SOME_PATH%` 知道这里不对，也不要悄悄变成空串拖到启动失败。启动命令里有这种变量 → 不能拆。
//   4. `python -u x.py` 这种带解释器参数的，不用 kind:'py'（LACI 的 interpreter 只能放一个路径，
//      会丢 -u），改成按 exe 直接起 python 本体，参数一个不丢。

/** 按 BOM / UTF-8 / GBK 的顺序解码。bat 在中文 Windows 上大概率是 GBK。 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    try {
      return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'utf-16be' };
    } catch {
      // 落到下面
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buffer), encoding: 'gbk' };
    } catch {
      return { text: buffer.toString('latin1'), encoding: 'latin1' };
    }
  }
}

/** 行尾是 `^` 且不是 `^^`（字面量 ^）→ 续行 */
function endsWithContinuation(line) {
  const trimmed = String(line).replace(/\s+$/, '');
  if (!trimmed.endsWith('^')) return false;
  return !trimmed.endsWith('^^');
}

/** 有没有未加引号的重定向（`>` / `<`）——写到文件属于副作用 */
function hasRedirection(text) {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === '^') {
      i++;
      continue;
    }
    if (ch === '>' || ch === '<') return true;
  }
  return false;
}

/**
 * 拆一行里的多条命令：`a && b & c`。
 * 不按引号内的字符拆；遇到单个 `|`（管道）或 `||`（条件执行）就报告，调用方判"不能拆"。
 */
function splitCommandChain(text) {
  const parts = [];
  let current = '';
  let quoted = false;
  let piped = false;
  let hasOr = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
      continue;
    }
    if (!quoted && ch === '^') {
      current += text[i + 1] ?? '';
      i++;
      continue;
    }
    if (!quoted && ch === '|') {
      if (text[i + 1] === '|') {
        // `a || b`：两边都可能执行，拆开各自认（反正整行已判"不能拆"）
        hasOr = true;
        i++;
        parts.push(current);
        current = '';
      } else {
        piped = true;
      }
      continue;
    }
    if (!quoted && ch === '&') {
      if (text[i + 1] === '&') i++;
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  return { parts: parts.filter((part) => part.trim()), piped, hasOr };
}

/**
 * cmd 风格分词：只认双引号分组；引号外 `^` 转义下一个字符。
 * 不做 glob 展开（cmd 自己也不在 argv 层展开）。
 */
function tokenizeCmd(text) {
  const tokens = [];
  let current = '';
  let quoted = false;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!quoted && ch === '^') {
      if (i + 1 < text.length) {
        current += text[++i];
        started = true;
      }
      continue;
    }
    if (ch === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (started || current) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

let processEnvLowerCache = null;
function processEnvLower() {
  if (!processEnvLowerCache) {
    processEnvLowerCache = new Map();
    for (const [name, value] of Object.entries(process.env)) {
      processEnvLowerCache.set(name.toLowerCase(), value);
    }
  }
  return processEnvLowerCache;
}

function lookupEnv(name, ctx) {
  const key = String(name).toLowerCase();
  if (key === 'cd') return ctx.getCwd();
  if (['errorlevel', 'date', 'time', 'random', 'cmdcmdline', 'cmdextversion', 'highestnumanodenumber'].includes(key)) {
    return undefined; // 运行时才知道，静态展开不了
  }
  const local = ctx.envMap.get(key);
  if (local) return local.value;
  const fromProcess = processEnvLower().get(key);
  return fromProcess;
}

/** `%~dp0` 这一族：只支持 %0（脚本自己）和常规 f/d/p/n/x 组合 */
function expandArgRef(spec, ctx) {
  const match = /^([fdpnx]*)([0-9])$/i.exec(spec);
  if (!match) return null;
  if (Number(match[2]) !== 0) return null; // %~1 是运行参数，未知

  const flags = match[1].toLowerCase();
  const file = ctx.batFile;
  if (!file) return null;
  if (flags.includes('f')) return file;

  const parsed = path.parse(file);
  const drive = parsed.root.replace(/[\\/]+$/, ''); // C:
  const dirPart = parsed.dir === parsed.root
    ? path.sep
    : parsed.dir.slice(drive.length) + path.sep;

  let out = '';
  if (flags.includes('d')) out += drive;
  if (flags.includes('p')) out += dirPart;
  if (flags.includes('n')) out += parsed.name;
  if (flags.includes('x')) out += parsed.ext;
  return out === '' ? file : out;
}

/**
 * 展开一行里的 `%VAR%` / `%~dp0` / `%%` / `!VAR!`。
 * 展开不了的变量保留字面量，并记进 ctx.unresolved。
 */
function expandVars(text, ctx) {
  const unresolved = ctx.unresolved;
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '%') {
      if (text[i + 1] === '%') {
        out += '%';
        i += 2;
        continue;
      }

      // `%~dp0` / `%0`：cmd 的参数引用**没有结尾的 %**，不能按 %VAR% 那套找配对
      if (text[i + 1] === '~') {
        let cursor = i + 2;
        let flags = '';
        while (cursor < text.length && /[fdpnxsatz]/i.test(text[cursor])) {
          flags += text[cursor];
          cursor += 1;
        }
        if (cursor < text.length && /[0-9]/.test(text[cursor])) {
          const spec = flags + text[cursor];
          const value = expandArgRef(spec, ctx);
          if (value !== null) {
            out += value;
            i = cursor + 1;
            continue;
          }
          unresolved.add(`%~${spec}`);
        }
        out += ch;
        i += 1;
        continue;
      }
      if (/[0-9]/.test(text[i + 1] ?? '')) {
        // %0 = 脚本自身；%1..%9 = 运行时参数，静态不知道
        if (text[i + 1] === '0') {
          out += ctx.batFile;
        } else {
          out += `%${text[i + 1]}`;
          unresolved.add(`%${text[i + 1]}`);
        }
        i += 2;
        continue;
      }

      const end = text.indexOf('%', i + 1);
      if (end < 0) {
        out += ch; // 落单的 % 原样保留
        i++;
        continue;
      }
      const raw = text.slice(i + 1, end);
      if (!raw) {
        i = end + 1;
        continue;
      }
      const value = lookupEnv(raw, ctx);
      if (value !== undefined) {
        out += value;
      } else {
        out += `%${raw}%`;
        unresolved.add(raw);
      }
      i = end + 1;
      continue;
    }

    if (ch === '!' && ctx.delayedExpansion) {
      const end = text.indexOf('!', i + 1);
      if (end > i + 1) {
        const raw = text.slice(i + 1, end);
        const value = lookupEnv(raw, ctx);
        if (value !== undefined) {
          out += value;
          i = end + 1;
          continue;
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/** 命令名：去路径、去 .exe/.com、小写 */
function commandBase(token) {
  const base = path.basename(String(token ?? '')).toLowerCase();
  return base.replace(/\.(exe|com)$/i, '');
}

/**
 * 找一个可执行文件：
 *   - 绝对路径 → 原样
 *   - 带目录的相对路径 → 相对 cwd 解析
 *   - 裸命令名 → cwd 先找，再按 PATH 找（补 .exe/.cmd/.bat/.com）
 * 找不到也返回一个绝对路径：启动失败时错误信息才具体。
 */
async function resolveExecutable(token, cwd) {
  const raw = String(token ?? '');
  const cleaned = raw.replace(/^\.\//, '.\\');
  if (path.isAbsolute(cleaned)) return path.normalize(cleaned);
  if (/[\\/]/.test(cleaned)) return path.resolve(cwd, cleaned);

  const local = path.resolve(cwd, cleaned);
  for (const suffix of ['', '.exe', '.cmd', '.bat', '.com']) {
    if (await fileExists(local + suffix)) return local + suffix;
  }

  const pathDirs = String(process.env.PATH ?? process.env.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const suffix of ['', '.exe', '.cmd', '.bat', '.com']) {
      const candidate = path.join(dir, cleaned + suffix);
      if (await fileExists(candidate)) return candidate;
    }
  }
  return local;
}

/** powershell 的标准前置参数（这些 M2 起 ps1 时会再补，不算丢信息） */
function isStandardPsPreamble(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = String(tokens[i]).toLowerCase();
    if (token === '-executionpolicy' || token === '-exec' || token === '-ep') {
      i++; // 跳过它的值（Bypass / RemoteSigned）
      continue;
    }
    if (token === '-noprofile' || token === '-nologo' || token === '-noninteractive' || token === '-file' || token === '-f') {
      continue;
    }
    return false;
  }
  return true;
}

/** cd / pushd 的目标：跳过 /d 这类开关，取第一个剩下的 */
function extractCdTarget(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    const token = String(tokens[i]);
    if (token.startsWith('/')) continue;
    return token;
  }
  return null;
}

/**
 * 认出"这一行起的才是引擎"。
 * 返回 { kind, file, interpreter, engineArgs, ... } 或 null（这行不是启动命令）。
 */
async function analyzeLaunchLine(tokens, ctx, depth = 0) {
  const first = tokens[0];
  if (!first || depth > 2) return null;
  const base = commandBase(first);

  // cmd /c "x.bat --a" → 剥一层再看
  if (base === 'cmd') {
    const flag = String(tokens[1] ?? '').toLowerCase();
    if (flag === '/c' || flag === '/k' || flag === '/r') {
      if (tokens.length > 2) {
        const rest = tokens.slice(2);
        // `cmd /c "整条命令"` 时引号里是**一个 token**，cmd 会再解析一遍
        const inner = rest.length === 1 ? tokenizeCmd(rest[0]) : rest;
        return analyzeLaunchLine(inner, ctx, depth + 1);
      }
      return null;
    }
  }

  if (PYTHON_BASES.has(base)) {
    const scriptIndex = tokens.findIndex((token, i) => i > 0 && /\.py$/i.test(String(token)));
    if (scriptIndex < 0) return null;
    const between = tokens.slice(1, scriptIndex);
    const interpreter = await resolveExecutable(first, ctx.cwd);
    if (between.every((token) => !String(token).startsWith('-'))) {
      return {
        kind: 'py',
        file: path.resolve(ctx.cwd, tokens[scriptIndex]),
        interpreter,
        engineArgs: tokens.slice(scriptIndex + 1),
        argsStart: scriptIndex + 1,
        lineNo: ctx.lineNo,
        text: ctx.raw,
        note: `用 ${path.basename(interpreter)} 跑 ${path.basename(tokens[scriptIndex])}`
      };
    }
    // 解释器带参数（-u / -X utf8）→ 按 exe 起 python，参数不丢
    return {
      kind: 'exe',
      file: interpreter,
      interpreter: null,
      engineArgs: tokens.slice(1),
      argsStart: 1,
      lineNo: ctx.lineNo,
      text: ctx.raw,
      note: `解释器带参数（${between.join(' ')}），改按 exe 直接启动以保留这些参数`
    };
  }

  if (POWERSHELL_BASES.has(base)) {
    const scriptIndex = tokens.findIndex((token, i) => i > 0 && /\.ps1$/i.test(String(token)));
    if (scriptIndex < 0) return null;
    const interpreter = await resolveExecutable(first, ctx.cwd);
    if (isStandardPsPreamble(tokens.slice(1, scriptIndex))) {
      return {
        kind: 'ps1',
        file: path.resolve(ctx.cwd, tokens[scriptIndex]),
        interpreter,
        engineArgs: tokens.slice(scriptIndex + 1),
        argsStart: scriptIndex + 1,
        lineNo: ctx.lineNo,
        text: ctx.raw,
        note: null
      };
    }
    return {
      kind: 'exe',
      file: interpreter,
      interpreter: null,
      engineArgs: tokens.slice(1),
      argsStart: 1,
      lineNo: ctx.lineNo,
      text: ctx.raw,
      note: 'powershell 参数不是标准形式，改按 exe 直接启动以保留参数'
    };
  }

  const ext = path.extname(first).toLowerCase();
  const common = {
    lineNo: ctx.lineNo,
    text: ctx.raw,
    note: null
  };

  if (SCRIPT_EXTS.has(ext)) {
    return { ...common, kind: 'bat', file: await resolveExecutable(first, ctx.cwd), interpreter: null, engineArgs: tokens.slice(1), argsStart: 1 };
  }
  if (ext === '.ps1') {
    return { ...common, kind: 'ps1', file: await resolveExecutable(first, ctx.cwd), interpreter: null, engineArgs: tokens.slice(1), argsStart: 1, note: '没写解释器，按 powershell 处理' };
  }
  if (ext === '.py') {
    return { ...common, kind: 'py', file: await resolveExecutable(first, ctx.cwd), interpreter: null, engineArgs: tokens.slice(1), argsStart: 1, note: '没写解释器，按全局 python 处理' };
  }
  if (ext === '.sh') {
    return { ...common, kind: 'sh', file: await resolveExecutable(first, ctx.cwd), interpreter: null, engineArgs: tokens.slice(1), argsStart: 1 };
  }
  if (ext === '.exe' || ext === '.com' || ext === '') {
    return { ...common, kind: 'exe', file: await resolveExecutable(first, ctx.cwd), interpreter: null, engineArgs: tokens.slice(1), argsStart: 1 };
  }
  return {
    ...common,
    kind: 'exe',
    file: await resolveExecutable(first, ctx.cwd),
    interpreter: null,
    engineArgs: tokens.slice(1),
    argsStart: 1,
    note: `不认识的启动文件类型 ${ext}，按 exe 处理`
  };
}

/** `--flag=value` / `--flag value` 的键名 → 模板变量名 */
function slotKeyFor(flag, used) {
  let baseKey = MODEL_FLAGS.get(flag);
  if (!baseKey) {
    const cleaned = String(flag).replace(/^-+/, '');
    baseKey = cleaned.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase()) || 'file';
  }
  let key = baseKey;
  let n = 2;
  while (used.has(key)) key = `${baseKey}${n++}`;
  used.add(key);
  return key;
}

/**
 * 从启动参数里认出模型槽位和可调参数（→ argvTemplate 里的 `{xxx}`）。
 * 只把"确定能当变量"的四个（port / maxContext / host / 文件槽位）提成模板变量；
 * gpuLayers / threads 这类没有统一变量表的，原样留在 argv 里，避免模板变量名不被 M1 认。
 */
function extractLaunchParams(args) {
  const flags = [];
  const params = {};
  const templated = [];
  const slots = [];
  const replacements = [];
  const usedKeys = new Set();

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (typeof token !== 'string' || !token.startsWith('-') || token === '-' || token === '--') continue;

    const eq = token.indexOf('=');
    const inline = eq > 0;
    const flagText = inline ? token.slice(0, eq) : token;
    const flag = flagText.toLowerCase();

    let value = inline ? token.slice(eq + 1) : null;
    let valueIndex = inline ? i : null;
    if (!inline) {
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith('-')) {
        value = next;
        valueIndex = i + 1;
        i++; // 值已经消费
      }
    }

    const paramSpec = PARAM_FLAGS.get(flag);
    if (paramSpec && value !== null && valueIndex !== null) {
      let converted = value;
      if (paramSpec.type === 'int') {
        converted = Number(value);
        if (!Number.isInteger(converted)) {
          flags.push({ flag: flagText, value, note: '看着该是数字，没敢提成模板变量' });
          continue;
        }
      }
      flags.push({ flag: flagText, value });
      if (paramSpec.key in params) continue; // 同一个参数出现两次，听第一个
      params[paramSpec.key] = converted;
      if (paramSpec.templated === false) continue; // 只记录，不改模板
      templated.push(paramSpec.key);
      replacements.push({
        index: valueIndex,
        text: inline ? `${flagText}={${paramSpec.key}}` : `{${paramSpec.key}}`
      });
      continue;
    }

    const looksLikeModel = value !== null && (
      MODEL_FLAGS.has(flag) || MODEL_EXTS.has(path.extname(String(value)).toLowerCase())
    );
    if (looksLikeModel) {
      const key = slotKeyFor(flag, usedKeys);
      const kind = DIR_FLAGS.has(flag) ? 'dir' : 'file';
      slots.push({ key, flag: flagText, value, index: valueIndex, kind });
      replacements.push({
        index: valueIndex,
        text: inline ? `${flagText}={${key}}` : `{${key}}`
      });
      flags.push({ flag: flagText, value });
      continue;
    }

    flags.push({ flag: flagText, value });
  }

  return { flags, params, templated, slots, replacements };
}

/**
 * 解析一个 `.bat` / `.cmd`。
 *
 * 返回值里最重要的两个字段：
 *   - `ok`    能否拆成 argv（false 就只能原样运行）
 *   - `unsupported[]`  转不过去的行（severity: 'blocker' 不能拆 / 'skipped' 切换后不执行）
 *
 * @param {string} file bat 绝对/相对路径
 * @returns {Promise<object>}
 */
export async function parseBat(file) {
  if (!file) throw new TypeError('parseBat 需要一个 .bat / .cmd 路径');

  const batFile = path.resolve(String(file));
  const stat = await fsp.stat(batFile).catch(() => null);
  if (!stat || !stat.isFile()) {
    const err = new Error(`找不到脚本：${batFile}`);
    err.code = 'ENOENT';
    throw err;
  }

  const { text, encoding } = decodeText(await fsp.readFile(batFile));
  const batDir = path.dirname(batFile);
  const lines = text.split(/\r?\n/);

  const envMap = new Map(); // 小写变量名 → { name, value }
  const allUnresolved = new Set(); // 影响启动的未展开变量（只收 set / cd / 启动命令上的）
  const notes = [];
  const unsupported = [];
  const ignored = [];
  // 只认真正会执行的 setlocal 行，别被注释里的 "enable delayed expansion" 误伤
  let delayedExpansion = lines.some(
    (line) => !/^\s*(::|@?rem(\s|$))/i.test(line) && /enabledelayedexpansion/i.test(line)
  );
  let cwd = batDir; // 双击 bat 的初始目录
  const dirStack = [];
  let launch = null;
  let lineCount = lines.length;

  const note = (message) => {
    if (message && !notes.includes(message)) notes.push(message);
  };
  const addUnsupported = (lineNo, raw, reason, severity) => {
    unsupported.push({ lineNo, text: raw, reason, severity });
  };

  if (delayedExpansion) {
    note('脚本开了延迟展开（EnableDelayedExpansion）：!VAR! 按"最后已知值"替换，运行时才赋值的可能不准');
  }

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    let line = lines[index] ?? '';

    while (endsWithContinuation(line) && index + 1 < lines.length) {
      line = line.replace(/\s+$/, '').replace(/\^$/, '') + ' ' + (lines[++index] ?? '');
    }

    const raw = line.trim();
    if (!raw) continue;
    if (/^::/.test(raw)) continue;
    if (/^rem(\s|$)/i.test(raw)) continue;
    if (/^@rem(\s|$)/i.test(raw)) continue;

    let body = raw.replace(/^@+/, '').trim();
    if (!body) continue;
    if (body.startsWith(':')) {
      ignored.push({ lineNo, text: raw, reason: '标签（:label）' });
      continue;
    }
    if (body.startsWith('(')) {
      addUnsupported(lineNo, raw, '多行 if / for 块', 'blocker');
      continue;
    }
    if (hasRedirection(body)) {
      addUnsupported(lineNo, raw, '重定向（写文件）——切换后不会执行', 'skipped');
      continue;
    }

    const chain = splitCommandChain(body);
    if (chain.piped) {
      addUnsupported(lineNo, raw, '管道（|），拆不了', 'blocker');
      continue;
    }
    if (chain.hasOr) {
      addUnsupported(lineNo, raw, '条件执行（||），拆不了', 'blocker');
    }

    for (const part of chain.parts) {
      const command = part.trim().replace(/^@+/, '');
      if (!command) continue;

      // 每条命令单独记未展开变量：只有启动命令里的才算"不能拆"
      const lineUnresolved = new Set();
      const expanded = expandVars(command, {
        batFile,
        batDir,
        envMap,
        delayedExpansion,
        unresolved: lineUnresolved,
        getCwd: () => cwd
      });
      const tokens = tokenizeCmd(expanded);
      if (tokens.length === 0) continue;
      const base = commandBase(tokens[0]);

      // ---- set：改 env ----
      if (base === 'set') {
        if (/^set\s+\/p\b/i.test(expanded)) {
          addUnsupported(lineNo, raw, 'set /p：会停下来等用户输入', 'blocker');
          continue;
        }
        if (/^set\s+\/a\b/i.test(expanded)) {
          addUnsupported(lineNo, raw, 'set /a：算术运算，静态算不出来', 'blocker');
          continue;
        }
        let rest = expanded.replace(/^set\b/i, '').trim();
        if (!rest) {
          ignored.push({ lineNo, text: raw, reason: 'set（只列变量）' });
          continue;
        }
        if (rest.startsWith('"')) {
          const close = rest.lastIndexOf('"');
          rest = close > 0 ? rest.slice(1, close) : rest.slice(1);
        }
        const eq = rest.indexOf('=');
        if (eq < 0) {
          ignored.push({ lineNo, text: raw, reason: 'set（查询变量）' });
          continue;
        }
        const name = rest.slice(0, eq).trim();
        const value = rest.slice(eq + 1);
        if (!name) {
          ignored.push({ lineNo, text: raw, reason: 'set' });
          continue;
        }
        envMap.set(name.toLowerCase(), { name, value });
        if (lineUnresolved.size > 0) {
          for (const item of lineUnresolved) allUnresolved.add(item);
          note(`变量 ${name} 的值里有展开不了的变量：${[...lineUnresolved].join(' / ')}`);
        }
        continue;
      }

      if (base === 'setlocal' || base === 'endlocal') {
        ignored.push({ lineNo, text: raw, reason: base });
        continue;
      }

      // `path C:\x;%PATH%` 改的是 PATH，不是无害打印
      if (base === 'path') {
        const value = expanded.replace(/^path\b/i, '').trim();
        if (value) {
          envMap.set('path', { name: 'PATH', value });
          if (lineUnresolved.size > 0) {
            for (const item of lineUnresolved) allUnresolved.add(item);
            note(`PATH 的值里有展开不了的变量：${[...lineUnresolved].join(' / ')}`);
          }
        }
        ignored.push({ lineNo, text: raw, reason: 'path' });
        continue;
      }

      // ---- cd / pushd / popd：改 cwd ----
      if (base === 'cd' || base === 'chdir') {
        const target = extractCdTarget(tokens);
        if (!target) {
          ignored.push({ lineNo, text: raw, reason: 'cd（只打印当前目录）' });
          continue;
        }
        if (lineUnresolved.size > 0) note(`cd 的路径里有展开不了的变量：${[...lineUnresolved].join(' / ')}`);
        for (const item of lineUnresolved) allUnresolved.add(item);
        const resolved = stripTrailingSep(path.resolve(cwd, target));
        if (!(await dirExists(resolved))) note(`cd 切到的目录不存在：${resolved}（试启动会在这里失败）`);
        cwd = resolved;
        continue;
      }

      if (base === 'pushd') {
        const target = extractCdTarget(tokens);
        if (target) {
          dirStack.push(cwd);
          const resolved = stripTrailingSep(path.resolve(cwd, target));
          if (!(await dirExists(resolved))) note(`pushd 切到的目录不存在：${resolved}`);
          cwd = resolved;
        }
        continue;
      }

      if (base === 'popd') {
        if (dirStack.length > 0) cwd = dirStack.pop();
        else note('popd 没有配对的 pushd');
        continue;
      }

      // ---- 控制流：不能拆 ----
      if (BLOCKING_COMMANDS.has(base)) {
        const reasons = {
          if: 'if 分支（判断显卡 / 文件 / 错误码）',
          else: 'else 分支',
          for: 'for 循环',
          call: 'call 调用其它脚本 / 标签',
          choice: 'choice 菜单（会停下来等输入）',
          goto: 'goto 跳转',
          start: 'start 另开窗口 / 进程，试启动跟踪不到'
        };
        addUnsupported(lineNo, raw, reasons[base] ?? base, 'blocker');
        continue;
      }

      // ---- 无害内建 ----
      if (base === 'echo' || BENIGN_BUILTINS.has(base)) {
        ignored.push({ lineNo, text: raw, reason: base });
        continue;
      }

      // ---- 解释器只用来做安装/解压之类的，不是引擎 ----
      if (PYTHON_BASES.has(base) && !tokens.some((token, i) => i > 0 && /\.py$/i.test(String(token)))) {
        addUnsupported(lineNo, raw, '用 python 跑安装 / 模块（辅助命令），切换后不会执行', 'skipped');
        continue;
      }
      if (POWERSHELL_BASES.has(base) && !tokens.some((token, i) => i > 0 && /\.ps1$/i.test(String(token)))) {
        addUnsupported(lineNo, raw, '用 powershell 跑安装 / 解压等（辅助命令），切换后不会执行', 'skipped');
        continue;
      }

      // ---- 辅助命令 ----
      if (UTILITY_COMMANDS.has(base)) {
        addUnsupported(lineNo, raw, `辅助命令（${base}）——切换后不会执行`, 'skipped');
        continue;
      }
      if (PACKAGE_MANAGER_COMMANDS.has(base)) {
        addUnsupported(lineNo, raw, `包管理器 / 安装命令（${base}）——不是引擎，切换后不会执行`, 'skipped');
        continue;
      }
      if (/^(setup|install|installer|uninstall|update|updater|vc_redist.*|dxsetup|dotnet|python-.*|ffmpeg)$/i.test(base)) {
        addUnsupported(lineNo, raw, `安装 / 运行库程序（${base}）——不是引擎，切换后不会执行`, 'skipped');
        continue;
      }

      // ---- 启动命令 ----
      if (!launch) {
        const candidate = await analyzeLaunchLine(tokens, { cwd, lineNo, raw });
        if (!candidate) {
          addUnsupported(lineNo, raw, '认不出这一行起的什么，切换后不会执行', 'skipped');
          continue;
        }
        launch = candidate;
        // 引擎的 cwd / env 要用"启动那一刻"的值：脚本在启动之后再 cd / set，对已经起来的进程没影响
        candidate.cwdAtLaunch = cwd;
        candidate.envAtLaunch = Object.fromEntries([...envMap.values()].map((item) => [item.name, item.value]));
        if (candidate.note) note(candidate.note);
        if (lineUnresolved.size > 0) {
          for (const item of lineUnresolved) allUnresolved.add(item);
          addUnsupported(lineNo, raw, `启动命令里有展开不了的变量：${[...lineUnresolved].join(' / ')}`, 'blocker');
        }
        continue;
      }

      // 已经有了启动命令，后面的命令在新方式里都不会执行
      addUnsupported(lineNo, raw, '第二条命令——按参数运行后不会执行', 'skipped');
    }
  }

  // ---- 组装结果 ----
  const blockers = unsupported.filter((item) => item.severity === 'blocker');
  const skipped = unsupported.filter((item) => item.severity === 'skipped');

  let argv = [];
  let argvTemplate = [];
  let params = {};
  let templated = [];
  let slots = [];
  let flags = [];
  let preview = null;

  if (launch) {
    argv = launch.engineArgs.slice();
    const extracted = extractLaunchParams(argv);
    params = extracted.params;
    templated = extracted.templated;
    slots = extracted.slots;
    flags = extracted.flags;
    argvTemplate = argv.slice();
    for (const replacement of extracted.replacements) {
      if (replacement.index >= 0 && replacement.index < argvTemplate.length) {
        argvTemplate[replacement.index] = replacement.text;
      }
    }
    const spec = buildSpawnCommand(
      { kind: launch.kind, file: launch.file, interpreter: launch.interpreter, mode: 'custom' },
      argv
    );
    preview = spec.error ? null : displayCommandLine(spec);
  }

  const missingFiles = [];
  if (launch) {
    if (!(await fileExists(launch.file))) missingFiles.push(launch.file);
    if (launch.interpreter && !(await fileExists(launch.interpreter))) missingFiles.push(launch.interpreter);
  }
  if (missingFiles.length > 0) {
    note(`启动文件不存在：${missingFiles.join('；')}——包可能没解压全，或者脚本里写的是相对路径`);
  }

  const ok = Boolean(launch) && blockers.length === 0;
  let reason = '解析成功，可以改成「按参数运行」';
  if (!launch) {
    reason = '没找到启动命令行——只能原样运行';
  } else if (blockers.length > 0) {
    const kinds = [...new Set(blockers.map((item) => item.reason))];
    reason = `不能拆：${kinds.join('；')}`;
  }

  const scriptExt = path.extname(batFile).toLowerCase();
  const fileSlots = slots.map((slot, index) => ({
    key: slot.key,
    label: index === 0 ? '模型文件' : slot.flag,
    kind: slot.kind
    // 故意不写 arg：D2 规定有 arg 的槽位由系统自动拼、模板里不许再出现。
    // 导入草稿把 `--native {native}` 整对留在模板里更直白，用户看得懂也改得动。
  }));

  // 引擎实际启动时的 cwd / env（启动之后再改的不影响已经起来的进程）
  const launchCwd = launch?.cwdAtLaunch ?? cwd;
  const launchEnv = launch?.envAtLaunch
    ?? Object.fromEntries([...envMap.values()].map((item) => [item.name, item.value]));

  // 槽位在 bat 里写死的值（相对路径按"启动那一刻"的 cwd 解析），用于导入草稿的 files
  const slotValues = {};
  for (const slot of slots) {
    const raw = String(slot.value ?? '');
    if (!raw) continue;
    slotValues[slot.key] = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(launchCwd, raw);
  }

  return {
    ok,
    mode: ok ? 'custom' : 'package',
    reason,
    file: batFile,
    dir: batDir,
    encoding,
    lineCount,
    script: { file: batFile, dir: batDir, kind: scriptExt === '.cmd' ? 'cmd' : 'bat' },
    target: launch
      ? {
          kind: launch.kind,
          file: launch.file,
          interpreter: launch.interpreter,
          argv,
          lineNo: launch.lineNo,
          text: launch.text
        }
      : null,
    launched: Boolean(launch),
    launchLine: launch ? { lineNo: launch.lineNo, text: launch.text } : null,
    argv,
    argvTemplate,
    params,
    templated,
    fileSlots,
    slotValues,
    flags,
    env: launchEnv,
    cwd: launchCwd,
    unsupported,
    blockers,
    skipped,
    ignored,
    notes,
    missingFiles,
    preview,
    variables: { unresolved: [...allUnresolved] }
  };
}

// ===========================================================================
// 5. 启动命令构造（预览 / 试启动共用）
// ===========================================================================

/** 按扩展名推断 kind（§5.4：.exe 直接起、.bat/.cmd 走 cmd.exe …） */
export function inferKind(file) {
  const ext = path.extname(String(file ?? '')).toLowerCase();
  if (ext === '.bat' || ext === '.cmd') return 'bat';
  if (ext === '.ps1') return 'ps1';
  if (ext === '.py') return 'py';
  if (ext === '.sh') return 'sh';
  return 'exe';
}

/**
 * 把一个引擎 + 参数数组变成"真能 spawn 的 command/args"。
 * 返回 { command, args, verbatim } 或 { error }。
 *
 * 关键点：bat 必须经 `cmd.exe /d /s /c`，并且整条命令再包一层引号，
 * 否则路径里有空格时 cmd 会把引号吃掉（`/s` 的语义就是"只剥最外层引号"）。
 */
export function buildSpawnCommand(engine, argv = []) {
  if (!engine || !engine.file) return { error: '没有启动文件（engine.file 为空）' };
  const kind = engine.kind ?? inferKind(engine.file);
  const rawFile = String(engine.file);
  const file = path.isAbsolute(rawFile)
    ? path.normalize(rawFile)
    : path.resolve(engine.cwd ?? process.cwd(), rawFile);
  const isPackage = engine.mode === 'package';
  const args = isPackage ? [] : (Array.isArray(argv) ? argv.map((item) => String(item)) : []);

  if (kind === 'exe') {
    return { kind, command: file, args, verbatim: false };
  }

  if (kind === 'bat') {
    const inner = [quoteWin(file), ...args.map(quoteWin)].join(' ');
    return { kind, command: comspec(), args: ['/d', '/s', '/c', `"${inner}"`], verbatim: true };
  }

  if (kind === 'ps1') {
    const interpreter = engine.interpreter || 'powershell.exe';
    return {
      kind,
      command: interpreter,
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      verbatim: false
    };
  }

  if (kind === 'py') {
    const interpreter = engine.interpreter || 'python';
    return { kind, command: interpreter, args: [file, ...args], verbatim: false };
  }

  if (kind === 'sh') {
    // §5.4：.sh 仅 WSL / Git Bash，默认不启用
    return { error: '.sh 引擎默认不启用（需要 WSL / Git Bash）；请用 .bat 包一层' };
  }

  return { error: `不支持的启动方式：${kind}` };
}

/** 给人看的完整命令行 */
export function displayCommandLine(spec) {
  if (!spec || spec.error) return spec?.error ?? '';
  return [spec.command, ...(spec.args ?? [])].join(' ');
}

/**
 * 渲染 `argv` 模板（M2 的 custom 拼法，这里实现一份给"预览 / 试启动"用）：
 *   1. 有 `arg` 的槽位先拼成 `--flag <path>`，值为空就整对跳过
 *   2. 再替换模板里的 `{key}` `{port}` `{host}` `{modelId}` `{params.*}`
 * 返回 unresolved（模板里没有值的变量名）。
 */
export function renderArgv(engine, model = {}, options = {}) {
  const port = firstInteger(options.port, model.port, engine.defaultPort, DEFAULT_ENGINE_PORT);
  const host = options.host ?? '127.0.0.1';
  const modelId = options.modelId ?? model.engineModelId ?? model.id ?? engine.id ?? 'model';
  const files = model.files ?? {};
  const params = model.params ?? {};
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots : [];
  const unresolved = [];
  const out = [];

  for (const slot of slots) {
    if (!slot?.arg) continue;
    const value = files[slot.key];
    if (value === undefined || value === null || value === '') continue;
    out.push(...String(slot.arg).split(/\s+/).filter(Boolean), String(value));
  }

  const vars = { port, host, modelId, ...files, ...params };
  const template = Array.isArray(engine.argv) ? engine.argv : [];
  for (const raw of template) {
    out.push(replaceVariables(String(raw), vars, unresolved));
  }

  return { argv: out, unresolved, port, host, modelId };
}

function replaceVariables(text, vars, unresolved) {
  return text.replace(/\{([A-Za-z_][\w.]*)\}/g, (whole, name) => {
    let value;
    if (name.startsWith('params.')) value = vars[name.slice('params.'.length)];
    else if (Object.prototype.hasOwnProperty.call(vars, name)) value = vars[name];

    if (value === undefined || value === null) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return ''; // 预览里先空着，错误由 previewCommand 报
    }
    return String(value);
  });
}

/** 模板里合法的变量名（用于 §5.4.1 的"你是不是想写 xxx"） */
function knownVariableNames(engine, model) {
  const known = new Set(['port', 'host', 'modelId']);
  for (const slot of engine.fileSlots ?? []) {
    if (slot?.key) known.add(String(slot.key));
  }
  for (const key of Object.keys(model.params ?? {})) {
    known.add(key);
    known.add(`params.${key}`);
  }
  return known;
}

function levenshtein(a, b) {
  const left = String(a);
  const right = String(b);
  const rows = Array.from({ length: left.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= right.length; j++) rows[0][j] = j;
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
  }
  return rows[left.length][right.length];
}

function suggestVariableName(name, known) {
  const lower = String(name).toLowerCase();
  for (const candidate of known) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  let best = null;
  let bestDistance = 3; // 编辑距离 ≤ 2 才提示
  for (const candidate of known) {
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 保存前"拿空模型把模板跑一遍"（§5.4.1）：
 *   - `{xxx}` 不存在 → 标红那一行（带"你是不是想写"）
 *   - 有 arg 的槽位出现在模板里 / 无 arg 的槽位没出现 → 报错（D2）
 *   - 声明是数字的参数给了文字 → 拒绝
 *
 * 注意：M1 的 validateEngine / validateModel 才是权威；这里只是**保存前干跑**，
 * 让用户先在界面上看到"最终会执行什么命令"，不是替代 M1 校验。
 */
export function previewCommand(engine, model = {}, options = {}) {
  const errors = [];
  const warnings = [];

  if (!engine?.file) {
    return {
      ok: false,
      mode: engine?.mode ?? 'custom',
      argv: [],
      commandLine: null,
      errors: [{ field: 'file', message: '还没有选启动文件' }],
      warnings,
      unresolved: []
    };
  }

  if (engine.mode === 'package') {
    const spec = buildSpawnCommand(engine, []);
    return {
      ok: !spec.error,
      mode: 'package',
      argv: [],
      commandLine: spec.error ? null : displayCommandLine(spec),
      errors: spec.error ? [{ field: 'file', message: spec.error }] : [],
      warnings,
      unresolved: []
    };
  }

  const rendered = renderArgv(engine, model, { port: options.port, host: options.host });
  const known = knownVariableNames(engine, model);
  const slotMap = new Map((engine.fileSlots ?? []).map((slot) => [slot.key, slot]));

  for (const name of rendered.unresolved) {
    const slot = slotMap.get(name);
    // 可选槽位留空不是错误：模板里的 {tokenizer} 会变成空，M2 拼出来的就是空参数
    if (slot?.optional && !(model.files?.[name])) {
      warnings.push(`可选槽位「${slot.label ?? name}」没填，{${name}} 会变成空`);
      continue;
    }
    const suggestion = suggestVariableName(name, known);
    errors.push({
      field: name,
      message: `模板里的 {${name}} 没有值`,
      suggestions: suggestion ? [suggestion] : []
    });
  }

  // D2：有 arg 的槽位自动拼，模板里不许出现；无 arg 的必须在模板里出现一次
  const templateText = (engine.argv ?? []).join(' ');
  for (const slot of engine.fileSlots ?? []) {
    if (!slot?.key) continue;
    const hasToken = new RegExp(`\\{${escapeRegExp(slot.key)}\\}`).test(templateText);
    if (slot.arg) {
      if (hasToken) errors.push({ field: slot.key, message: `{${slot.key}} 是自动拼的（槽位有 arg），模板里删掉它` });
    } else if (!hasToken) {
      errors.push({ field: slot.key, message: `模板里没有 {${slot.key}}，引擎不知道「${slot.label ?? slot.key}」在哪` });
    }
  }

  for (const [key, value] of Object.entries(model.params ?? {})) {
    if (!NUMERIC_PARAMS.has(key)) continue;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isFinite(Number(value))) {
      errors.push({ field: `params.${key}`, message: `${key} 应该是数字，现在是「${value}」` });
    }
  }

  for (const [key, value] of Object.entries(model.files ?? {})) {
    if (typeof value === 'string' && value && !path.isAbsolute(value)) {
      warnings.push(`{${key}} 是相对路径，启动时会按引擎的 cwd 解析：${value}`);
    }
  }

  const spec = buildSpawnCommand(engine, rendered.argv);
  if (spec.error) errors.push({ field: 'file', message: spec.error });

  return {
    ok: errors.length === 0,
    mode: 'custom',
    argv: rendered.argv,
    commandLine: spec.error ? null : displayCommandLine(spec),
    errors,
    warnings,
    unresolved: rendered.unresolved
  };
}

// ===========================================================================
// 6. 导入草稿：扫描结果 + bat 解析 → 一条能保存的引擎 + 模型
// ===========================================================================

/**
 * 启动命令里是不是 `--config <strata 形状的 json>`。
 *
 * 这种包（Strata 的 python 启动器）参数全在那份 JSON 里：按 custom 导入的话
 * 命令行写的是 --config，模型档案里的参数一个都进不去。导入时改成「原样运行」，
 * 界面才会走"读写那份配置文件"的通道。
 */
export async function detectConfigBackedLaunch(parsed) {
  const argv = Array.isArray(parsed && parsed.argvTemplate) ? parsed.argvTemplate.map(String) : [];
  let ref = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config' && i + 1 < argv.length) { ref = argv[i + 1]; break; }
    if (argv[i].startsWith('--config=')) { ref = argv[i].slice('--config='.length); break; }
  }
  if (!ref || ref.startsWith('{')) return null;
  const base = parsed.cwd || parsed.dir || '';
  const file = path.isAbsolute(ref) ? ref : path.resolve(base, ref);
  const raw = await fsp.readFile(file, 'utf8')
    .then((text) => JSON.parse(text.replace(/^\uFEFF/, '')))
    .catch(() => null);
  if (!looksLikeStrataConfig(raw)) return null;
  return { file, raw };
}

/**
 * 把 scanPackage 的结果变成 { engine, model } 草稿（**不写盘**，保存交给 M6 + M1）。
 *
 * mode 规则：
 *   - bat 拆得开 → 默认 custom（任务书：「按参数运行」是默认）；拆不开 → package
 *   - 想强制原样运行传 `{ mode: 'package' }`
 *   - **不管哪种模式，files / params / argv 都照样填**——§5.4.2 要求 package ↔ custom
 *     来回切时不能丢东西。
 *
 * @param {object} scan scanPackage 的返回值
 * @param {object} [opts] { script, modelFile, mode, registry, readManifest, id, label, params }
 */
export async function buildDraft(scan, opts = {}) {
  if (!scan || !scan.dir) throw new TypeError('buildDraft 需要 scanPackage 的结果');

  const registry = opts.registry ?? (await loadRegistry());
  const taken = await takenIds(registry);

  const scriptPath = typeof opts.script === 'string'
    ? opts.script
    : (opts.script?.path ?? scan.script?.path ?? null);
  // 用户明确选的模型 > 扫描到的最大的那个；但两者都不能覆盖 bat 里写死的模型路径
  const explicitModelFile = typeof opts.modelFile === 'string' ? opts.modelFile : null;
  const discoveredModelFile = scan.model?.path ?? null;
  const modelFile = explicitModelFile ?? discoveredModelFile;

  const parsed = scriptPath ? await parseBat(scriptPath) : null;
  const warnings = [];
  const blockers = [];

  let mode;
  let kind;
  let file;
  let interpreter = null;
  let argvTemplate = [];
  let fileSlots = [];
  let env = {};
  let cwd = scan.dir;
  let sourceScript = scriptPath;
  const slotValues = {};
  let configBacked = null;
  let reasoningCap = null;

  if (parsed) {
    warnings.push(...parsed.notes);
    if (!opts.script && (scan.scripts?.length ?? 0) > 1) {
      warnings.push(`找到 ${scan.scripts.length} 个启动脚本，先按「${path.basename(scriptPath)}」处理——让用户确认`);
    }

    const wantsPackage = opts.mode === 'package';
    // bat 里直接跑 .sh：LACI 的 sh 引擎默认不启用（§5.4），先保持原样运行更稳
    const shTarget = parsed.ok && parsed.target?.kind === 'sh';
    /* 启动命令里带 --config <JSON>：参数全在那份 JSON 里，按 custom 导入的话
       命令行跟模型档案对不上（改什么都不生效）。这种包直接按「原样运行 + 配置文件」导入。 */
    configBacked = parsed.ok ? await detectConfigBackedLaunch(parsed) : null;
    if (wantsPackage || !parsed.ok || shTarget || configBacked) {
      // 原样运行：file 就是 bat 本身
      mode = 'package';
      kind = 'bat';
      file = parsed.script.file;
      if (!parsed.ok) blockers.push(parsed.reason);
      else if (shTarget) warnings.push('bat 里直接跑 .sh，LACI 默认不启用 sh 引擎，先保持原样运行');
      else if (configBacked) {
        warnings.push(`参数都在 ${path.basename(configBacked.file)} 里：按「原样运行」导入，模型配置里改的参数会写回那份 JSON`);
      } else warnings.push('按你的选择用「原样运行」——参数先不生效，之后可以切到「按参数运行」');
    } else {
      mode = 'custom';
      kind = parsed.target.kind;
      file = parsed.target.file;
      interpreter = parsed.target.interpreter;
    }

    if (configBacked) {
      /* 导入时就把"思考等级能不能写"探测出来，存进引擎档案：
         换台电脑导入同一个包，能力跟着包走，不用界面再猜。 */
      reasoningCap = await detectReasoningCapability({ cwd: parsed.cwd }, configBacked.file, configBacked.raw);
    }

    // 两种模式都保留这些——切回来不用重读 bat
    argvTemplate = parsed.argvTemplate;
    fileSlots = parsed.fileSlots;
    env = parsed.env;
    cwd = parsed.cwd;
    Object.assign(slotValues, parsed.slotValues ?? {});

    if (!parsed.ok) {
      warnings.push('这个 bat 拆不开，先用「原样运行」；参数可以以后在模型配置里手动填');
    } else if (parsed.skipped.length > 0) {
      warnings.push(`bat 里有 ${parsed.skipped.length} 行是辅助命令，改成「按参数运行」后不会执行，切换前要让用户确认`);
    }
    if (parsed.target?.lineNo) {
      warnings.push(`启动命令在第 ${parsed.target.lineNo} 行`);
    }
  } else if (scan.engine) {
    mode = opts.mode === 'package' ? 'package' : 'custom';
    kind = 'exe';
    file = scan.engine.path;
    // 没有脚本就猜不了参数：给最小可用模板 + 明确告诉用户要补
    argvTemplate = ['{model}'];
    fileSlots = [{ key: 'model', label: '模型文件', kind: 'file' }];
    warnings.push('没有启动脚本，只找到 .exe：参数模板先放了 {model}，请按引擎文档补全（导入后还能改）');
  } else {
    const err = new Error('这个文件夹里没有能当引擎的东西（既没有 .bat/.cmd，也没有 .exe）');
    err.code = 'CANT_IMPORT';
    throw err;
  }

  // ---- 模型文件：bat 里认出来的优先，其次扫描到的最大的一个 ----
  const primarySlot = fileSlots[0] ?? null;
  const primaryKey = primarySlot?.key ?? 'model';
  const files = { ...slotValues };
  if (modelFile) {
    if (fileSlots.length === 0) {
      warnings.push('这个 bat 的命令行里没有模型路径，模型文件先不填进槽位（原样运行由脚本自己找）');
    } else if (explicitModelFile || !files[primaryKey]) {
      files[primaryKey] = modelFile;
    } else if (path.resolve(files[primaryKey]) !== path.resolve(modelFile)) {
      // bat 里指定了具体模型，就不要被"包里最大的那个"覆盖
      warnings.push(`bat 里指定的是 ${path.basename(files[primaryKey])}，没有用包里最大的 ${path.basename(modelFile)}`);
    }
  }
  if (Object.keys(files).length === 0 && scan.models.length > 0) {
    warnings.push('包里有模型文件，但启动命令没引用它们——多半是脚本自己按名字找，保持原样运行即可');
  }

  // ---- 端口 ----
  const parsedPort = Number.isInteger(parsed?.params?.port) ? parsed.params.port : null;
  const defaultPort = firstInteger(opts.defaultPort, parsedPort, DEFAULT_ENGINE_PORT);

  // ---- id ----
  const engineBase = slugify(
    opts.id ?? path.basename(scan.dir) ?? path.basename(file ?? '', path.extname(file ?? '')),
    'engine'
  );
  const engineId = uniqueId(engineBase, taken.engines);

  // 模型命名跟着"实际填进槽位的那个文件"，别跟着包里最大的那个（两者可能不是同一个）
  const effectiveModelFile = files[primaryKey] ?? modelFile ?? null;
  const modelLabelSource = effectiveModelFile
    ? path.basename(effectiveModelFile, path.extname(effectiveModelFile))
    : `${path.basename(scan.dir)} 模型`;
  const modelBase = slugify(modelLabelSource, `${engineId}-model`);
  const modelId = uniqueId(modelBase, taken.models);

  // ---- caps：.ninfer 的 manifest 由外部读（格式不归 M3 管），这里只留接口 ----
  let caps = { mtp: false, vision: false, tools: null };
  if (typeof opts.readManifest === 'function' && modelFile && /\.ninfer$/i.test(modelFile)) {
    try {
      const manifest = await opts.readManifest(modelFile);
      if (manifest?.caps && typeof manifest.caps === 'object') {
        caps = { ...caps, ...manifest.caps };
      }
    } catch {
      warnings.push('读 .ninfer 的 manifest 失败：caps 先留默认值，导入后可以手填');
    }
  }

  // ---- 模型参数：只把 bat 里明确写了的 maxContext 带过来，其余交给用户 ----
  const params = {};
  if (Number.isInteger(parsed?.params?.maxContext)) params.maxContext = parsed.params.maxContext;
  Object.assign(params, opts.params ?? {});

  const engine = {
    id: engineId,
    label: opts.label ?? path.basename(scan.dir) ?? engineId,
    mode,
    kind,
    file,
    cwd,
    interpreter,
    defaultPort,
    fileSlots,
    argv: argvTemplate,
    env,
    middlewares: [],
    webUI: null,
    footprintLog: null,
    ready: {
      url: `http://127.0.0.1:{port}/v1/models`,
      timeoutMs: 300_000,
      intervalMs: 900
    },
    stop: { method: 'kill-tree', graceMs: 5_000 },
    multiInstance: false,
    why: sourceScript
      ? `从整合包导入：${path.basename(scan.dir)}（启动脚本 ${path.basename(sourceScript)}）`
      : `从整合包导入：${path.basename(scan.dir)}`
  };

  // 切换 package ↔ custom 时要能找回那个 bat：mode=package 时 file 是 bat，
  // mode=custom 时 file 是 bat 里真正起的 exe，两者不是同一个路径。
  // 这是 M3 提议的**附加字段**，M1 校验如果不认，就由前端在向导里自己记着。
  if (sourceScript) engine.sourceScript = sourceScript;
  /* 导入时探测到的思考能力：写进档案，换台电脑导入同一个包也认得 */
  if (reasoningCap) {
    engine.reasoning = {
      mode: reasoningCap.mode,
      key: reasoningCap.key,
      budgetKey: reasoningCap.budgetKey,
      levels: reasoningCap.levels,
    };
  }

  const model = {
    id: modelId,
    label: opts.modelLabel ?? modelLabelSource,
    kind: opts.modelKind ?? 'chat',
    engineId: engine.id,
    files,
    port: parsedPort, // 模型继承引擎端口；这里把 bat 里写死的端口记下来
    caps,
    params,
    thinking: {
      effort: configBacked && typeof configBacked.raw[REASONING_EFFORT_KEY] === 'string'
        ? configBacked.raw[REASONING_EFFORT_KEY]
        : 'none',
      budget: configBacked && Number.isFinite(Number(configBacked.raw[REASONING_BUDGET_KEY]))
        ? Number(configBacked.raw[REASONING_BUDGET_KEY])
        : 512,
      allowRequestOverride: false,
    },
    extraArgs: [],
    engineModelId: null,
    footprint: null
  };

  warnings.push('保存前记得点「试启动」：参数是猜的，能起来才算数（§5.4.2）');

  return {
    engine,
    model,
    mode,
    warnings,
    blockers,
    parsed,
    scan,
    sourceScript,
    discoveredModelFile: modelFile
  };
}

/**
 * 试启动成功后把探测结果写回草稿。
 * M6 在 probe 返回 ok 后调一下就行，避免各处自己抄字段抄漏。
 */
export function applyProbeResult(engine, model, result) {
  if (!result?.ok || !Number.isInteger(result.port)) {
    return { engine, model, applied: false };
  }
  const nextEngine = { ...engine, defaultPort: result.port };
  if (result.readyTemplate) {
    nextEngine.ready = { ...(engine.ready ?? {}), url: result.readyTemplate };
  }
  const nextModel = { ...model, port: result.port };
  if (result.caps && Object.prototype.hasOwnProperty.call(result.caps, 'tools')) {
    nextModel.caps = { ...(model.caps ?? {}), tools: result.caps.tools };
  }
  return { engine: nextEngine, model: nextModel, applied: true };
}

// ===========================================================================
// 7. 端口：netstat 差集 + 日志线索
// ===========================================================================

function execFileP(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10_000, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = String(stdout ?? '');
          err.stderr = String(stderr ?? '');
          reject(err);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

function addressPort(address) {
  const text = String(address ?? '');
  const index = text.lastIndexOf(':');
  if (index < 0) return null;
  const port = Number(text.slice(index + 1));
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/**
 * 当前所有 LISTENING 的 TCP 端口 → Map<port, Set<pid>>。
 * 试启动靠"启动前 / 启动后两次快照的差集"找新端口（§5.5）。
 */
export async function listListeningPorts() {
  const { stdout } = await execFileP('netstat', ['-ano', '-p', 'tcp']);
  const map = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(TCP|TCPv6)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    const local = match[2];
    const remote = match[3];
    const state = match[4];
    const pid = Number(match[5]);

    // 中文 Windows 的 netstat 状态列有时也本地化；远端端口是 :0 同样只可能是监听态
    const listening = /LISTEN/i.test(state) || /侦听|监听/.test(state) || /:0$/.test(remote);
    if (!listening) continue;

    const port = addressPort(local);
    if (!port) continue;

    if (!map.has(port)) map.set(port, new Set());
    if (Number.isInteger(pid)) map.get(port).add(pid);
  }

  return map;
}

/**
 * 从日志行里捞端口。这是 netstat 之外的**补充线索**：
 * 很多引擎会明确打印 "listening on http://127.0.0.1:8080"。
 * 只认明确的 host:port / --port / port: 形式，不做模糊数字扫描（时间戳会被误伤）。
 */
function portsFromLog(line) {
  const text = String(line ?? '');
  if (!text) return [];

  const found = new Set();
  const patterns = [
    /(?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1?\]):(\d{2,5})\b/gi,
    /--port[= ](\d{2,5})\b/gi,
    /\bport\s*[=:]\s*(\d{2,5})\b/gi,
    /\blistening\b[^\d\n]{0,20}\bport\b[^\d\n]{0,10}(\d{2,5})\b/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port >= 1_024 && port < 65_536) found.add(port);
    }
  }
  return [...found];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** tasklist 查进程映像名（只用它判断 pid 有没有被复用，不去猜别的） */
async function processImageName(pid) {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await execFileP('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    const line = stdout.split(/\r?\n/).find((item) => item.trim());
    if (!line) return null;
    const name = line.trim().split('","')[0].replace(/^"+|"+$/g, '');
    return name || null;
  } catch {
    return null;
  }
}

// ===========================================================================
// 8. 试启动（§5.5 / §5.5.1 / §5.5.2）
// ===========================================================================

/**
 * 试启动（**M6 / API 用的入口**）：等整件事结束，直接返回最终结果。
 * M6 的 `POST /api/engines/probe` 就是 `await probe(engine, model, { onEvent })`
 * 然后推一条 `done`。取消用 `opts.signal`。
 *
 * 需要"中途取消 / 轮询进度"的调用方（比如向导上的取消按钮）用 `startProbe()`。
 */
export async function probe(engine, model = {}, opts = {}) {
  const session = await startProbe(engine, model, opts);
  return session.result;
}

/**
 * 试启动的"会话版"：立刻返回一个可操作的 session，结果在 `session.result` 里。
 *
 * 用法（需要取消 / 实时进度时）：
 *   const session = await startProbe(engine, model, { onEvent: (event) => sse(event) });
 *   const result = await session.result;         // probe 结束（成功 / 失败 / 取消）
 *   session.cancel();                            // 用户点取消 / 关向导
 *   session.snapshot();                          // "已等 N 秒" 之类
 *
 * 事件类型（对应 M6 的 SSE event:）：
 *   log     { line, stream, seq }                  引擎原始输出
 *   probe   { port, path, ok, status, reason }     每尝试一个判活路径
 *   port    { port, readyUrl, readyTemplate, path, status, models }  探到了
 *   stalled { seconds, hint }                      30 秒没输出也没新端口
 *   tools   { tools, ms }                          工具能力探测结果（三态）
 *   note    { message }                            给人看的进度/警告
 *   done    { ok, reason, port, ... }              结束
 *
 * 行为约定：
 *   - **不设死超时**（`maxWaitMs` 只给测试用，默认 0 = 无限等；另有 30 分钟安全上限）
 *   - 探到就停：默认试启动成功后把进程杀掉（`keepAlive: true` 可以不杀）
 *   - 全程登记 `ephemeral: true`，正常收尾会删掉；杀不掉时留在表里给下次启动清
 *   - 30 秒判定是"输出和端口**都没有**"；有输出但没端口 → 继续等，不提示
 */
export async function startProbe(engine, model = {}, opts = {}) {
  if (!engine || typeof engine !== 'object') throw new TypeError('probe 需要 engine 对象');
  if (!engine.file) throw new TypeError('probe 需要 engine.file（启动文件路径）');

  const startedAt = Date.now();
  const instanceId = opts.instanceId ?? `probe-${startedAt.toString(36)}-${randomBytes(3).toString('hex')}`;
  const paths = Array.isArray(opts.paths) && opts.paths.length > 0 ? opts.paths : READY_PATHS;
  const stallAfterMs = clampInt(opts.stallAfterMs, 1_000, 3_600_000, DEFAULT_STALL_MS);
  const toolsTimeoutMs = clampInt(opts.toolsTimeoutMs, 1_000, 3_600_000, DEFAULT_TOOLS_TIMEOUT_MS);
  const httpTimeoutMs = clampInt(opts.httpTimeoutMs, 200, 10_000, HTTP_TIMEOUT_MS);
  const maxWaitMs = clampInt(opts.maxWaitMs, 0, 24 * 3_600_000, 0); // 0 = 不设死超时
  const stopOnDone = opts.keepAlive !== true;
  const registry = opts.registry ?? (await loadRegistry());

  // ---- 事件总线 ----
  const buffer = [];
  const listeners = new Set();
  const emit = (type, data = {}) => {
    const event = { type, at: Date.now(), ...data };
    buffer.push(event);
    if (buffer.length > MAX_EVENT_BUFFER) buffer.shift();
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者自己的错不该弄死试启动
      }
    }
  };
  if (typeof opts.onEvent === 'function') listeners.add(opts.onEvent);

  // ---- 状态 ----
  const candidates = new Map(); // port → 候选
  const timers = [];
  const pending = { stdout: '', stderr: '' };
  const decoders = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
  const abortController = new AbortController();

  let child = null;
  let resolvedFile = null;
  let spawnSpec = null;
  let unresolvedVars = [];
  let exited = false;
  let finished = false;
  let ticking = false;
  let portFound = false;
  let stalledEmitted = false;
  let lastOutputAt = startedAt;
  let lastPortAt = startedAt;
  let scanTimer = null;
  let stallTimer = null;
  let baseline = new Map();
  let baselineOk = false;
  let instanceChain = Promise.resolve();
  let instanceSaveWarned = false;
  let resolveResult = null;

  const session = {
    id: instanceId,
    phase: 'starting',
    startedAt,
    pid: null,
    port: null,
    readyPath: null,
    readyStatus: null,
    models: [],
    tools: null,
    caps: { tools: null },
    lines: [],
    lineCount: 0,
    exitCode: null,
    exitSignal: null
  };
  session.result = new Promise((resolve) => { resolveResult = resolve; });

  const onParentExit = () => {
    try { child?.kill('SIGKILL'); } catch { /* 尽力而为 */ }
  };

  function timeoutSignal(ms) {
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([abortController.signal, AbortSignal.timeout(ms)]);
    }
    return AbortSignal.timeout(ms);
  }

  function updateInstance(patch) {
    if (!registry) return Promise.resolve();
    instanceChain = instanceChain.then(async () => {
      try {
        const map = (await registry.loadInstances()) ?? {};
        if (patch === null) {
          delete map[instanceId];
        } else {
          map[instanceId] = { ...(map[instanceId] ?? {}), ...patch, ephemeral: true };
        }
        const saved = await registry.saveInstances(map);
        if (saved && saved.ok === false && !instanceSaveWarned) {
          instanceSaveWarned = true;
          const detail = Array.isArray(saved.errors)
            ? saved.errors.map((item) => item?.message ?? String(item)).join('；')
            : '未知原因';
          emit('note', { message: `实例登记没写进 instances.json：${detail}` });
        }
      } catch (err) {
        emit('note', { message: `实例登记失败（不影响试启动）：${err.message}` });
      }
    });
    return instanceChain;
  }

  function removeInstance() {
    return updateInstance(null);
  }

  function addCandidate(port, source, pid, { quiet = false } = {}) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) return;
    if (DENY_PORTS.has(value)) return;

    let entry = candidates.get(value);
    if (!entry) {
      entry = {
        port: value,
        sources: new Set(),
        pids: new Set(),
        firstSeenAt: Date.now(),
        lastTryAt: 0,
        attempts: 0,
        status: 'new',
        pathTries: new Set(),
        preoccupied: baseline.has(value)
      };
      candidates.set(value, entry);
      if (!quiet) {
        lastPortAt = Date.now();
        emit('note', { message: `发现新端口 ${value}（${source}）` });
        void tick();
      }
    }
    entry.sources.add(source);
    const owner = Number(pid);
    if (Number.isInteger(owner) && owner > 0) entry.pids.add(owner);
  }

  function priority(entry) {
    let score = 0;
    if (child?.pid && entry.pids.has(child.pid)) score += 100;
    if (entry.sources.has('netstat-child')) score += 60;
    if (entry.sources.has('netstat')) score += 40;
    if (entry.sources.has('log')) score += 30;
    if (entry.sources.has('expected')) score += 10;
    if (entry.preoccupied) score -= 50;
    return score;
  }

  function pushLine(stream, text) {
    const clean = String(text).replace(/\r$/, '');
    if (!clean.trim()) return;
    const shown = clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)} …` : clean;
    session.lineCount += 1;
    if (session.lines.length < MAX_LOG_LINES) session.lines.push({ stream, text: shown });
    emit('log', { line: shown, stream, seq: session.lineCount });
    for (const port of portsFromLog(clean)) addCandidate(port, 'log', null);
  }

  function onData(stream, chunk) {
    lastOutputAt = Date.now();
    pending[stream] += decoders[stream].decode(chunk, { stream: true });
    let index;
    while ((index = pending[stream].indexOf('\n')) >= 0) {
      const line = pending[stream].slice(0, index);
      pending[stream] = pending[stream].slice(index + 1);
      pushLine(stream, line);
    }
  }

  function flushPending() {
    for (const stream of ['stdout', 'stderr']) {
      const rest = pending[stream];
      pending[stream] = '';
      if (rest.trim()) pushLine(stream, rest);
    }
  }

  async function httpProbe(port, requestPath) {
    const url = `http://127.0.0.1:${port}${requestPath}`;
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: timeoutSignal(httpTimeoutMs)
      });
      const status = response.status;
      if (status !== 200) {
        try { await response.body?.cancel(); } catch { /* 已经消费掉了 */ }
        return { ok: false, status };
      }
      const contentType = response.headers.get('content-type') || '';
      if (/text\/html/i.test(contentType)) {
        try { await response.body?.cancel(); } catch { /* 忽略 */ }
        return { ok: false, status, reason: 'html' };
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_HTTP_BODY) {
        try { await response.body?.cancel(); } catch { /* 忽略 */ }
        return { ok: false, status, reason: 'body-too-large' };
      }
      const text = await response.text();
      if (text.length > MAX_HTTP_BODY) return { ok: false, status, reason: 'body-too-large' };
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status, reason: 'not-json' };
      }
      // 只认 JSON 对象/数组：`/` 返回网页、或者返回一个裸字符串都不算判活
      if (json === null || typeof json !== 'object') return { ok: false, status, reason: 'not-object' };
      return { ok: true, status, json };
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.code ?? err?.message ?? 'error');
      return { ok: false, status: null, reason };
    }
  }

  async function tryPaths(entry) {
    for (const requestPath of paths) {
      if (finished) return null;
      const hit = await httpProbe(entry.port, requestPath);
      if (hit.ok) return { port: entry.port, path: requestPath, status: hit.status, json: hit.json };

      if (!entry.pathTries.has(requestPath)) {
        entry.pathTries.add(requestPath);
        emit('probe', {
          port: entry.port,
          path: requestPath,
          ok: false,
          status: hit.status,
          reason: hit.reason
        });
      }
    }
    return null;
  }

  function extractModelIds(json) {
    const list = Array.isArray(json?.data) ? json.data
      : Array.isArray(json?.models) ? json.models
        : [];
    return list
      .map((item) => (typeof item === 'string' ? item : item?.id))
      .filter((id) => typeof id === 'string' && id.length > 0);
  }

  function shouldDetectTools() {
    if (opts.detectTools === false) return false;
    // §5.5.1：asr / tts 直接跳过，标 null
    if (model?.kind === 'asr' || model?.kind === 'tts') return false;
    return true;
  }

  async function detectTools(port) {
    const modelName = opts.modelName
      || model?.engineModelId
      || model?.id
      || session.models[0]
      || 'model';
    const body = {
      model: modelName,
      messages: [{ role: 'user', content: '现在几点?用工具查。' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_time',
          description: '取当前时间',
          parameters: { type: 'object', properties: {} }
        }
      }],
      tool_choice: 'auto',
      max_tokens: 64,
      stream: false
    };

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(toolsTimeoutMs)
      });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* 忽略 */ }
        return null;
      }
      const data = await response.json();
      const message = data?.choices?.[0]?.message;
      if (!message) return null;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
      if (typeof message.content === 'string' || Array.isArray(message.content)) return false;
      return null;
    } catch {
      // 超时 / 报错 → null（未测），**不阻塞导入**
      return null;
    }
  }

  async function handleReady(hit) {
    portFound = true;
    session.phase = 'ready';
    session.port = hit.port;
    session.readyPath = hit.path;
    session.readyStatus = hit.status;
    session.models = extractModelIds(hit.json);

    emit('port', {
      port: hit.port,
      readyUrl: `http://127.0.0.1:${hit.port}${hit.path}`,
      readyTemplate: `http://127.0.0.1:{port}${hit.path}`,
      path: hit.path,
      status: hit.status,
      models: session.models
    });

    await updateInstance({ phase: 'ready', port: hit.port });

    if (shouldDetectTools()) {
      const toolStartedAt = Date.now();
      session.tools = await detectTools(hit.port);
      session.caps = { tools: session.tools };
      emit('tools', { tools: session.tools, ms: Date.now() - toolStartedAt });
    }

    if (finished) return session.result; // 探测期间被取消 / 进程退了
    if (exited) {
      // 端口确实通过判活，但进程紧接着自己退了：不是常驻服务，配置照样不能用
      return finish({
        ok: false,
        reason: 'process-exited-after-ready',
        port: hit.port,
        readyPath: hit.path,
        hint: '端口曾经通过判活，但进程随后退出了——这个引擎可能不是常驻服务'
      });
    }
    return finish({ ok: true, reason: 'ready', port: hit.port, readyPath: hit.path });
  }

  async function tick() {
    if (finished || ticking) return;
    ticking = true;
    try {
      if (!portFound && baselineOk) {
        try {
          const current = await listListeningPorts();
          for (const [port, pids] of current) {
            if (baseline.has(port)) continue;
            const ownerPid = child?.pid && pids.has(child.pid) ? child.pid : [...pids][0];
            addCandidate(port, ownerPid === child?.pid ? 'netstat-child' : 'netstat', ownerPid);
          }
        } catch (err) {
          baselineOk = false;
          emit('note', { message: `netstat 失败（${err.message}）——后面只靠日志里的端口线索` });
        }
      }

      if (portFound || finished) return;

      const ordered = [...candidates.values()]
        .filter((entry) => entry.status !== 'dropped' && entry.status !== 'ready')
        .sort((a, b) => priority(b) - priority(a) || a.firstSeenAt - b.firstSeenAt);

      for (const entry of ordered) {
        if (finished || portFound) return;
        if (Date.now() - entry.lastTryAt < 500) continue;
        entry.lastTryAt = Date.now();
        entry.attempts += 1;
        entry.status = 'trying';

        const hit = await tryPaths(entry);
        if (hit) {
          void handleReady(hit).catch((err) => {
            void finish({ ok: false, reason: 'internal-error', error: err?.message ?? String(err) });
          });
          return;
        }
        // 不设死超时：端口已经出现但 HTTP 还没好（大模型加载时很常见），下一轮继续试
        entry.status = 'fail';
        if (entry.attempts === 20) {
          emit('note', { message: `端口 ${entry.port} 还不回 JSON，继续等（不设死超时）` });
        }
      }
    } finally {
      ticking = false;
    }
  }

  function checkStall() {
    if (finished || portFound) return;
    const silentMs = Date.now() - Math.max(lastOutputAt, lastPortAt);
    if (stalledEmitted || silentMs < stallAfterMs) return;
    stalledEmitted = true;
    const seconds = Math.round(stallAfterMs / 1000);
    emit('stalled', {
      seconds: Math.round(silentMs / 1000),
      hint: `${seconds} 秒没有一行输出、也没有新端口——脚本可能停在等输入（choice / set / p / pause）。可以自己填端口，或者让它原样运行。`
    });
  }

  async function finish(result, { kill = stopOnDone } = {}) {
    if (finished) return session.result;
    finished = true;
    for (const timer of timers) clearInterval(timer);
    for (const timer of timers) clearTimeout(timer);
    scanTimer = null;
    stallTimer = null;
    process.removeListener('exit', onParentExit);

    let killed = false;
    let killError = null;
    if (child?.pid && !exited) {
      if (kill) {
        const killResult = await killTree(child.pid, { timeoutMs: opts.killTimeoutMs ?? 8_000 });
        killed = killResult.ok === true;
        killError = killResult.error ?? null;
        if (killed) exited = true;
      }
    } else {
      killed = true; // 进程本来就不在了
    }

    if (!kill) {
      // keepAlive：把进程和登记一起留着，谁起的谁负责 stop
      if (session.port) await updateInstance({ phase: 'ready', port: session.port });
    } else if (killed) {
      await removeInstance();
    } else {
      await updateInstance({ phase: 'error', error: result.reason ?? 'kill-failed' });
    }

    session.phase = result.ok
      ? (kill ? 'stopped' : 'ready')
      : (result.cancelled ? 'stopped' : 'error');

    const output = {
      ok: result.ok === true,
      instanceId,
      pid: child?.pid ?? null,
      port: Number.isInteger(result.port) ? result.port : session.port,
      readyPath: result.readyPath ?? session.readyPath,
      readyUrl: session.port ? `http://127.0.0.1:${session.port}${session.readyPath}` : null,
      readyTemplate: session.readyPath ? `http://127.0.0.1:{port}${session.readyPath}` : null,
      models: session.models,
      caps: session.caps,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      lines: session.lineCount,
      logLines: [...session.lines],
      portsSeen: [...candidates.keys()],
      portDetails: [...candidates.values()].map((entry) => ({
        port: entry.port,
        sources: [...entry.sources],
        attempts: entry.attempts,
        status: entry.status
      })),
      cancelled: result.cancelled === true,
      reason: result.reason ?? (result.ok ? 'ready' : 'unknown'),
      hint: result.hint ?? null,
      error: result.error ?? null,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      unresolved: unresolvedVars,
      killed,
      killError,
      keptAlive: !kill,
      command: spawnSpec ? displayCommandLine(spawnSpec) : null
    };

    emit('done', {
      ok: output.ok,
      cancelled: output.cancelled,
      reason: output.reason,
      port: output.port,
      readyUrl: output.readyUrl,
      seconds: output.seconds,
      caps: output.caps,
      hint: output.hint
    });
    resolveResult(output);
    return output;
  }

  session.subscribe = (listener) => {
    if (typeof listener !== 'function') return () => {};
    // 晚订阅的补发历史：M6 的 SSE 可能在 probe await 之后才连上
    for (const event of buffer.slice()) {
      try { listener(event); } catch { /* 忽略 */ }
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  session.replay = () => buffer.slice();
  session.cancel = (reason = 'cancelled') => {
    abortController.abort();
    return finish({ ok: false, cancelled: true, reason }, { kill: true });
  };
  session.kill = async () => {
    if (child?.pid && !exited) {
      const killResult = await killTree(child.pid, { timeoutMs: opts.killTimeoutMs ?? 8_000 });
      if (killResult.ok) exited = true;
    }
    await removeInstance();
    session.phase = 'stopped';
  };
  session.snapshot = () => ({
    id: instanceId,
    phase: session.phase,
    pid: child?.pid ?? null,
    port: session.port,
    readyUrl: session.port ? `http://127.0.0.1:${session.port}${session.readyPath}` : null,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    lines: session.lineCount,
    secondsSinceOutput: Math.round((Date.now() - lastOutputAt) / 1000),
    ports: [...candidates.keys()],
    stalled: stalledEmitted,
    finished
  });

  // ---- 1. 启动文件在不在 ----
  // 顺手清一次"别的控制台进程留下的"试启动孤儿（second line of defense，见函数注释）
  await preflightOrphanProbes(registry, emit);

  if (engine.mode === 'remote') {
    // §5.12：云端模型没有本地进程，不参与试启动
    await finish({ ok: false, reason: 'remote-engine', hint: '云端引擎没有本地进程，不能试启动；保存后用「试一下」验证 key' }, { kill: false });
    return session;
  }
  resolvedFile = path.isAbsolute(String(engine.file))
    ? path.normalize(String(engine.file))
    : path.resolve(opts.cwd ?? engine.cwd ?? process.cwd(), String(engine.file));

  if (!(await fileExists(resolvedFile))) {
    await finish({ ok: false, reason: 'file-missing', hint: `启动文件不存在：${resolvedFile}` }, { kill: false });
    return session;
  }

  const spawnEngine = { ...engine, file: resolvedFile };
  const expectedPort = firstInteger(opts.expectedPort, model.port, engine.defaultPort, DEFAULT_ENGINE_PORT);

  // ---- 2. 拼参数 ----
  let argv = [];
  if (engine.mode !== 'package') {
    const rendered = renderArgv(spawnEngine, model, {
      port: expectedPort,
      host: opts.host,
      modelId: opts.modelName
    });
    argv = Array.isArray(opts.argv) ? opts.argv.map(String) : rendered.argv;
    unresolvedVars = rendered.unresolved;
    if (rendered.unresolved.length > 0) {
      emit('note', {
        message: `模板里有变量没值，照样试：${rendered.unresolved.map((name) => `{${name}}`).join(' ')}`
      });
    }
  }

  spawnSpec = buildSpawnCommand(spawnEngine, argv);
  if (spawnSpec.error) {
    await finish({ ok: false, reason: 'unsupported-kind', hint: spawnSpec.error }, { kill: false });
    return session;
  }

  // ---- 3. 端口基线（必须在 spawn 之前取）----
  try {
    baseline = await listListeningPorts();
    baselineOk = true;
  } catch (err) {
    baseline = new Map();
    baselineOk = false;
    emit('note', { message: `读不到 netstat 基线（${err.message}）——改用日志里的端口线索` });
  }

  if (expectedPort) {
    if (baseline.has(expectedPort)) {
      // 启动前就被占：那它不可能是"这次新出现的端口"，绝不能当成自己的引擎
      emit('note', {
        message: `端口 ${expectedPort} 在启动前已被占用——试启动只认"这次新出现的端口"`
      });
    } else {
      addCandidate(expectedPort, 'expected', null, { quiet: true });
    }
  }

  // ---- 4. 登记 ephemeral（§5.5.2）----
  if (!registry) {
    emit('note', {
      message: '数据层（core/registry.mjs）不可用：试启动进程没有登记进 instances.json，控制台退出后可能留下孤儿'
    });
  } else {
    await updateInstance({
      engineId: engine.id ?? null,
      modelIds: model?.id ? [model.id] : [],
      port: null,
      pid: null,
      phase: 'starting',
      ephemeral: true,
      startedAt,
      ownerPid: process.pid,
      file: resolvedFile,
      probeCommand: spawnSpec.command
    });
  }

  // ---- 5. 真 spawn ----
  try {
    child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: opts.cwd ?? engine.cwd ?? path.dirname(resolvedFile),
      env: { ...process.env, ...(engine.env ?? {}), ...(opts.env ?? {}) },
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.verbatim === true,
      detached: false,
      // stdin 保持打开但从不写：脚本里的 choice / set / p 会真的卡住，
      // 这样 30 秒"可能停在等输入"的提示才有意义（如果给 EOF，它就默默走默认分支了）
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    // spawn 的参数/权限错误是**同步抛**的（比如 EPERM、ENOENT）。
    // 这时刚才登记的 ephemeral 必须一起删掉，否则表里留一条永远起不来的记录。
    await finish({
      ok: false,
      reason: 'spawn-error',
      error: err.message,
      hint: err.code === 'EPERM'
        ? '系统拒绝了这次启动（EPERM）：常见于杀毒软件拦截 / 权限不足'
        : null
    });
    return session;
  }

  session.pid = child.pid ?? null;

  // 先接事件再 await 登记：进程完全可能瞬间退出，晚了就漏掉 exit
  child.stdout?.on('data', (chunk) => onData('stdout', chunk));
  child.stderr?.on('data', (chunk) => onData('stderr', chunk));

  child.once('error', (err) => {
    emit('log', { line: `[spawn 失败] ${err.message}`, stream: 'system', seq: session.lineCount });
    void finish({ ok: false, reason: 'spawn-error', error: err.message });
  });

  child.once('exit', (code, signal) => {
    exited = true;
    session.exitCode = code;
    session.exitSignal = signal;
    flushPending();
    emit('log', { line: `[进程退出] code=${code ?? 'null'} signal=${signal ?? 'null'}`, stream: 'system', seq: session.lineCount });
    if (!finished && !portFound) {
      void finish({
        ok: false,
        reason: 'process-exited',
        exitCode: code,
        hint: '进程自己退了：要么它不是常驻服务，要么启动参数不对 / 缺文件。看上面的输出。'
      });
    }
  });

  process.once('exit', onParentExit);

  if (!finished) await updateInstance({ pid: child.pid ?? null });
  if (finished) return session;

  emit('note', { message: `试启动：${displayCommandLine(spawnSpec)}` });
  emit('log', { line: `[试启动] ${displayCommandLine(spawnSpec)}`, stream: 'system', seq: session.lineCount });

  // ---- 6. 定时器 ----
  scanTimer = setInterval(() => { void tick(); }, SCAN_INTERVAL_MS);
  timers.push(scanTimer);
  timers.push(setTimeout(() => { void tick(); }, 800)); // 起得快的话不用等满 3 秒
  stallTimer = setInterval(checkStall, 1_000);
  timers.push(stallTimer);
  if (maxWaitMs > 0) {
    timers.push(setTimeout(() => {
      void finish({ ok: false, reason: 'max-wait', hint: `超过 ${Math.round(maxWaitMs / 1000)} 秒还没探到端口` });
    }, maxWaitMs));
  }
  // 30 分钟安全上限：M6 在浏览器关掉时不会主动取消，没有这个就会永远挂着一个进程
  timers.push(setTimeout(() => {
    emit('note', { message: '试启动超过 30 分钟，强制收尾（防止关掉页面后留孤儿）' });
    void finish({ ok: false, reason: 'lifetime-exceeded', hint: '试启动超过 30 分钟还没有结果，已自动停掉' });
  }, MAX_PROBE_LIFETIME_MS));

  if (opts.signal) {
    if (opts.signal.aborted) {
      await session.cancel('aborted');
    } else {
      opts.signal.addEventListener('abort', () => { void session.cancel('aborted'); }, { once: true });
    }
  }

  return session;
}

// ===========================================================================
// 9. 清孤儿（控制台启动时先扫一遍 §5.5.2）
// ===========================================================================

let probePreflightDone = false;

/**
 * 试启动前的第二道保险：清掉**别的控制台进程**留下的 ephemeral 孤儿。
 *
 * 为什么需要它：server.mjs 启动时走的是 M2 的 `restore() + purgeEphemeral()`，
 * 而 `restore()` 要先把实例挂回一个**已保存的引擎**上；导入向导里的试启动用的是
 * 还没保存的草稿引擎，`restore()` 会跳过它——于是那条进程就没有人清。
 *
 * 判定条件故意保守，避免误杀：
 *   - `ownerPid` 必须是别的进程（同一个控制台里的并发试启动不动）
 *   - `startedAt` 至少 60 秒前（正在进行的试启动不动）
 *   - pid 活着，且（如果有 `probeCommand`）tasklist 的映像名对得上
 */
async function preflightOrphanProbes(registry, emit) {
  if (probePreflightDone) return;
  probePreflightDone = true;
  if (!registry) return;

  try {
    const map = (await registry.loadInstances()) ?? {};
    const now = Date.now();
    let cleaned = 0;
    let changed = false;

    for (const [id, entry] of Object.entries(map)) {
      if (!entry || entry.ephemeral !== true) continue;
      const pid = Number(entry.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (entry.ownerPid === process.pid) continue;
      if (!Number.isFinite(entry.startedAt) || now - entry.startedAt < 60_000) continue;

      if (!isPidAlive(pid)) {
        delete map[id];
        changed = true;
        continue;
      }
      if (entry.probeCommand) {
        const imageName = await processImageName(pid);
        const expected = path.basename(String(entry.probeCommand)).toLowerCase();
        if (imageName && imageName.toLowerCase() !== expected) {
          delete map[id];
          changed = true;
          continue;
        }
      }
      const killed = await killTree(pid, { timeoutMs: 8_000 });
      if (killed.ok) {
        delete map[id];
        changed = true;
        cleaned += 1;
      }
    }

    if (changed) await registry.saveInstances(map);
    if (cleaned > 0) emit('note', { message: `清掉了 ${cleaned} 个上次没关掉的试启动进程` });
  } catch {
    // 清孤儿失败不该拦住这次试启动
  }
}

/**
 * 清掉上次没清干净的试启动进程（`ephemeral: true`）。
 * **控制台启动时调用一次**，否则用户导入一半关掉浏览器 → 下次导入报"端口被占"，
 * 而占用者是自己上次丢下的。
 *
 * 防御：pid 可能被系统复用。登记时存了 `probeCommand`，这里用 tasklist 核对映像名，
 * 对不上就只删记录、绝不动那个进程。
 *
 * 调用时机建议：`server.mjs` 里 **在 `manager.restore()` 之前**跑一次，
 * 避免 M2 先把孤儿认成自己的实例。
 *
 * @param {{registry?: object, dryRun?: boolean, killTimeoutMs?: number}} [opts]
 * @returns {Promise<{ok:boolean, killed:object[], failed:object[], skipped:object[]}>}
 */
export async function cleanupEphemeral(opts = {}) {
  const registry = opts.registry ?? (await loadRegistry());
  if (!registry) {
    return { ok: false, reason: 'registry-unavailable', killed: [], failed: [], skipped: [] };
  }

  let map;
  try {
    map = (await registry.loadInstances()) ?? {};
  } catch (err) {
    return { ok: false, reason: err.message, killed: [], failed: [], skipped: [] };
  }

  const killed = [];
  const failed = [];
  const skipped = [];
  let changed = false;

  for (const [id, entry] of Object.entries(map)) {
    if (!entry || entry.ephemeral !== true) continue;
    if (opts.dryRun === true) {
      // dryRun 只报告，绝不写盘也绝不动进程
      skipped.push({ id, pid: entry.pid ?? null, reason: 'dryRun' });
      continue;
    }
    const pid = Number(entry.pid);

    if (!Number.isInteger(pid) || pid <= 0) {
      delete map[id];
      changed = true;
      skipped.push({ id, reason: '没有可用的 pid' });
      continue;
    }
    if (!isPidAlive(pid)) {
      delete map[id];
      changed = true;
      skipped.push({ id, pid, reason: '进程已经不在了' });
      continue;
    }

    // pid 复用防御：现在这个 pid 还是当初那个程序吗？
    if (entry.probeCommand) {
      const imageName = await processImageName(pid);
      const expectedName = path.basename(String(entry.probeCommand)).toLowerCase();
      if (imageName && imageName.toLowerCase() !== expectedName) {
        delete map[id];
        changed = true;
        skipped.push({
          id,
          pid,
          reason: `pid 现在属于 ${imageName}，不是当初的 ${expectedName}（pid 被复用了）`
        });
        continue;
      }
    }

    const killResult = await killTree(pid, { timeoutMs: opts.killTimeoutMs ?? 8_000 });
    if (!killResult.ok) {
      failed.push({ id, pid, error: killResult.error ?? 'taskkill 失败' });
      continue;
    }

    await sleep(250);
    if (isPidAlive(pid)) {
      failed.push({ id, pid, error: 'taskkill 返回成功，但进程还在' });
      continue;
    }

    delete map[id];
    changed = true;
    killed.push({ id, pid });
  }

  if (changed) {
    try {
      const saved = await registry.saveInstances(map);
      if (saved && saved.ok === false) {
        const detail = Array.isArray(saved.errors)
          ? saved.errors.map((item) => item?.message ?? String(item)).join('；')
          : '未知原因';
        return { ok: false, reason: `进程清掉了，但 instances.json 没写回去：${detail}`, killed, failed, skipped };
      }
    } catch (err) {
      return { ok: false, reason: `进程清掉了，但写回 instances.json 失败：${err.message}`, killed, failed, skipped };
    }
  }

  return { ok: failed.length === 0, killed, failed, skipped };
}

