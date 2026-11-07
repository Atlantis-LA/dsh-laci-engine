'use strict';

/* ============================================================================
 * LACI · 模型调度中心 · 界面（M7）
 * ----------------------------------------------------------------------------
 * 纯 vanilla JS，不引入任何框架 / CDN。
 * 唯一数据源：控制面 3101 的 /api/*（绝不直连 8095 或引擎端口）。
 * 刷新方式：轮询 GET /api/state（2 秒），不用 WebSocket。
 * ==========================================================================*/

/* ---------- 0. 常量 ---------- */

const POLL_MS = 2000;            // 状态轮询间隔
const TICK_MS = 1000;            // 秒数走字
const MAX_LOG_LINES = 400;       // 试启动 / 日志最多留多少行
const LOG_FETCH_TAIL = 120;      // 日志一次取多少行

const DOT = { idle: 'off', ready: 'on', starting: 'warn', stopping: 'off', error: 'err' };
const KIND_BADGE = { asr: '🎙 语音转文字', tts: '🔊 语音合成', image: '🎨 图像' };
const KV_DTYPES = ['rk4v4-e8', 'k8v4', 'bf16', 'rk2v4-e8'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RESIDENCY = ['overlay', 'resident', 'cpu'];
const SPEC_BACKENDS = ['mtp', 'dflash', 'dflash2'];

/* 新模型 / 兜底引擎用的默认参数（界面上可见、可改） */
const DEFAULT_PARAMS = {
  maxContext: 32768,
  kvWindow: 32768,
  kvDtype: 'bf16',
  prefillChunk: 256,
  hostKvMib: 8192,
  kvHeadroomMib: 256,
  mtp: false,
  spec: 'mtp',
  draftTokens: 4,
  vision: false,
  visionResidency: 'overlay',
  visionMaxMerged: 16384,
};

/* 扫描不出 argv 时，按参数运行的兜底模板（会提示用户可能要改） */
const DEFAULT_ARGV = ['{model}', '--host', '{host}', '--port', '{port}', '--model-id', '{modelId}', '--max-context', '{maxContext}'];

/* ?embed=1 或服务端注入的 window.__LACI_EMBED__ = true 都算内嵌 */
const EMBED = (() => {
  try {
    return new URLSearchParams(location.search).get('embed') === '1' || window.__LACI_EMBED__ === true;
  } catch (err) {
    return false;
  }
})();
if (EMBED) document.body.classList.add('embed');

/* ---------- 1. 小工具 ---------- */

function el(id) { return document.getElementById(id); }
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* HTML 转义：所有来自后端 / 用户的字符串都要过一遍 */
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escAttr(v) { return esc(v); }

function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }
function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
function pickNum(obj, keys) {
  const v = pick(obj, keys);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : (v > 1e9 ? v * 1000 : v);
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
/* 关联字段有时是字符串，有时是对象（{id} / {engineId}），统一取 id */
function idOf(v) {
  if (v == null) return '';
  if (typeof v === 'object') return String(v.id || v.engineId || v.modelId || '');
  return String(v);
}
function fmtGib(mib) {
  const n = Number(mib);
  return Number.isFinite(n) ? (n / 1024).toFixed(1) : '—';
}
function gib(g) {
  const n = Number(g);
  return Number.isFinite(n) ? n.toFixed(1) + ' GiB' : '—';
}
function mibToGib(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1024 : null;
}
function fmtInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString('en-US') : '—';
}
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分';
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
}
function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
}
function trunc(s, n) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}
function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}
function basenameNoExt(p) {
  return basename(p).replace(/\.[^.]+$/, '');
}
function dirname(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : '';
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
/* 和 M1 的 isSafeId 对齐：字母/数字开头，只含字母数字 . _ -，最多 64 字符 */
function isSafeId(id) {
  const s = String(id || '');
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(s)) return false;
  if (s.endsWith('.')) return false;
  if (/^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])$/i.test(s)) return false;
  return true;
}
/* 简单的命令行拆分：支持双引号 / 单引号 */
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
  return out;
}
function quoteArg(s) {
  const str = String(s);
  if (!/\s/.test(str)) return str;
  if (/^".*"$/.test(str)) return str;
  return '"' + str + '"';
}

/* 与后端 core/config.mjs 的 cleanPath 一致：
   资源管理器「复制文件地址」给的是 "D:\..." —— 带引号粘进来引擎会认不出文件 */
function cleanPathText(value) {
  let out = String(value == null ? '' : value).trim();
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    if (out.startsWith('"')) out = out.slice(1).trim();
    if (out.endsWith('"')) out = out.slice(0, -1).trim();
    if (out === before) break;
  }
  return out;
}

/* ---------- 2. 状态 ---------- */
const S = {
  gpu: null,
  slots: { total: 0, used: 0 },
  ledger: { runningCount: 0, committedVramMiB: null, committedRamMiB: null },
  engines: [],
  models: [],
  instances: [],
  byModel: new Map(),
  instById: new Map(),
  engineById: new Map(),

  offline: false,
  lastError: '',
  loaded: false,          /* 是否已经成功拿到过一次 /api/state */

  /* 展开的引擎卡片（按引擎 id 记，存 localStorage） */
  open: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('laci.ui.open') || '[]');
      return new Set(Array.isArray(raw) ? raw.map(String) : []);
    } catch (err) {
      return new Set();
    }
  })(),

  busy: new Set(),          // 正在提交动作的模型 / 实例，按钮临时禁用
  closing: new Set(),       // 正在关闭的实例，防重复
  pendingClose: new Set(),  // 「等它结束」的模型：in-flight 归零后自动关
  firstSeen: new Map(),     // starting 状态第一次看到的时刻（后端没给 startedAt 时兜底）
  logDisabled: new Set(),   // 日志接口 404 过的实例，不再反复打
  logBusy: new Set(),
  engineMissing: new Set(), // 加载失败时发现启动文件不见了（M6 目前不直接给 missing 字段）
  confirmDelete: '',        // 缺失引擎的二次确认
  /* 多模型实例的勾选：引擎 id → Set<模型 id>。
     只对 supportsMultiModel 的引擎生效（D1：多槽位引擎永远一进程一模型）。 */
  multiSel: new Map(),
};

let cfgCtx = null;      // 模型配置弹窗上下文
let vramCtx = null;     // 显存不足弹窗上下文
let inflightCtx = null; // 在飞请求弹窗上下文
let importCtx = null;   // 导入整合包上下文
/* 导入弹窗里 id 是自动填的；用户手改过就不再覆盖 */
const impIdTouched = { eng: false, model: false };
let probe = null;       // 试启动 / 日志弹窗上下文
let dshText = '';       // 接入 DSH 的 YAML 文本
let picker = null;      // 页面内文件选择器上下文

let nativePickToken = 0;  // 每次点「选择」自增：作废过期的原生对话框结果
let nativePickCtx = null; // 正在等原生对话框的那个输入框（兜底出口要用）

let refreshing = false;
let previewTimer = null;

/* ---------- 3. API 封装 ---------- */

class ApiError extends Error {
  constructor(status, body) {
    super(apiMessage(status, body));
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/* 把 400/404/409/503 这些业务错误翻译成人话（错误码约定见 M6） */
function apiMessage(status, body) {
  const b = body && typeof body === 'object' ? body : null;
  let msg = '';
  if (b) {
    if (Array.isArray(b.errors) && b.errors.length) {
      msg = b.errors.map((e) => (typeof e === 'string' ? e : ((e && (e.message || e.msg)) || JSON.stringify(e)))).join('；');
    }
    if (!msg && typeof b.message === 'string') msg = b.message;
    if (!msg && typeof b.error === 'string') msg = b.error;
    if (!msg && typeof b.code === 'string') msg = b.code;
  }
  if (!msg) {
    msg = ({
      400: '参数不对', 401: '没有权限', 404: '资源不存在', 409: '有冲突',
      502: '网关错误', 503: '引擎没起来 / 端口不通', 504: '超时',
    })[status] || ('请求失败（' + status + '）');
  }
  if (b && (b.retryAfter != null || b.retry_after != null)) {
    msg += '（' + (b.retryAfter != null ? b.retryAfter : b.retry_after) + ' 秒后重试）';
  }
  return msg;
}

/* API 根：直接开 3102 时是 /api；经插件同源代理（/laci/）时是 /laci/api */
const API_ROOT = (() => {
  const dir = location.pathname.replace(/[^/]*$/, '');
  return dir + 'api';
})();

async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  if (opts.signal) init.signal = opts.signal;
  else if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetch(API_ROOT + path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (err) { data = text; }
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------- 4. /api/state 归一化（后端字段可能略有出入，这里都兜住） ---------- */

function normalizeState(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};

  let gpuRaw = raw.gpu != null ? raw.gpu : raw.GPU;
  if (Array.isArray(gpuRaw)) gpuRaw = gpuRaw[0] || null;
  if (gpuRaw && gpuRaw.gpus) gpuRaw = Array.isArray(gpuRaw.gpus) ? (gpuRaw.gpus[0] || null) : gpuRaw.gpus;
  let gpu = null;
  if (gpuRaw && typeof gpuRaw === 'object') {
    gpu = {
      ok: gpuRaw.ok !== false,
      name: pick(gpuRaw, ['name', 'model', 'deviceName', 'gpuName', 'gpu', 'product']),
      driver: pick(gpuRaw, ['driver', 'driverVersion', 'driver_version', 'driverVer']),
      totalMiB: pickNum(gpuRaw, ['totalMiB', 'total_mib', 'memoryTotalMiB', 'memoryTotal', 'total', 'vramTotal']),
      freeMiB: pickNum(gpuRaw, ['freeMiB', 'free_mib', 'memoryFreeMiB', 'memoryFree', 'free', 'vramFree']),
      usedMiB: pickNum(gpuRaw, ['usedMiB', 'used_mib', 'memoryUsedMiB', 'memoryUsed', 'used', 'vramUsed']),
    };
    if (gpu.usedMiB == null && gpu.totalMiB != null && gpu.freeMiB != null) gpu.usedMiB = Math.max(0, gpu.totalMiB - gpu.freeMiB);
    if (gpu.freeMiB == null && gpu.totalMiB != null && gpu.usedMiB != null) gpu.freeMiB = Math.max(0, gpu.totalMiB - gpu.usedMiB);
    gpu.name = gpu.name ? String(gpu.name) : '';
    gpu.driver = gpu.driver ? String(gpu.driver) : '';
  }

  const engines = (Array.isArray(raw.engines) ? raw.engines : []).map(normalizeEngine).filter((e) => e.id);
  const models = (Array.isArray(raw.models) ? raw.models : []).map(normalizeModel).filter((m) => m.id);
  const instances = (Array.isArray(raw.instances) ? raw.instances : [])
    .map(normalizeInstance)
    .filter((i) => i.id && !i.ephemeral); // 试启动的 ephemeral 实例不显示在主列表

  /* 槽位：M6 只给 total；已占用从账本 runningCount 推，其次数运行中的实例 */
  const slotsRaw = raw.slots && typeof raw.slots === 'object' ? raw.slots : {};
  const ledgerRaw = raw.ledger && typeof raw.ledger === 'object' ? raw.ledger : {};
  const liveInstances = instances.filter((i) => ['starting', 'ready', 'stopping'].indexOf(i.status) >= 0);
  const explicitUsed = pickNum(slotsRaw, ['used', 'occupied', 'inUse', 'in_use']);
  const ledgerRunning = pickNum(ledgerRaw, ['runningCount']);
  /* M6 的 snapshot() 目前没把实例传进去，runningCount 可能是 0，所以和实例数取大 */
  const usedSlots = explicitUsed != null
    ? explicitUsed
    : Math.max(ledgerRunning || 0, liveInstances.length);
  const slots = {
    total: pickNum(slotsRaw, ['total', 'limit', 'max']) || 0,
    used: usedSlots || 0,
  };
  const ledger = {
    committedVramMiB: pickNum(ledgerRaw, ['committedVramMiB']),
    committedRamMiB: pickNum(ledgerRaw, ['committedRamMiB']),
    freeVramMiB: pickNum(ledgerRaw, ['freeVramMiB']),
    runningCount: pickNum(ledgerRaw, ['runningCount']),
    negative: !!ledgerRaw.negative,
  };

  const engineById = new Map(engines.map((e) => [e.id, e]));
  const instById = new Map(instances.map((i) => [i.id, i]));
  const byModel = new Map();
  /* 先挂"活的"实例（starting/ready/stopping），再挂 error 的：
     重试后旧 error 实例可能还留在列表里，不能让模型行一直显示 error */
  const livePhase = (s) => ['starting', 'ready', 'stopping'].indexOf(s) >= 0;
  for (const inst of instances) {
    if (!livePhase(inst.status)) continue;
    for (const mid of inst.modelIds) if (!byModel.has(mid)) byModel.set(mid, inst);
  }
  for (const inst of instances) {
    for (const mid of inst.modelIds) {
      if (!byModel.has(mid)) byModel.set(mid, inst);
    }
  }
  return { gpu, slots, ledger, engines, models, instances, engineById, instById, byModel };
}

function normalizeEngine(raw) {
  if (!raw || typeof raw !== 'object') return { id: '' };
  const file = pick(raw, ['file', 'path', 'program', 'exe']) || '';
  const slots = Array.isArray(raw.fileSlots) ? raw.fileSlots : [];
  return {
    id: String(pick(raw, ['id', 'engineId']) || ''),
    label: String(pick(raw, ['label', 'name', 'title']) || pick(raw, ['id', 'engineId']) || '未命名引擎'),
    mode: raw.mode === 'package' ? 'package' : (raw.mode === 'custom' ? 'custom' : (raw.mode || 'custom')),
    kind: raw.kind || 'exe',
    file: String(file),
    cwd: raw.cwd ? String(raw.cwd) : '',
    defaultPort: pickNum(raw, ['defaultPort', 'port', 'basePort']),
    fileSlots: slots.map((s) => ({
      key: String(s && s.key != null ? s.key : (s && s.id != null ? s.id : '')),
      label: String((s && s.label) || (s && s.key) || ''),
      kind: s && s.kind === 'dir' ? 'dir' : 'file',
      arg: (s && s.arg) || null,
      optional: !!(s && s.optional),
      expect: s && s.expect,
    })).filter((s) => s.key),
    argv: Array.isArray(raw.argv) ? raw.argv.map(String) : (typeof raw.argv === 'string' ? splitArgs(raw.argv) : []),
    env: raw.env && typeof raw.env === 'object' ? raw.env : null,
    webUI: raw.webUI || null,
    /* 多模型开关：少了这两个，界面上永远出不来勾选框（D1） */
    supportsMultiModel: raw.supportsMultiModel === true,
    modelsArg: typeof raw.modelsArg === 'string' && raw.modelsArg.trim() ? raw.modelsArg.trim() : null,
    multiInstance: raw.multiInstance === true,
    /* package 引擎：启动脚本实际加载的模型文件（用来区分同引擎下的多个模型） */
    scriptModelFile: typeof raw.scriptModelFile === 'string' ? raw.scriptModelFile : null,
    presetParams: (raw.presetParams && typeof raw.presetParams === 'object') ? raw.presetParams : null,
    capabilityArgs: (raw.capabilityArgs && typeof raw.capabilityArgs === 'object') ? raw.capabilityArgs : null,
    /* 云端引擎：后端只给"配没配 key"，key 本身不出现（§5.12） */
    hasKey: raw.hasKey === true,
    apiKeyEnv: typeof raw.apiKeyEnv === 'string' && raw.apiKeyEnv ? raw.apiKeyEnv : null,
    missing: !!(raw.missing || raw.fileMissing || raw.status === 'missing' ||
      (typeof raw.error === 'string' && /missing|不存在|找不到/i.test(raw.error))),
    error: typeof raw.error === 'string' ? raw.error : '',
    /* 保存时要用完整档案（改启动方式 = 改引擎级 mode，见 §5.4.2） */
    raw,
  };
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return { id: '' };
  const params = raw.params && typeof raw.params === 'object' ? Object.assign({}, raw.params) : {};
  const files = raw.files && typeof raw.files === 'object' ? Object.assign({}, raw.files) : {};
  if (!Object.keys(files).length && typeof raw.file === 'string') files.model = raw.file;
  const t = raw.thinking && typeof raw.thinking === 'object' ? raw.thinking : {};
  /* M1/M6 里 extraArgs 是字符串数组；界面上用一行文本编辑，所以这里合成字符串 */
  const extra = Array.isArray(raw.extraArgs)
    ? raw.extraArgs.join(' ')
    : (typeof raw.extraArgs === 'string'
      ? raw.extraArgs
      : (Array.isArray(params.extraArgs) ? params.extraArgs.join(' ') : (typeof params.extraArgs === 'string' ? params.extraArgs : '')));
  return {
    id: String(pick(raw, ['id', 'modelId']) || ''),
    label: String(pick(raw, ['label', 'name', 'title']) || pick(raw, ['id', 'modelId']) || ''),
    engineId: idOf(pick(raw, ['engineId', 'engine'])),
    kind: String(raw.kind || 'chat'),
    files,
    params,
    caps: raw.caps && typeof raw.caps === 'object' ? Object.assign({}, raw.caps) : {},
    thinking: {
      effort: t.effort != null ? String(t.effort) : 'none',
      budget: Number.isFinite(Number(t.budget)) ? Number(t.budget) : 512,
      allowRequestOverride: !!t.allowRequestOverride,
    },
    port: pickNum(raw, ['port']),
    extraArgs: extra,
    raw,
  };
}

function normalizeInstance(raw) {
  if (!raw || typeof raw !== 'object') return { id: '' };
  let modelIds = [];
  if (Array.isArray(raw.modelIds)) modelIds = raw.modelIds.map(idOf).filter(Boolean);
  else if (raw.modelId) modelIds = [idOf(raw.modelId)];
  else if (Array.isArray(raw.models)) modelIds = raw.models.map(idOf).filter(Boolean);

  let lastError = pick(raw, ['lastError', 'error', 'message']);
  if (lastError == null) {
    const lf = raw.lastFailure;
    lastError = lf && typeof lf === 'object' ? (lf.message || lf.reason || '') : lf;
  }

  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w)) : [];
  const externalText = warnings.find((w) => /外部变更|外部加载|external/i.test(w)) || '';

  return {
    id: String(pick(raw, ['id', 'instanceId']) || ''),
    engineId: idOf(pick(raw, ['engineId', 'engine'])),
    modelIds,
    /* 运行时快照用的是 phase（idle / starting / ready / stopping / error） */
    status: String(pick(raw, ['phase', 'status', 'state']) || 'idle'),
    port: pickNum(raw, ['port', 'actualPort', 'listenPort']),
    pool: pickNum(raw, ['pool', 'kvPool', 'kvCapacity', 'capacity', 'poolTokens', 'kvTokens']),
    pid: pickNum(raw, ['pid']),
    inflight: pickNum(raw, ['inflight', 'inflightRequests', 'inflightCount', 'pending', 'active', 'requests']) || 0,
    startedAt: toMs(pick(raw, ['startedAt', 'startedAtMs', 'started_at', 'startTime', 'createdAt'])),
    readyAt: toMs(pick(raw, ['readyAt', 'ready_at', 'readyTime'])),
    lastError: String(lastError || ''),
    warnings,
    logTail: typeof raw.logTail === 'string'
      ? raw.logTail
      : (Array.isArray(raw.logs) && raw.logs.length ? String(raw.logs[raw.logs.length - 1] || '') : ''),
    externalChange: !!(raw.externalChange || raw.reconciled || raw.externalChanged || externalText),
    external: raw.external === true,
    externalText,
    ephemeral: !!raw.ephemeral,
    webUI: raw.webUI || null,
  };
}

function applyState(next) {
  S.gpu = next.gpu;
  S.slots = next.slots;
  S.ledger = next.ledger;
  S.engines = next.engines;
  S.models = next.models;
  S.instances = next.instances;
  S.engineById = next.engineById;
  S.instById = next.instById;
  S.byModel = next.byModel;

  /* 清掉已经不存在的实例的 firstSeen */
  const alive = new Set(S.instances.map((i) => i.id));
  for (const key of Array.from(S.firstSeen.keys())) {
    if (!alive.has(key)) S.firstSeen.delete(key);
  }
  for (const key of Array.from(S.logDisabled)) {
    if (!alive.has(key)) S.logDisabled.delete(key);
  }
  /* 启动失败信息里出现"启动文件不存在 / spawn ENOENT"：把引擎卡片标成缺失 */
  for (const inst of S.instances) {
    if (inst.status === 'error' && /ENOENT|no such file|启动文件不存在|找不到启动文件|文件不存在/i.test(inst.lastError || '')) {
      S.engineMissing.add(inst.engineId);
    }
  }
}

/* ---------- 5. 轮询与顶层渲染 ---------- */

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const raw = await api('/state');
    if (!raw || typeof raw !== 'object') throw new Error('/api/state 返回的不是 JSON（控制面可能还没实现）');
    const wasOffline = S.offline;
    S.offline = false;
    S.lastError = '';
    S.loaded = true;
    applyState(normalizeState(raw));
    if (wasOffline) toast('已连上控制面', 'ok');
  } catch (err) {
    S.offline = true;
    S.lastError = err && err.message ? err.message : String(err);
  } finally {
    refreshing = false;
    render();
    checkPendingClose();
    fetchStartingLogs();
  }
}

function render() {
  renderOffline();
  renderLedger();
  renderEngines();
}

function renderOffline() {
  const box = el('offline');
  const host = el('engines');
  if (!box) return;
  if (!S.offline) {
    box.hidden = true;
    if (host) host.classList.remove('stale');
    return;
  }
  box.hidden = false;
  box.innerHTML = '<span class="dot err"></span><span><b>连不上控制面</b> · ' +
    esc(S.lastError || '请求失败') + ' · 每 2 秒重试中</span>';
  if (host) host.classList.add('stale');
}

function renderLedger() {
  const box = el('ledger');
  if (!box) return;
  const g = S.gpu;
  const total = g && g.totalMiB ? g.totalMiB : 0;
  const used = g && g.usedMiB != null ? g.usedMiB : 0;
  const pct = total > 0 ? clamp((used / total) * 100, 0, 100) : 0;

  let gpuVal;
  if (total > 0) {
    gpuVal = fmtGib(used) + ' / ' + fmtGib(total) + ' GiB · <b>' + esc(g.name || 'GPU') + '</b>' +
      (g.driver ? ' · 驱动 ' + esc(g.driver) : '');
  } else if (g && g.freeMiB != null) {
    gpuVal = '可用 ' + fmtGib(g.freeMiB) + ' GiB · <b>' + esc(g.name || 'GPU') + '</b>';
  } else {
    gpuVal = '显存信息不可用';
  }

  box.innerHTML =
    '<div>' +
      '<div class="k">显存</div>' +
      '<div class="bar" title="' + (total > 0 ? pct.toFixed(0) + '%' : '') + '"><i class="' + (pct > 92 ? 'hot' : '') + '" style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="val">' + gpuVal + '</div>' +
    '</div>' +
    '<div>' +
      '<div class="k">槽位</div>' +
      '<div class="val"><b>' + (S.slots.used || 0) + ' / ' + (S.slots.total || 0) + '</b> 已占 · 实例 <b>' +
        S.instances.length + '</b> 个 · 引擎 <b>' + S.engines.length + '</b> 个</div>' +
    '</div>';
}

function renderEngines() {
  const host = el('engines');
  if (!host) return;

  const groups = S.engines.map((engine) => ({
    engine,
    models: S.models.filter((m) => (m.engineId || '') === engine.id),
  }));

  /* 模型指向了不存在的引擎：给一个兜底分组，别让模型凭空消失 */
  const known = new Set(S.engines.map((e) => e.id));
  const unknown = new Map();
  for (const m of S.models) {
    if (known.has(m.engineId)) continue;
    const key = m.engineId || '__unknown__';
    if (!unknown.has(key)) {
      unknown.set(key, {
        engine: {
          id: key,
          label: key === '__unknown__' ? '未知引擎' : ('未知引擎 · ' + key),
          file: '', fileSlots: [], argv: [], mode: 'custom',
          missing: true, orphan: true,
        },
        models: [],
      });
    }
    unknown.get(key).models.push(m);
  }
  for (const g of unknown.values()) groups.push(g);

  if (!groups.length) {
    if (!S.loaded && !S.offline) {
      host.innerHTML = '<div class="empty">正在读取状态…</div>';
      return;
    }
    if (S.offline) {
      host.innerHTML = '<div class="empty">连不上控制面；拿到状态后这里会显示引擎列表。</div>';
      return;
    }
    host.innerHTML = '<div class="empty">' + (EMBED
      ? '还没有导入任何引擎。请在独立窗口打开控制台导入。'
      : '还没有导入任何引擎。<br>点下面的「+ 导入整合包」开始，或用「接入 DSH」先看看网关配置。') + '</div>';
    return;
  }

  host.innerHTML = groups.map(renderEngineCard).join('');
}

function renderEngineCard(group) {
  const engine = group.engine;
  const models = group.models;
  const insts = engine.orphan ? [] : S.instances.filter((i) => i.engineId === engine.id);
  const missing = !!(engine.missing || S.engineMissing.has(engine.id));
  const st = engineState(engine, insts, missing);
  /* 云端引擎一律展开：缺 key 时用户要看到补填的输入框，已配好时也要看到
     「清除」入口 —— 云端没有启动/停止可点，折叠起来就等于什么都没有 */
  const open = S.open.has(engine.id) || engine.mode === 'remote';

  let estate = '未运行';
  if (engine.mode === 'remote') {
    /* 云端引擎起不来也不用起，唯一会坏的就是没配 key —— 直接说在界面上 */
    estate = engine.hasKey === false ? '云端 · 缺 API key' : '云端 · 不需要启动';
  } else if (missing) {
    estate = '引擎文件缺失';
  } else {
    const ready = insts.filter((i) => i.status === 'ready');
    const starting = insts.filter((i) => i.status === 'starting');
    const errors = insts.filter((i) => i.status === 'error');
    if (ready.length) {
      const labels = [];
      for (const inst of ready) {
        for (const mid of inst.modelIds) {
          const m = S.models.find((x) => x.id === mid);
          const label = m ? (m.label || m.id) : mid;
          if (labels.indexOf(label) < 0) labels.push(label);
        }
      }
      const short = labels.slice(0, 2).map((x) => trunc(x, 18)).join('、') + (labels.length > 2 ? ' 等' : '');
      estate = ready.length + ' 个在跑 · ' + (short || '');
    } else if (starting.length) {
      estate = starting.length + ' 个启动中';
    } else if (errors.length) {
      estate = errors.length + ' 个失败';
    } else if (insts.length) {
      estate = insts.length + ' 个实例';
    }
  }

  const ext = insts.filter((i) => i.externalChange);
  const extNote = ext.length
    ? '<div class="engnote">检测到外部加载，已同步' + (ext[0].port ? '（:' + ext[0].port + '）' : '') + '</div>'
    : '';

  const rows = models.map((m) => renderModelRow(m, engine)).join('');
  const add = engine.orphan ? '' : '<div class="addmodel" data-engine="' + escAttr(engine.id) + '">+ 添加模型</div>';

  return '<div class="engine' + (open ? ' open' : '') + '" data-engine="' + escAttr(engine.id) + '">' +
    '<div class="ehead">' +
      '<span class="dot ' + (DOT[st] || 'off') + '"></span>' +
      '<span class="ename">' + esc(engine.label) + '</span>' +
      '<span class="estate">' + esc(estate) + '</span>' +
      '<span class="espacer"></span>' +
      '<button type="button" class="btn ghost" data-act="log" data-engine="' + escAttr(engine.id) + '">日志</button>' +
      /* 删除入口：以前只有"引擎文件缺失"时才出现删除按钮，正常引擎根本删不掉，
         用户没法推倒重来。现在每个引擎卡片都有；有模型时点两次（第二次连模型一起删）。 */
      (S.confirmDelete === engine.id
        ? '<button type="button" class="btn danger" data-act="delete-engine-yes" data-engine="' + escAttr(engine.id) + '">确定删除' +
          (models.length ? '（含 ' + models.length + ' 个模型）' : '') + '</button>'
        : '<button type="button" class="btn danger" data-act="delete-engine" data-engine="' + escAttr(engine.id) + '">删除</button>') +
      '<span class="chev">▶</span>' +
    '</div>' +
    '<div class="models">' +
      engineMissingBlock(engine, missing, models.length) +
      remoteKeyBlock(engine) +
      multiBar(engine) +
      extNote +
      rows +
      add +
    '</div>' +
  '</div>';
}

/**
 * 云端引擎的 key 区块。
 *
 * 只在缺 key 时展开输入框（有 key 就安静待着），因为这是云端唯一会坏的地方：
 * 网关在没有 key 时回 503 remote_key_missing，用户得能就地补上，而不是删掉重建引擎。
 */
function remoteKeyBlock(engine) {
  if (engine.mode !== 'remote' || engine.orphan) return '';
  const id = escAttr(engine.id);
  if (engine.hasKey) {
    return '<div class="engnote">API key 已配置' +
      (engine.apiKeyEnv ? '（也读环境变量 <span class="mono">' + esc(engine.apiKeyEnv) + '</span>，它优先）' : '') +
      '<button type="button" class="btn ghost" data-act="cloud-key-clear" data-engine="' + id + '">清除</button>' +
    '</div>';
  }
  return '<div class="warnrow">⚠ 还没配 API key，网关转发会回 503' +
    '<div class="warnacts">' +
      '<input class="pathin" id="cloud-key-' + id + '" type="password" spellcheck="false" placeholder="sk-...">' +
      '<button type="button" class="btn" data-act="cloud-key-save" data-engine="' + id + '">保存 key</button>' +
    '</div>' +
  '</div>';
}

function engineState(engine, insts, missing) {
  if (missing) return 'error';
  /* 有活的实例时优先显示活的状态：重试后旧 error 实例可能还在 */
  if (insts.some((i) => i.status === 'starting')) return 'starting';
  if (insts.some((i) => i.status === 'ready')) return 'ready';
  if (insts.some((i) => i.status === 'stopping')) return 'stopping';
  if (insts.some((i) => i.status === 'error')) return 'error';
  return 'idle';
}

function engineMissingBlock(engine, missing, modelCount) {
  if (!missing) return '';
  const confirm = S.confirmDelete === engine.id;
  const buttons = [];
  if (!engine.orphan) {
    buttons.push('<button type="button" class="btn" data-act="reselect-engine" data-engine="' + escAttr(engine.id) + '">重新选择</button>');
  }
  if (confirm) {
    buttons.push('<button type="button" class="btn danger" data-act="delete-engine-yes" data-engine="' + escAttr(engine.id) + '">确定删除</button>');
    buttons.push('<button type="button" class="btn ghost" data-act="delete-engine-no">取消</button>');
  } else {
    buttons.push('<button type="button" class="btn danger" data-act="delete-engine" data-engine="' + escAttr(engine.id) + '">删除</button>');
  }
  const owned = Number(modelCount) || 0;
  return '<div class="warnrow">⚠ 引擎文件缺失' +
    (engine.file ? '：<span class="mono">' + esc(engine.file) + '</span>' : '') +
    (engine.orphan ? '<br>模型指向的引擎档案不存在。' : '') +
    '<div class="warnacts">' + buttons.join('') + '</div>' +
    (confirm && owned > 0
      ? '<div class="note" style="color:#e8c87a">再点一次就是真删了：会连下面 ' + owned + ' 个模型一起删掉（后端 ?force=1）。</div>'
      : '') +
  '</div>';
}

function renderModelRow(model, engine) {
  const inst = S.byModel.get(model.id) || null;
  const st = inst ? inst.status : 'idle';
  const busy = S.busy.has(model.id) || (inst && S.busy.has(inst.id));

  const chips = [];
  if (KIND_BADGE[model.kind]) chips.push('<span class="chip">' + KIND_BADGE[model.kind] + '</span>');
  if (engine.mode === 'remote') chips.push('<span class="chip">云端</span>');
  if ((model.caps && model.caps.mtp) || (model.params && model.params.mtp)) chips.push('<span class="chip">MTP</span>');
  if ((model.caps && model.caps.vision) || (model.params && model.params.vision)) chips.push('<span class="chip">视觉</span>');
  if (model.caps && model.caps.tools === false) chips.push('<span class="chip warn">仅聊天</span>');
  if (inst && inst.externalChange) chips.push('<span class="chip warn">外部加载</span>');
  if (S.pendingClose.has(model.id)) chips.push('<span class="chip warn">等结束后关闭</span>');

  /* 自定义引擎但 argv / env 没配齐：加载必然失败，先把话说在前面，别让人点了才红 */
  const gap = engineParamsGap(engine);
  if (gap) chips.push('<span class="chip warn" title="' + escAttr(gap) + '">缺参数</span>');

  /* package 引擎：启动脚本写死了模型文件，点别的模型实际也是跑那一个 */
  let scriptMismatch = false;
  if (engine.mode === 'package' && engine.scriptModelFile) {
    const mine = model.files && (model.files.model || Object.values(model.files)[0]);
    if (mine && basename(String(mine)).toLowerCase() !== basename(String(engine.scriptModelFile)).toLowerCase()) {
      scriptMismatch = true;
    }
  }
  if (scriptMismatch) {
    chips.push('<span class="chip warn" title="启动脚本实际加载 ' + escAttr(engine.scriptModelFile) + '">脚本跑的是 ' + esc(basename(String(engine.scriptModelFile))) + '</span>');
  }
  const block = gap || (scriptMismatch
    ? '启动脚本实际加载的是 ' + basename(String(engine.scriptModelFile)) + '，不是这个模型'
    : '');

  const meta = modelMeta(model, inst, st, engine);
  /* 脚本写死的是别的模型：不给"加载"，直接给"改成按参数运行"——点了以后就能点谁起谁 */
  const acts = scriptMismatch
    ? '<button type="button" class="btn" data-act="convert-engine" data-engine="' + escAttr(engine.id) +
      '" title="把启动脚本里的配方抄成「按参数运行」，之后点哪个模型就起哪个">改成按参数运行</button>'
    : modelActions(model, inst, st, engine, busy, block);

  /* 多模型引擎才出勾选框。已经在跑的模型没法再被拉进一个新实例，
     所以只给 idle / error 的模型勾选（ready / starting 的实例由行内按钮管）。 */
  let pick = '';
  if (multiModelEngine(engine)) {
    const selectable = st === 'idle' || st === 'error';
    const checked = selectable && multiSelection(engine.id).has(model.id);
    pick = '<input type="checkbox" class="mpick" data-act="multi-toggle" data-engine="' + escAttr(engine.id) +
      '" data-model="' + escAttr(model.id) + '"' + (checked ? ' checked' : '') +
      (selectable ? '' : ' disabled') + ' title="' + (selectable ? '勾上一起加载到一个实例里' : '这个模型已经有实例了') + '">';
  }

  return '<div class="m" data-model="' + escAttr(model.id) + '"' +
      (inst ? ' data-instance="' + escAttr(inst.id) + '"' : '') + '>' +
    pick +
    '<span class="dot ' + (DOT[st] || 'off') + '"></span>' +
    '<div class="info">' +
      '<div class="nm">' + esc(model.label || model.id) + ' ' + chips.join('') + '</div>' +
      '<div class="meta">' + meta + '</div>' +
    '</div>' +
    '<div class="acts">' + acts + '</div>' +
  '</div>';
}

/** 这个引擎能不能一个实例带多个模型（D1：只支持单槽位引擎） */
function multiModelEngine(engine) {
  if (!engine || engine.orphan || engine.mode === 'remote') return false;
  return engine.supportsMultiModel === true && Boolean(engine.modelsArg);
}

/**
 * 自定义引擎"参数没配齐"的判定。
 *
 * package 模式跑的是启动脚本，argv/env 不参与启动，不适用；只有 custom 才看这两样。
 * 返回空串 = 没问题；返回一句话 = 缺什么（拿来当禁用按钮的 title）。
 */
function engineParamsGap(engine) {
  if (!engine || engine.orphan || engine.mode !== 'custom') return '';
  if (!engine.file) return '缺引擎文件';
  if (!Array.isArray(engine.argv) || engine.argv.length === 0) return '缺参数：引擎没有 argv 模板';
  if (!engine.env || Object.keys(engine.env).length === 0) return '缺参数：引擎没有配环境变量（env）';
  return '';
}

function multiSelection(engineId) {
  if (!S.multiSel.has(engineId)) S.multiSel.set(engineId, new Set());
  return S.multiSel.get(engineId);
}

/**
 * 多模型引擎的「加载所选」条。
 *
 * 只在支持多模型的引擎上出现 —— 多槽位引擎（Strata）一个进程只吃一个模型，
 * 给它显示勾选框只会让人白勾。
 */
function multiBar(engine) {
  if (!multiModelEngine(engine)) return '';
  const picked = multiSelection(engine.id);
  const n = picked.size;
  const id = escAttr(engine.id);
  if (n === 0) {
    return '<div class="multibar"><span class="mbhint">勾选多个模型可以塞进同一个实例（省一次加载、共用一个端口）</span></div>';
  }
  const names = [...picked].map((mid) => {
    const m = S.models.find((x) => x.id === mid);
    return m ? (m.label || m.id) : mid;
  });
  const gap = engineParamsGap(engine);
  const blocked = n < 2 || Boolean(gap);
  const why = gap || '至少勾两个才叫多模型；只勾一个请用行内的「加载」';
  return '<div class="multibar">' +
    '<span class="mbhint">已选 ' + n + ' 个：' + esc(names.join('、')) + '</span>' +
    '<span class="espacer"></span>' +
    '<button type="button" class="btn ghost" data-act="multi-clear" data-engine="' + id + '">清空</button>' +
    '<button type="button" class="btn primary" data-act="multi-load" data-engine="' + id + '"' +
      (blocked ? ' disabled title="' + escAttr(why) + '"' : '') +
    '>加载所选（' + n + '）</button>' +
  '</div>';
}

function modelMeta(model, inst, st, engine) {
  if (engine.mode === 'remote') return esc('remote · 常驻，不用加载');
  if (!inst) {
    let text = 'idle';
    if (engine.fileSlots && engine.fileSlots.length > 1) text += ' · ' + engine.fileSlots.length + ' 个文件槽位';
    return esc(text);
  }
  if (st === 'ready') {
    const bits = ['ready'];
    if (inst.port) bits.push(':' + inst.port);
    if (inst.pool) bits.push('池 ' + fmtInt(inst.pool));
    const t0 = inst.readyAt || inst.startedAt;
    if (t0) bits.push('已运行 ' + fmtDur(Date.now() - t0));
    if (inst.inflight) bits.push(inst.inflight + ' 个在飞');
    return esc(bits.join(' · '));
  }
  if (st === 'starting') {
    const start = inst.startedAt || firstSeenAt(inst.id);
    const secs = Math.max(0, Math.round((Date.now() - start) / 1000));
    let html = 'starting · 已等 <span data-elapsed="' + start + '">' + secs + '</span> 秒';
    if (inst.logTail) html += ' · 日志 <span title="' + escAttr(inst.logTail) + '">' + esc(trunc(inst.logTail, 70)) + '</span>';
    return html;
  }
  if (st === 'stopping') return 'stopping · 正在停';
  if (st === 'error') {
    const full = inst.lastError || '';
    return 'error' + (full
      ? ' · <span style="color:var(--red)" title="' + escAttr(full) + '">' + esc(trunc(full, 90)) + '</span>'
      : '');
  }
  return esc(st);
}

function modelActions(model, inst, st, engine, busy, gap) {
  if (engine.mode === 'remote') return ''; /* 云端模型没有加载/关闭 */
  const dis = busy ? ' disabled' : '';
  const md = escAttr(model.id);
  const loadDis = gap ? ' disabled' : dis;
  const loadTitle = gap ? ' title="' + escAttr(gap) + '"' : '';

  if (st === 'ready' && inst && inst.external) {
    /* 外部进程：只显示，不给关闭（关了也杀不掉） */
    const acts = [];
    const tpl0 = inst.webUI || engine.webUI;
    if (tpl0) acts.push('<button type="button" class="btn ghost" data-act="webui" data-model="' + md + '" data-instance="' + escAttr(inst.id) + '">界面</button>');
    acts.push('<span class="chip" title="这是外部起的进程，LACI 只匹配到它，不负责关">外部运行</span>');
    return acts.join('');
  }
  if (st === 'ready' && inst) {
    const acts = [];
    const tpl = inst.webUI || engine.webUI;
    if (tpl) {
      acts.push('<button type="button" class="btn ghost" data-act="webui" data-model="' + md + '" data-instance="' + escAttr(inst.id) + '">界面</button>');
    }
    acts.push('<button type="button" class="btn danger" data-act="close" data-model="' + md + '"' + dis + '>关闭</button>');
    return acts.join('');
  }
  if (st === 'starting' && inst) {
    return '<button type="button" class="btn" data-act="cancel" data-instance="' + escAttr(inst.id) + '"' + dis + '>取消</button>';
  }
  if (st === 'stopping') return '';
  if (st === 'error' && inst) {
    return '<button type="button" class="btn ghost" data-act="log" data-instance="' + escAttr(inst.id) + '">日志</button>' +
      '<button type="button" class="btn" data-act="load" data-model="' + md + '"' + loadDis + loadTitle + '>重试</button>';
  }
  return '<button type="button" class="btn" data-act="load" data-model="' + md + '"' + loadDis + loadTitle + '>加载</button>';
}

function firstSeenAt(id) {
  if (!S.firstSeen.has(id)) S.firstSeen.set(id, Date.now());
  return S.firstSeen.get(id);
}

/* ---------- 多模型实例（A5） ---------- */

/**
 * 勾选状态只认 S.multiSel，不认 DOM。
 *
 * 点击委托里对 [data-act] 做了 preventDefault（防止行点击穿透到配置页），
 * 这也把复选框的原生切换一起拦掉了 —— 所以这里**不能**读 el.checked 来做反向切换，
 * 只能按当前集合取反，再让 render() 把 checked 属性重写一遍。
 */
function toggleMulti(engineId, modelId) {
  if (!engineId || !modelId) return;
  const picked = multiSelection(engineId);
  if (picked.has(modelId)) picked.delete(modelId);
  else picked.add(modelId);
  render();
}

/**
 * 把勾选的模型装进同一个实例。
 *
 * 后端 POST /api/instances 收 `modelIds`，argv 里会拼成 `--models a,b`（modelsArg）。
 * 和单模型加载一样走「软闸门」：显存不够先问，不硬拦。
 */
async function loadMulti(engineId, force) {
  const picked = [...multiSelection(engineId)];
  if (picked.length < 2) { toast('至少勾两个模型才叫多模型；只加载一个请用行内的「加载」', 'info'); return; }
  const engine = S.engineById.get(engineId);
  if (!engine) return;
  const gap = engineParamsGap(engine);
  if (gap) { toast(gap + '，先在引擎档案里配齐再加载', 'err'); return; }

  S.busy.add(engineId);
  render();
  try {
    if (!force) {
      const est = await estimateMany(picked);
      if (est && estimateShort(est)) {
        S.busy.delete(engineId);
        render();
        openVram(engineId, est, picked);
        return;
      }
    }
    const payload = { modelIds: picked, wait: false };
    if (force) payload.force = true;
    const r = await api('/instances', { method: 'POST', body: payload });
    const inst = (r && r.instance) || null;
    if (inst && inst.id) S.byModel.set(inst.id, inst);
    multiSelection(engineId).clear();
    toast('已开始加载 ' + picked.length + ' 个模型到一个实例', 'ok');
    await refresh();
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body && err.body.requiresConfirm && !force) {
      S.busy.delete(engineId);
      render();
      openVram(engineId, err.body.estimate || err.body.detail || {}, picked);
      return;
    }
    toast('多模型加载失败：' + (err && err.message ? err.message : err), 'err');
  } finally {
    S.busy.delete(engineId);
    render();
  }
}

async function estimateMany(modelIds) {
  try {
    const res = await api('/estimate', { method: 'POST', body: { modelIds } });
    return res && typeof res === 'object' && res.estimate ? res.estimate : res;
  } catch (err) {
    return null;
  }
}

/* 加载中的日志尾随：优先用 /api/state 里的 logTail，没有再试日志接口（404 就停） */
function fetchStartingLogs() {
  for (const inst of S.instances) {
    if (inst.status !== 'starting' || inst.logTail) continue;
    if (S.logDisabled.has(inst.id) || S.logBusy.has(inst.id)) continue;
    S.logBusy.add(inst.id);
    api('/instances/' + encodeURIComponent(inst.id) + '/log?tail=8')
      .then((data) => {
        const lines = logLinesOf(data);
        if (lines && lines.length) {
          inst.logTail = trunc(lines[lines.length - 1], 120);
          render();
        }
      })
      .catch(() => { S.logDisabled.add(inst.id); })
      .finally(() => { S.logBusy.delete(inst.id); });
  }
}

function logLinesOf(data) {
  if (Array.isArray(data)) return data.map((x) => String(x));
  if (typeof data === 'string') {
    /* 静态服务兜底会把 HTML 当 200 返回，别把它当日志 */
    if (/^\s*</.test(data)) return null;
    return data.split(/\r?\n/).filter((x) => x !== '');
  }
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data.lines)) return data.lines.map((x) => (typeof x === 'string' ? x : String((x && (x.line || x.text)) || '')));
  if (Array.isArray(data.tail)) return data.tail.map((x) => String(x));
  if (typeof data.log === 'string') return data.log.split(/\r?\n/).filter((x) => x !== '');
  if (typeof data.text === 'string') return data.text.split(/\r?\n/).filter((x) => x !== '');
  return null;
}

/* ---------- 6. 主界面动作 ---------- */

async function actLoad(modelId, force) {
  if (!modelId || S.busy.has(modelId)) return;
  const model = S.models.find((m) => m.id === modelId);
  if (!model) return;
  const engine = S.engineById.get(model.engineId);
  if (engine && engine.mode === 'remote') { toast('云端模型不需要加载，它一直在', 'info'); return; }
  const gap = engineParamsGap(engine);
  if (gap) { toast(gap + '，先在引擎档案里配齐再加载', 'err'); return; }
  if (engine && engine.mode === 'package' && engine.scriptModelFile) {
    const mine = model.files && (model.files.model || Object.values(model.files)[0]);
    if (mine && basename(String(mine)).toLowerCase() !== basename(String(engine.scriptModelFile)).toLowerCase()) {
      toast('这个引擎的启动脚本加载的是 ' + basename(String(engine.scriptModelFile)) + '，不是 ' + (model.label || model.id), 'err');
      return;
    }
  }
  S.busy.add(modelId);
  render();
  try {
    /* 重试前先把上一次的 error 实例清掉，避免列表里堆一条永远 red 的记录 */
    const stale = S.byModel.get(modelId);
    if (stale && stale.status === 'error') {
      try { await api('/instances/' + encodeURIComponent(stale.id) + '?force=1', { method: 'DELETE' }); }
      catch (err) { /* 已经没了就算了 */ }
    }
    /* 加载前预检：预估不够就弹确认（§5.10 是「问」不是「拦」） */
    if (!force) {
      const est = await estimate(modelId);
      if (est && estimateShort(est)) {
        S.busy.delete(modelId);
        render();
        openVram(modelId, est);
        return;
      }
    }
    /* wait:false 让后端起进程后立刻返回，界面靠轮询展示 starting / 日志 / 取消 */
    const payload = { modelId, wait: false };
    if (force) payload.force = true;
    const r = await api('/instances', { method: 'POST', body: payload });
    const closed = (r && r.closedExternal) || [];
    const suffix = closed.length ? '（已自动关闭外部进程 ' + closed.map((c) => ':' + c.port).join('、') + '）' : '';
    toast((force ? '已强行加载 ' : '已开始加载 ') + (model.label || modelId) + suffix, 'ok');
  } catch (err) {
    /* 409 + requiresConfirm 是软闸门（§5.10）：弹确认，而不是当错误 */
    if (err instanceof ApiError && err.status === 409 && err.body && err.body.requiresConfirm) {
      if (!force) {
        S.busy.delete(modelId);
        render();
        openVram(modelId, err.body.estimate || err.body.detail || {});
        return;
      }
      /* force 都带了还要求确认：后端没接受 force，如实报错，别让用户循环点 */
    }
    /* 启动文件没了：M6 没给 missing 字段，这里按错误信息补一个界面标记 */
    if (engine && /启动文件|ENOENT|no such file|文件不存在|spawn/i.test(err.message || '')) {
      S.engineMissing.add(engine.id);
    }
    handleError(err, '加载失败');
  } finally {
    S.busy.delete(modelId);
    render();
    refresh();
  }
}

/* 在飞请求：M2 目前不在状态里给 inflight，退一步问网关的 /health（单实例场景够用） */
async function gatewayInflight() {
  try {
    const res = await api('/health');
    const gw = res && res.gateway && typeof res.gateway === 'object' ? res.gateway : res;
    const idle = gw && gw.idle && typeof gw.idle === 'object' ? gw.idle : {};
    const n = Number(idle.inflight);
    return {
      inflight: Number.isFinite(n) ? n : 0,
      active: gw && gw.active ? String(gw.active) : '',
    };
  } catch (err) {
    return null;
  }
}

async function actClose(modelId) {
  const inst = S.byModel.get(modelId);
  if (!inst) { refresh(); return; }
  if ((inst.inflight || 0) > 0) {
    openInflight(modelId, inst, inst.inflight);
    return;
  }
  const gw = await gatewayInflight();
  if (gw && gw.inflight > 0 && (!gw.active || gw.active === modelId)) {
    openInflight(modelId, inst, gw.inflight);
    return;
  }
  doClose(inst, modelId, false);
}

async function doClose(inst, modelId, force) {
  if (!inst || S.closing.has(inst.id)) return;
  S.closing.add(inst.id);
  S.busy.add(inst.id);
  render();
  try {
    await api('/instances/' + encodeURIComponent(inst.id) + (force ? '?force=1' : ''), { method: 'DELETE' });
    toast(force ? '已强制关闭' : '已关闭', 'ok');
  } catch (err) {
    const count = inflightFrom(err.body);
    const looksInflight = (err instanceof ApiError && err.status === 409) ||
      /请求|in-?flight|在飞/i.test(err.message || '') ||
      count > 0;
    if (looksInflight && !force) {
      S.closing.delete(inst.id);
      S.busy.delete(inst.id);
      render();
      openInflight(modelId, inst, count);
      return;
    }
    if (err instanceof ApiError && err.status === 404) toast('实例已经不在了', 'info');
    else handleError(err, '关闭失败');
  } finally {
    S.closing.delete(inst.id);
    S.busy.delete(inst.id);
    render();
    refresh();
  }
}

async function actCancel(instanceId) {
  const inst = S.instById.get(instanceId) || S.instances.find((i) => i.id === instanceId);
  if (!inst) { refresh(); return; }
  S.busy.add(inst.id);
  render();
  try {
    await api('/instances/' + encodeURIComponent(inst.id) + '?force=1', { method: 'DELETE' });
    toast('已取消启动', 'ok');
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) toast('实例已经不在了', 'info');
    else handleError(err, '取消失败');
  } finally {
    S.busy.delete(inst.id);
    render();
    refresh();
  }
}

/* 预估是建议不是闸门：接口没实现就直接加载。M6 返回的是 { ok, estimate } */
async function estimate(modelId) {
  try {
    const res = await api('/estimate', { method: 'POST', body: { modelId } });
    return res && typeof res === 'object' && res.estimate ? res.estimate : res;
  } catch (err) {
    return null;
  }
}

function inflightFrom(body) {
  if (!body || typeof body !== 'object') return 0;
  const candidates = [body.inflight, body.inflightRequests, body.pending, body.active,
    body.data && body.data.inflight, body.detail && body.detail.inflight];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function openWebUI(modelId, instanceId) {
  const inst = S.instById.get(instanceId) || S.byModel.get(modelId);
  const model = S.models.find((m) => m.id === modelId);
  const engine = model ? S.engineById.get(model.engineId) : null;
  if (!inst) { toast('实例不在跑了', 'info'); return; }
  const tpl = inst.webUI || (engine && engine.webUI);
  if (!tpl) { toast('这个引擎没配 webUI', 'info'); return; }
  if (!inst.port) { toast('实例还没有端口', 'info'); return; }
  const url = String(tpl).replace(/\{port\}/g, String(inst.port));
  window.open(url, '_blank', 'noopener');
}

function openLogFor(dataset) {
  let inst = null;
  if (dataset.instance) inst = S.instById.get(dataset.instance) || S.instances.find((i) => i.id === dataset.instance);
  else if (dataset.model) inst = S.byModel.get(dataset.model);
  else if (dataset.engine) inst = S.instances.find((i) => i.engineId === dataset.engine);
  if (!inst) { toast('还没有实例的日志可看；先加载一个模型', 'info'); return; }
  const model = inst.modelIds.length ? S.models.find((m) => m.id === inst.modelIds[0]) : null;
  openLog(inst.id, (model ? (model.label || model.id) + ' · ' : '') + '运行日志');
}

function deleteEngine(engineId) {
  S.confirmDelete = '';
  S.engineMissing.delete(engineId);
  const owned = S.models.filter((m) => m.engineId === engineId).length;
  (async () => {
    try {
      /* 有模型就走 force：后端会连模型一起删（确认那一步在按钮上做，见 data-act="delete-engine"） */
      await api('/engines/' + encodeURIComponent(engineId) + (owned > 0 ? '?force=1' : ''), { method: 'DELETE' });
      await sleep(120);
      await refresh();
      if (S.engineById.has(engineId)) toast('没删掉：' + engineId, 'err');
      else toast('已删除引擎 ' + engineId + (owned > 0 ? '（连同 ' + owned + ' 个模型）' : ''), 'ok');
    } catch (err) {
      handleError(err, '删除失败');
    }
    renderEngines();
    if (cfgCtx) renderCfg();
  })();
}

/**
 * 选真实路径：默认弹 Windows 原生对话框，起不来再退回页面内选择器。
 *
 * 浏览器给不了真实路径（<input type=file> 只有假路径，File System Access 只给
 * 句柄），所以由服务端在这台机器上弹原生框（POST /api/dialog，PowerShell +
 * Windows.Forms）。它能弹、能选，也有把窗口顶到前台的补偿；但 Windows 的前台锁
 * 不保证它一定在前面，所以等待时盖一层薄罩子，罩子上留「用页面内选择」的出口。
 *
 * 页面内选择器（下面这一大段）就是那个出口：后端 GET /api/fs 只读列目录。
 * 原生接口 404 / PowerShell 起不来时也会自动退到它 —— 点了没反应是最糟的失败。
 */

/* ---------- 6.5 选路径：系统对话框优先，页面内兜底 ---------- */

/** 文件扩展名 → 图标。只是个视觉提示，不参与任何判断。 */
const PICK_ICON = {
  '.ninfer': '◈', '.gguf': '◈', '.safetensors': '◈',
  '.exe': '⚙', '.bat': '⌨', '.cmd': '⌨', '.ps1': '⌨', '.sh': '⌨', '.py': '🐍',
  '.json': '{}', '.yaml': '{}', '.yml': '{}', '.toml': '{}', '.ini': '{}',
  '.dll': '▪', '.log': '≡', '.txt': '≡', '.md': '≡',
  '.zip': '▣', '.7z': '▣', '.tar': '▣', '.gz': '▣',
  '.venv': '🐍', '.git': '⑂', 'node_modules': '▣',
};

function pickIcon(entry) {
  if (entry.kind === 'dir') return PICK_ICON[entry.name] || '📁';
  const ext = (entry.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  return PICK_ICON[ext] || '·';
}

/** 读"上次选过的路径"（最近 3 个），给选择器做快捷入口 */
function loadPickedHistory() {
  try {
    const raw = JSON.parse(localStorage.getItem('laci.ui.picked') || '[]');
    return Array.isArray(raw) ? raw.filter((p) => typeof p === 'string' && p) : [];
  } catch (err) {
    return [];
  }
}

/** 抽一个"从哪开始"的目录：输入框里的值优先，其次当前浏览的目录 */
function pickStartPath(node, mode) {
  const raw = cleanPathText(node.value || '');
  if (!raw) return '';
  /* 选文件时输入框里可能是文件路径：从它所在目录开始 */
  if (mode !== 'dir') {
    const ext = (raw.match(/\.[^.\\/]+$/) || [''])[0];
    if (ext) return dirname(raw);
  }
  return raw;
}

async function openPicker(targetId, mode) {
  const node = el(targetId);
  if (!node) return;

  const title = mode === 'dir' ? '选择文件夹' : '选择文件';
  picker = {
    targetId,
    mode: mode === 'dir' ? 'dir' : 'file',
    dir: '',
    parent: null,
    entries: [],
    sel: -1,
    loading: false,
    returnFocus: node,
    /* 曾经选中过的路径（下次打开给出快捷入口） */
    picked: loadPickedHistory(),
  };

  const box = el('picker');
  const veil = el('pick-veil');
  el('picker-title').textContent = title;
  el('picker-target').textContent = targetId;
  el('picker-count').textContent = '';
  const nameInput = el('picker-name');
  nameInput.value = '';
  nameInput.hidden = picker.mode === 'dir';
  el('picker-ok').textContent = picker.mode === 'dir' ? '用这个文件夹' : '用这个';

  box.hidden = false;
  veil.hidden = false;
  document.body.classList.add('modal-open');

  /* 关键：把焦点拿过来。这样 Esc / 方向键 / 回车全都落在这个面板上，
     不会跑去主列表触发别的动作。 */
  try { box.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ }

  await pickNavigate(pickStartPath(node, picker.mode));
}

function closePicker() {
  const box = el('picker');
  if (box) box.hidden = true;
  el('pick-veil').hidden = true;
  const back = picker && picker.returnFocus;
  picker = null;
  if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
  if (back) {
    /* 焦点还给刚才那个输入框：用户能立刻接着粘贴或改 */
    setTimeout(() => { try { back.focus({ preventScroll: false }); } catch (err) { /* 忽略 */ } }, 0);
  }
}

/** 目标输入框闪一下，表示"填的是这里" */
function flashTarget(node) {
  if (!node) return;
  node.classList.remove('target-flash');
  /* 强制一次回流，同一个元素连点两次也能重新播放动画 */
  void node.offsetWidth;
  node.classList.add('target-flash');
  setTimeout(() => node.classList.remove('target-flash'), 1400);
}

function renderPickerQuick() {
  const box = el('picker-quick');
  if (!box) return;
  box.innerHTML = '';
  if (!picker) return;
  const items = [];
  for (const p of picker.picked) items.push({ p, icon: '★', title: '上次选的：' + p });
  /* 模型目录：能猜到就猜（引擎的 cwd 或者模型文件所在处），猜不到就不显示 */
  for (const p of quickDirs()) items.push({ p, icon: '↪', title: '常用：' + p });
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.icon + ' ' + item.p;
    b.title = item.title;
    b.addEventListener('click', () => {
      const treatAsDir = !/\.[^.\\/]+$/.test(item.p);
      if (treatAsDir) pickNavigate(item.p);
      else pickCommit(item.p);
    });
    box.appendChild(b);
  }
}

/** 从已经加载的引擎 / 模型里推断几个常用目录，省得每次从盘符点起 */
function quickDirs() {
  const out = [];
  const push = (p, base, name) => {
    if (!p) return;
    const dir = base ? dirname(p) : p;
    if (!dir || out.includes(dir)) return;
    out.push(dir);
  };
  for (const eng of S.engines.slice(0, 3)) push(eng.file || '', true);
  for (const m of S.models.slice(0, 3)) {
    const files = m.files || {};
    const first = Object.values(files).find((v) => typeof v === 'string' && v);
    push(first || '', true);
  }
  return out.slice(0, 4);
}

async function pickNavigate(dir) {
  if (!picker || picker.loading) return;
  picker.loading = true;
  const list = el('picker-list');
  list.innerHTML = '<div class="pkg-empty">读取中…</div>';
  try {
    const q = dir ? ('?dir=' + encodeURIComponent(dir) + '&mode=' + picker.mode) : '';
    const r = await api('/fs' + q, { timeoutMs: 15000 });
    if (!picker) return;
    picker.dir = r.dir || '';
    picker.parent = r.parent == null ? null : r.parent;
    picker.entries = Array.isArray(r.entries) ? r.entries : [];
    picker.truncated = Boolean(r.truncated);
    picker.sel = -1;
    drawPicker(r.select);
  } catch (err) {
    if (!picker) return;
    /* 404 基本只有一个原因：控制台是在旧代码上启动的，页面拿到的是新 app.js。
       不写清楚的话，用户只会看到"没有这个接口"然后以为新功能坏了。 */
    const stale = err instanceof ApiError && err.status === 404;
    list.innerHTML = '<div class="pkg-empty">读不了这个目录：' + esc(err.message) +
      (stale ? '<br>控制台没有 /api/fs：它多半是在旧代码上启动的，重启一下 node server.mjs。' : '') +
      '<br>可以直接在上面粘贴完整路径，或者用「盘符」重新开始。</div>';
    toast('读不了目录：' + err.message, 'err');
  } finally {
    picker.loading = false;
  }
}

function drawPicker(selectPath) {
  if (!picker) return;
  const list = el('picker-list');
  const pathIn = el('picker-path');
  pathIn.value = picker.dir || '';
  el('picker-up').disabled = picker.parent === null;

  /* 当前这块的筛选输入框内容 = 文件名前缀过滤，选文件夹时不做过滤 */
  const filter = (picker.mode === 'file' ? String(el('picker-name').value || '').trim() : '').toLowerCase();
  const shown = filter
    ? picker.entries.filter((e) => e.kind === 'dir' || e.name.toLowerCase().includes(filter))
    : picker.entries;

  el('picker-count').textContent = picker.dir ? (shown.length + ' 项') : '盘符';

  list.innerHTML = '';
  if (!shown.length) {
    list.innerHTML = '<div class="pkg-empty">' +
      (picker.dir ? '这个目录里没有可选的条目。' : '读不到盘符。') +
      '</div>';
  }

  shown.forEach((entry, index) => {
    const row = document.createElement('div');
    row.className = 'prow ' + (entry.kind === 'dir' ? 'dir' : 'file');
    row.dataset.index = String(index);
    row.dataset.path = entry.path;
    row.dataset.kind = entry.kind;

    const isCurrent = selectPath && entry.path === selectPath;
    if (isCurrent) row.classList.add('picked');

    row.innerHTML =
      '<span class="ico">' + esc(pickIcon(entry)) + '</span>' +
      '<span class="nm">' + esc(entry.name) + (entry.kind === 'dir' ? '\\' : '') + '</span>' +
      '<span class="sz">' + (entry.kind === 'file' ? esc(fmtBytes(entry.size)) : '') + '</span>';

    /* 单击：目录只高亮（防误触进目录），文件直接选中 */
    row.addEventListener('click', () => {
      if (entry.kind === 'dir') {
        pickSelect(index);
      } else {
        pickCommit(entry.path);
      }
    });
    row.addEventListener('dblclick', () => {
      if (entry.kind === 'dir') pickNavigate(entry.path);
      else pickCommit(entry.path);
    });

    list.appendChild(row);
  });

  if (picker.truncated) {
    const more = document.createElement('div');
    more.className = 'pkg-more';
    more.textContent = '目录条目超过 500 个，只列了前 500 条 —— 直接在上面粘贴完整路径更准。';
    list.appendChild(more);
  }

  renderPickerQuick();

  /* 打开时就选中一行，免得「用这个」得先自己点一下：
     - 有"当前值"→ 选它并滚进视野（一长串目录里不用自己找）
     - 选文件夹且停在盘符层 → 选第一个盘符，这样直接点「用这个文件夹」也有东西可选 */
  const hit = list.querySelector('.prow.picked');
  if (hit) {
    picker.sel = Number(hit.dataset.index);
    pickSelect(picker.sel);
    try { hit.scrollIntoView({ block: 'center' }); } catch (err) { /* 忽略 */ }
  } else if (picker.mode === 'dir' && !picker.dir && shown.length) {
    pickSelect(0);
  }
}

function pickSelect(index) {
  if (!picker) return;
  const rows = $$('.prow', el('picker-list'));
  rows.forEach((r) => r.classList.remove('sel'));
  const row = rows[index];
  if (!row) { picker.sel = -1; return; }
  row.classList.add('sel');
  picker.sel = index;
}

/**
 * 把拿到的路径写回输入框 —— 页面内选择器和系统对话框共用这一段。
 *
 * 写值之后要补一次 input 事件：某些字段（cfg-file-*）靠它做自动填名/预览，
 * 光赋值不派发事件，界面会看着像"选了没生效"。
 */
function applyPickedPath(targetId, path) {
  const node = el(targetId);
  if (!node) return;
  node.value = path;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  flashTarget(node);
  if (String(targetId).startsWith('cfg-file-')) {
    autoFillModelIdentity(path);
    schedulePreview();
  } else if (targetId === 'imp-model-file') {
    autoFillImportModelIdentity(path);
  } else if (targetId === 'eng-file' || targetId === 'imp-eng-file') {
    /* 选了启动文件：顺手把引擎名 / id 的空位填上（端口仍要用户确认） */
    autoFillEngineIdentity(path, targetId);
  }
}

/** 记住这次选的，下次打开有快捷入口（只留最近 3 个） */
function rememberPicked(path) {
  try {
    const list = (picker && picker.picked ? picker.picked : loadPickedHistory()).filter((p) => p !== path);
    list.unshift(path);
    localStorage.setItem('laci.ui.picked', JSON.stringify(list.slice(0, 3)));
  } catch (err) { /* 忽略 */ }
}

/** 页面内选择器"选中"：写回目标输入框，关掉选择器 */
function pickCommit(path) {
  if (!picker || !path) return;
  const { targetId, mode } = picker;
  if (mode === 'file' && /\.[^.\\/]+$/.test(path) === false) {
    /* 选文件时给了个目录：当成"进这个目录"，不要写回输入框 */
    pickNavigate(path);
    return;
  }
  rememberPicked(path);
  closePicker();
  applyPickedPath(targetId, path);

  /* 焦点已经由 closePicker 还给目标输入框了 —— 不额外抢，
     否则用户在「导入引擎」里填完路径还得重新点一下「引擎名称」 */
}

/** 选择器打开时的键盘处理。返回 true = 事件已吃掉 */
function pickerKeydown(ev) {
  if (!picker) return false;
  const key = ev.key;

  if (key === 'Escape') {
    closePicker();
    return true;
  }
  /* 在输入框里打字时只接管 Escape / 回车，别抢方向键 */
  const inInput = ev.target && ev.target.tagName === 'INPUT';
  if (inInput && key === 'Enter') {
    const raw = String(ev.target.value || '').trim();
    if (ev.target.id === 'picker-path') {
      if (raw) pickNavigate(cleanPathText(raw));
      return true;
    }
    if (ev.target.id === 'picker-name') {
      if (picker.mode === 'file' && raw) pickCommit(joinPath(picker.dir, cleanPathText(raw)));
      return true;
    }
    return false;
  }
  if (inInput) return false;

  const rows = $$('.prow', el('picker-list'));
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!rows.length) return false;
    const step = key === 'ArrowDown' ? 1 : -1;
    let next = picker.sel < 0 ? (step > 0 ? 0 : rows.length - 1) : picker.sel + step;
    next = Math.max(0, Math.min(rows.length - 1, next));
    pickSelect(next);
    try { rows[next].scrollIntoView({ block: 'nearest' }); } catch (err) { /* 忽略 */ }
    return true;
  }
  if (key === 'Enter') {
    const row = rows[picker.sel];
    if (!row) return false;
    if (row.dataset.kind === 'dir') pickNavigate(row.dataset.path);
    else pickCommit(row.dataset.path);
    return true;
  }
  if (key === 'Backspace' || (key === 'ArrowLeft' && ev.altKey)) {
    if (picker.parent !== null) pickNavigate(picker.parent);
    return true;
  }
  return false;
}

/** 拼路径（dir + 用户手输的文件名）。空 dir 时原样返回。 */
function joinPath(dir, name) {
  if (!name) return dir || '';
  /* 用户输的是完整路径就直接用，别拼了 */
  if (/^[a-zA-Z]:[\\/]/.test(name) || name.startsWith('\\\\')) return name;
  if (!dir) return name;
  return dir.replace(/[\\/]+$/, '') + '\\' + name.replace(/^[\\/]+/, '');
}

function wirePicker() {
  el('picker-close').addEventListener('click', closePicker);
  el('picker-cancel').addEventListener('click', closePicker);
  /* 罩子上的兜底出口：原生框没弹到前面时，一键换页面内选择 */
  const fallback = el('pick-veil-fallback');
  if (fallback) fallback.addEventListener('click', useInlinePicker);
  el('picker-ok').addEventListener('click', () => {
    if (!picker) return;
    const nameRaw = cleanPathText(el('picker-name').value || '');
    if (picker.mode === 'file' && nameRaw) {
      pickCommit(joinPath(picker.dir, nameRaw));
      return;
    }
    /* 有高亮的行就先看它：选文件夹时高亮目录 = 选它，选文件时高亮目录 = 进去 */
    const rows = $$('.prow', el('picker-list'));
    const row = rows[picker.sel];
    if (row && row.dataset.kind === 'dir') {
      if (picker.mode === 'dir') { pickCommit(row.dataset.path); return; }
      pickNavigate(row.dataset.path);
      return;
    }
    /* 选文件夹：当前所在的这一层就是答案 */
    if (picker.mode === 'dir') {
      if (picker.dir) { pickCommit(picker.dir); return; }
      toast('先双击进一个盘符，或者在上面粘贴路径', 'info');
      return;
    }
    if (row) { pickCommit(row.dataset.path); return; }
    toast('还没选文件：点一行，或者在上面填文件名', 'info');
  });

  el('picker-up').addEventListener('click', () => {
    if (picker && picker.parent !== null) pickNavigate(picker.parent);
  });
  el('picker-go').addEventListener('click', () => {
    const raw = cleanPathText(el('picker-path').value || '');
    if (raw) pickNavigate(raw);
  });
  el('picker-drives').addEventListener('click', () => pickNavigate(''));

  /* 文件名框就是过滤器：边打边筛当前目录 */
  let filterTimer = null;
  el('picker-name').addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { if (picker) drawPicker(null); }, 120);
  });

  /* 选择器自己的键盘处理挂在面板上：只在这个面板有焦点时生效 */
  el('picker').addEventListener('keydown', (ev) => {
    if (pickerKeydown(ev)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  });
}

function showPickVeil(text) {
  const veil = el('pick-veil');
  if (!veil) return;
  const t = el('pick-veil-text');
  if (t && text) t.textContent = text;
  veil.hidden = false;
}

function hidePickVeil() {
  const veil = el('pick-veil');
  if (veil) veil.hidden = true;
  const btn = el('pick-veil-fallback');
  if (btn) btn.hidden = true;
}

/** 用户没看到原生对话框（被浏览器盖住了 / PowerShell 慢）：作废这次等待，直接开页面内选择器 */
function useInlinePicker() {
  if (!nativePickCtx) return;
  const { targetId, mode } = nativePickCtx;
  nativePickCtx = null;
  nativePickToken++;   // 让还在等的那次原生结果作废，别等会儿又写回来
  hidePickVeil();
  openPicker(targetId, mode);
}

/**
 * 弹 Windows 系统对话框。
 * 返回 true = 这条路径已经处理完（选了 / 取消了 / 已经有一个框开着）；
 * 返回 false = 原生这条路走不通，调用方退回页面内选择器。
 */
async function pickViaNative(targetId, mode) {
  const node = el(targetId);
  if (!node) return true;

  const token = ++nativePickToken;
  nativePickCtx = { targetId, mode };
  showPickVeil(mode === 'dir' ? '正在打开「选择文件夹」…' : '正在打开「选择文件」…');
  const btn = el('pick-veil-fallback');
  if (btn) btn.hidden = false;

  try {
    const r = await api('/dialog', {
      method: 'POST',
      body: {
        mode,
        defaultPath: pickStartPath(node, mode),
        title: mode === 'dir' ? '选择文件夹' : '选择文件',
      },
    });
    if (token !== nativePickToken) return true;   // 用户已经改用页面内选择了
    if (r && r.path) {
      rememberPicked(r.path);
      applyPickedPath(targetId, r.path);
    } else if (r && r.message) {
      /* 已经有一个对话框开着，服务端把它抬到前台了 —— 这不是错误 */
      toast(r.message, 'info');
    }
    return true;                                  // 取消：什么都不改
  } catch (err) {
    if (token !== nativePickToken) return true;
    if (err && err.status === 404) return false;  // 服务端还没这个接口：静默退回
    toast('系统对话框起不来：' + (err && err.message ? err.message : err) + '，改用页面内选择', 'err');
    return false;
  } finally {
    if (token === nativePickToken) {
      nativePickCtx = null;
      hidePickVeil();
    }
  }
}

async function pickPath(targetId, mode) {
  const m = mode === 'dir' ? 'dir' : 'file';
  /* 直接用页面内的选择器：原生对话框在无边框窗口里会弹到窗口外/底边，用起来更别扭 */
  await openPicker(targetId, m);
}

/** 在资源管理器里打开/选中这个路径 */
async function revealPath(path) {
  if (!path) return;
  try {
    await api('/reveal', { method: 'POST', body: { path } });
  } catch (err) {
    toast('打不开资源管理器：' + err.message, 'err');
  }
}

/** 删除模型：UI 以前完全没有这个入口，所以"删数据"看起来是假的 */
async function deleteModelAction(modelId) {
  const model = S.models.find((m) => m.id === modelId);
  if (!model) return;
  const inst = S.byModel.get(modelId);
  if (inst && (inst.status === 'ready' || inst.status === 'starting')) {
    toast('这个模型正在跑，先在列表里关掉实例再删', 'err');
    return;
  }
  if (S.confirmDelete !== 'model:' + modelId) {
    toast('再点一次「确定删除」会真的删掉模型档案 ' + modelId, 'err');
    S.confirmDelete = 'model:' + modelId;
    renderCfg();
    setTimeout(() => {
      if (S.confirmDelete === 'model:' + modelId) { S.confirmDelete = ''; if (cfgCtx) renderCfg(); }
    }, 6000);
    return;
  }
  S.confirmDelete = '';
  try {
    await api('/models/' + encodeURIComponent(modelId), { method: 'DELETE' });
    closeModal('m-cfg');
    toast('已删除模型 ' + (model.label || modelId), 'ok');
    await refresh();
  } catch (err) {
    handleError(err, '删除模型失败');
    if (cfgCtx) renderCfg();
  }
}

function reselectEngine(engineId) {
  const engine = S.engineById.get(engineId) || S.engines.find((e) => e.id === engineId);
  if (!engine) return;
  openImport({ engine, dir: engine.file ? dirname(engine.file) : '' });
}

/**
 * 云端引擎的 key：存 / 清。
 * 后端永远不回显 key，所以这里只关心 hasKey；存完刷新一次界面即可。
 */
async function saveCloudKey(engineId, clear) {
  if (!engineId) return;
  if (clear) {
    if (S.confirmDelete !== 'key:' + engineId) {
      toast('再点一次「清除」会把 ' + engineId + ' 的 key 从 secrets.json 删掉', 'err');
      S.confirmDelete = 'key:' + engineId;
      renderEngines();
      setTimeout(() => {
        if (S.confirmDelete === 'key:' + engineId) { S.confirmDelete = ''; renderEngines(); }
      }, 6000);
      return;
    }
    S.confirmDelete = '';
  }

  const input = el('cloud-key-' + engineId);
  const key = clear ? '' : String((input && input.value) || '').trim();
  if (!clear && !key) { toast('先把 key 填进去', 'info'); return; }

  try {
    const r = await api('/secrets/' + encodeURIComponent(engineId), { method: 'POST', body: { key } });
    toast(r.hasKey ? 'key 已保存（不回显，只看得到"已配置"）' : 'key 已清除', 'ok');
    await refresh();
  } catch (err) {
    toast('存不了 key：' + (err && err.message ? err.message : err), 'err');
  }
}

/* 「等它结束」：in-flight 归零后自动关（实例状态没有就打网关 /health） */
async function checkPendingClose() {
  for (const modelId of Array.from(S.pendingClose)) {
    const inst = S.byModel.get(modelId);
    if (!inst) { S.pendingClose.delete(modelId); continue; }
    if ((inst.inflight || 0) > 0) continue;
    if (S.closing.has(inst.id)) continue;
    const gw = await gatewayInflight();
    if (gw && gw.inflight > 0 && (!gw.active || gw.active === modelId)) continue;
    S.pendingClose.delete(modelId);
    await doClose(inst, modelId, false);
  }
}

/* ---------- 7. 模型配置弹窗 ---------- */

function cfgSlots() {
  if (!cfgCtx) return [];
  const slots = (cfgCtx.engine && cfgCtx.engine.fileSlots) || [];
  if (slots.length) return slots;
  /* 引擎档案缺失时，按模型已有的 files 键还原槽位，别在保存时把文件路径弄丢 */
  const keys = Object.keys((cfgCtx.model && cfgCtx.model.files) || {});
  if (keys.length) return keys.map((k) => ({ key: k, label: k, kind: 'file' }));
  /* 云端模型没有本地文件 */
  if (cfgCtx.engine && cfgCtx.engine.mode === 'remote') return [];
  return [{ key: 'model', label: '模型文件', kind: 'file' }];
}

function cfgModelState(id) {
  if (!id) return 'idle';
  const inst = S.byModel.get(id);
  return inst ? inst.status : 'idle';
}

async function openConfig(modelId) {
  const model = S.models.find((m) => m.id === modelId);
  if (!model) return;
  const engine = S.engineById.get(model.engineId) || {
    id: model.engineId, label: model.engineId, fileSlots: [], argv: [], mode: 'custom', file: '', webUI: null,
  };
  cfgCtx = { isNew: false, model, engine, configInfo: null, configFile: '', configMtime: null, history: [] };
  renderCfg();
  openModal('m-cfg');

  /* package 引擎的参数在配置文件里，不在模型档案里：打开时读一次，显示真实值 */
  if (engine.mode === 'package' && engine.id) {
    try {
      const found = await api('/engines/' + encodeURIComponent(engine.id) + '/config');
      if (cfgCtx && cfgCtx.model === model && found && found.found) {
        cfgCtx.configInfo = found.config;
        cfgCtx.configFile = found.file || '';
        cfgCtx.configMtime = found.mtimeMs != null ? found.mtimeMs : null;
        try {
          const hist = await api('/models/' + encodeURIComponent(model.id) + '/history?engineId=' + encodeURIComponent(engine.id));
          if (cfgCtx && cfgCtx.model === model && hist && Array.isArray(hist.items)) cfgCtx.history = hist.items;
        } catch (err) { /* 历史读不到不影响主流程 */ }
        renderCfg();
      }
    } catch (err) { /* 没有配置文件就按原样显示 */ }
  }
}

/**
 * 选完模型文件后，自动把「名称 / 模型 id」填好。
 *
 * 规则：
 *   - 空字段 → 填
 *   - 上一次是自动填的、用户没改过 → 换文件时跟着更新
 *   - 用户自己改过 → 永不覆盖
 */
const AUTO_FILLED = { label: '', id: '' };

function autoFillModelIdentity(file) {
  if (!cfgCtx || !cfgCtx.isNew) return;
  const filePath = cleanPathText(file);
  const base = basenameNoExt(filePath);
  if (!base) return;

  const labelNode = el('cfg-label');
  if (labelNode) {
    const cur = String(labelNode.value || '').trim();
    if (!cur || cur === AUTO_FILLED.label) {
      labelNode.value = base;
      AUTO_FILLED.label = base;
    }
  }

  const idNode = el('cfg-id');
  if (idNode) {
    const cur = String(idNode.value || '').trim();
    if (!cur || cur === AUTO_FILLED.id) {
      const guess = slug(base);
      if (guess) {
        idNode.value = guess;
        AUTO_FILLED.id = guess;
      }
    }
  }
  schedulePreview();
}

/** 选了引擎启动文件后，顺手把引擎名 / id 的空位填上（不覆盖用户已填的） */
function autoFillEngineIdentity(file, targetId) {
  const base = basenameNoExt(cleanPathText(file));
  if (!base) return;
  const labelId = targetId === 'imp-eng-file' ? 'imp-eng-label' : 'eng-label';
  const engineIdId = targetId === 'imp-eng-file' ? 'imp-eng-id' : 'eng-id';
  const labelNode = el(labelId);
  if (labelNode && !String(labelNode.value || '').trim()) labelNode.value = base;
  const idNode = el(engineIdId);
  if (idNode && !String(idNode.value || '').trim()) {
    const guess = slug(base);
    if (guess) idNode.value = guess;
  }
}

/** 导入整合包的手动填写区，同样按文件名补名称 / id */
function autoFillImportModelIdentity(file) {
  const base = basenameNoExt(cleanPathText(file));
  if (!base) return;
  const labelNode = el('imp-model-label');
  if (labelNode && !String(labelNode.value || '').trim()) labelNode.value = base;
  const idNode = el('imp-model-id');
  if (idNode && !String(idNode.value || '').trim()) {
    const guess = slug(base);
    if (guess) idNode.value = guess;
  }
}

async function openConfigCreate(engineId) {
  AUTO_FILLED.label = '';
  AUTO_FILLED.id = '';  const engine = S.engineById.get(engineId) || S.engines.find((e) => e.id === engineId);
  if (!engine) { toast('引擎不存在', 'err'); return; }
  const model = {
    id: '', label: '', engineId: engine.id, kind: 'chat',
    files: {}, params: {}, caps: {},
    thinking: { effort: 'none', budget: 512, allowRequestOverride: false },
    port: null, extraArgs: '', raw: null,
  };
  cfgCtx = { isNew: true, model, engine };
  renderCfg();
  openModal('m-cfg');
  /* 第一次加入：先读引擎自己的配置/启动脚本，把真实值预填进来。
     发布给别人的整合包靠这一步自描述，而不是靠本机调好的档案。 */
  try {
    const r = await api('/engines/' + encodeURIComponent(engine.id) + '/config');
    const c = (r && r.config) || null;
    if (c && cfgCtx && cfgCtx.model === model) {
      /* 让弹窗知道这是"配置文件引擎"，下面才可编辑（否则会被当成原样运行锁死） */
      cfgCtx.configInfo = c;
      cfgCtx.configFile = r.file || null;
      const keys = ['maxContext', 'kvWindow', 'kvDtype', 'kvResident', 'hostKvMib', 'kvHeadroomMib', 'prefillChunk', 'mtp', 'draftTokens', 'vision'];
      for (const key of keys) {
        if (c[key] != null) model.params[key] = c[key];
      }
      renderCfg();
    }
  } catch (err) {
    /* 没有配置文件：用转换时存下来的脚本默认值（presetParams） */
    if (cfgCtx && cfgCtx.model === model && engine.presetParams) {
      for (const key of ['maxContext','kvWindow','kvDtype','kvResident','hostKvMib','kvHeadroomMib','prefillChunk','mtp','draftTokens','vision']) {
        if (engine.presetParams[key] != null) model.params[key] = engine.presetParams[key];
      }
      renderCfg();
    }
  }
}

/** 一键从引擎（配置文件/启动脚本/presetParams）读取参数填进表单 */
async function readCfgFromEngine() {
  if (!cfgCtx) return;
  const engine = cfgCtx.engine;
  const model = cfgCtx.model;
  let filled = {};
  try {
    const r = await api('/engines/' + encodeURIComponent(engine.id) + '/config');
    if (r && r.config) filled = r.config;
  } catch (err) { /* 没有配置就试 presetParams */ }
  if (!Object.keys(filled).length && engine.presetParams) filled = engine.presetParams;
  const keys = ['maxContext','kvWindow','kvDtype','kvResident','hostKvMib','kvHeadroomMib','prefillChunk','mtp','draftTokens','vision'];
  let n = 0;
  for (const key of keys) if (filled[key] != null) { model.params[key] = filled[key]; n += 1; }
  if (filled.reasoningEffort) { model.thinking = model.thinking || {}; model.thinking.effort = String(filled.reasoningEffort); n += 1; }
  if (!n) { toast('这个引擎没有可读的配置', 'info'); return; }
  renderCfg();
  toast('已读取 ' + n + ' 项', 'ok');
}

function kvDtypeOptions(current) {
  const list = KV_DTYPES.slice();
  if (current && list.indexOf(current) < 0) list.push(current);
  return list;
}

function numInput(id, label, value, opts) {
  opts = opts || {};
  const val = value == null ? '' : String(value);
  return '<div class="fi"><label>' + esc(label) + '</label>' +
    '<input id="' + id + '" type="number"' +
    (opts.min != null ? ' min="' + opts.min + '"' : '') +
    (opts.max != null ? ' max="' + opts.max + '"' : '') +
    ' step="1" value="' + escAttr(val) + '"' +
    (opts.placeholder ? ' placeholder="' + escAttr(opts.placeholder) + '"' : '') +
    '></div>';
}

function selectField(id, label, options, value) {
  const html = options.map((o) => {
    const v = typeof o === 'string' ? o : o.value;
    const t = typeof o === 'string' ? o : o.label;
    return '<option value="' + escAttr(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(t) + '</option>';
  }).join('');
  return '<div class="fi"><label>' + esc(label) + '</label><select id="' + id + '">' + html + '</select></div>';
}

function mtpHint(caps, p) {
  if (caps && caps.mtp === false) return '这个模型没有 MTP 组件，不能开';
  if (p && p.mtp) return '已开：池会变小（草稿越多池越小）';
  return caps && caps.mtp === true ? '模型带 MTP 组件' : '能力未知，按需开';
}

function visHint(caps) {
  if (caps && caps.vision === false) return '这个模型没有视觉组件，不能开';
  return caps && caps.vision === true ? '模型带视觉组件' : '能力未知，按需开';
}

function engineTemplateVars(engine) {
  const set = new Set();
  const scan = (v) => { for (const m of String(v || '').matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) set.add(m[1]); };
  ((engine && engine.argv) || []).forEach(scan);
  if (engine && engine.env) for (const v of Object.values(engine.env)) scan(v);
  if (engine && engine.capabilityArgs) for (const arr of Object.values(engine.capabilityArgs)) (arr || []).forEach(scan);
  return set;
}

/**
 * 思考等级能不能改，引擎说了算：能写返回能力描述，不能写返回 null。
 * 三种来源：配置文件里探测到的键（package + 配置文件）、引擎档案里手写的声明、
 * argv 模板里的 {thinkingEffort}。三种都不成立 → 界面显示"不适用"。
 */
function cfgReasoningCap() {
  if (!cfgCtx) return null;
  const engine = cfgCtx.engine || {};
  if (engine.mode === 'remote') return { mode: 'profile', levels: EFFORTS.slice() };
  if (engine.mode === 'package') {
    const ci = cfgCtx.configInfo;
    if (!ci || ci.source === 'script') return null;
    const cap = ci.reasoning;
    if (!cap || cap.mode !== 'config') return null;
    return {
      mode: 'config',
      key: cap.key || 'reasoning_effort',
      budgetKey: cap.budgetKey || 'reasoning_budget_tokens',
      levels: Array.isArray(cap.levels) && cap.levels.length ? cap.levels.slice() : EFFORTS.slice(),
    };
  }
  const declared = engine.reasoning;
  if (declared && declared.mode === 'argv' && Array.isArray(declared.levels) && declared.levels.length) {
    return { mode: 'argv', levels: declared.levels.slice() };
  }
  if (engineTemplateVars(engine).has('thinkingEffort')) return { mode: 'argv', levels: EFFORTS.slice() };
  return null;
}

function cfgReasoningWhy() {
  const engine = (cfgCtx && cfgCtx.engine) || {};
  if (engine.mode === 'remote') return '云端引擎没有本地启动参数';
  if (engine.mode === 'package') {
    const ci = cfgCtx.configInfo;
    if (!ci) return '没读到启动配置：不知道它支不支持思考等级';
    if (ci.source === 'script') return '原样运行启动脚本：思考参数写在脚本里，切到「按参数运行」才能改';
    return '这份配置里没有探测到思考等级（引擎不支持，或 serve 版本太旧）';
  }
  return '这个引擎的 argv/env 模板里没有 {thinkingEffort}：要改先去引擎档案补参数模板';
}

function thinkingNote(cap) {
  if (!cap) return '这个引擎不能调思考等级：' + cfgReasoningWhy();
  const base = cap.mode === 'config'
    ? '等级写回配置文件的 ' + cap.key + '（引擎启动时的默认档，重启后生效）；预算写 ' + cap.budgetKey + '。'
    : '思考参数存模型档案；命令预览是否出现取决于引擎 argv 模板。';
  return base + '「允许请求覆盖」由网关执行（D4）：关掉时请求里的 reasoning_effort 会被剥掉。';
}

function renderCfg() {
  if (!cfgCtx) return;
  const engine = cfgCtx.engine;
  const model = cfgCtx.model;
  const isNew = cfgCtx.isNew;
  const slots = cfgSlots();
  /* 启动方式是引擎级字段（M1 的 Engine.mode），模型页只是入口，见 §5.4.2 */
  const mode = engine.mode || 'custom';
  const src = { ...(model.params || {}) };
  const p = Object.assign({}, DEFAULT_PARAMS, src);
  const packageMode = mode === 'package';
  const configInfo = cfgCtx.configInfo || null;
  const fromConfig = packageMode && !!configInfo;
  const configEditable = packageMode && !!configInfo && configInfo.source !== 'script';
  const fromWhat = configInfo && configInfo.source === 'script' ? '来自启动脚本' : '来自配置文件';
  /* package 引擎真正吃的是配置文件：把它的值盖到显示上，别拿模型档案里的默认值冒充 */
  if (packageMode && configInfo) {
    if (configInfo.maxContext != null) p.maxContext = configInfo.maxContext;
    if (configInfo.kvWindow != null) p.kvWindow = configInfo.kvWindow;
    if (configInfo.kvDtype) p.kvDtype = configInfo.kvDtype;
    if (configInfo.hostKvMib != null) p.hostKvMib = configInfo.hostKvMib;
    if (configInfo.kvHeadroomMib != null) p.kvHeadroomMib = configInfo.kvHeadroomMib;
    if (configInfo.prefillChunk != null) p.prefillChunk = configInfo.prefillChunk;
    if (configInfo.mtp != null) p.mtp = configInfo.mtp;
    if (configInfo.vision != null) p.vision = configInfo.vision;
    if (configInfo.visionResidency) p.visionResidency = configInfo.visionResidency;
    if (configInfo.visionMaxMerged != null) p.visionMaxMerged = configInfo.visionMaxMerged;
    if (configInfo.spec) p.spec = configInfo.spec;
    if (configInfo.draftTokens != null) p.draftTokens = configInfo.draftTokens;
    if (configInfo.kvResident != null) p.kvResident = configInfo.kvResident;
  }
  /* 投机解码后端：文档里是 params.spec，兼容旧写法 specBackend / backend */
  p.spec = src.spec || src.specBackend || src.backend || 'mtp';
  const think = Object.assign({ effort: 'none', budget: 512, allowRequestOverride: false }, model.thinking || {});
  /* package 引擎的思考预算也从配置文件来（reasoning_budget_tokens） */
  if (packageMode && configInfo && configInfo.reasoningBudget != null) think.budget = configInfo.reasoningBudget;
  const caps = model.caps || {};
  const st = cfgModelState(model.id);

  el('cfg-head').innerHTML =
    '<span class="cfgtitle">' + esc(isNew ? '新建模型' : (model.label || model.id)) + '</span>' +
    '<span class="espacer"></span>' +
    '<button type="button" class="btn ghost" data-close="m-cfg">✕</button>';

  const out = [];

  /* 模型 id / 名称 */
  if (isNew) {
    out.push('<div class="frow">' +
      '<div class="fi"><label>名称</label><input id="cfg-label" value="' + escAttr(model.label || '') + '" placeholder="Qwen3.8 27B · 常规"></div>' +
      '<div class="fi"><label>模型 id（英文 / 数字 / . _ -）</label><input id="cfg-id" value="' + escAttr(model.id || '') + '" placeholder="qwen3.8-27b"></div>' +
    '</div>');
  } else {
    out.push('<div class="k">模型 id</div>');
    out.push('<div class="idline">' + esc(model.id) + '</div>');
  }

  /* 模型文件：按引擎的 fileSlots 自动生成输入框 */
  out.push('<div class="sec">模型文件</div>');
  if (!slots.length) {
    out.push('<div class="note">云端模型（remote）没有本地文件槽位，不用填路径。</div>');
  }
  if (slots.length > 1) {
    out.push('<div class="note" style="margin:0 0 6px">这个引擎有 ' + slots.length + ' 个槽位（一个模型多个文件）。</div>');
  }
  for (const s of slots) {
    const v = (model.files && model.files[s.key]) || '';
    const tag = (s.kind === 'dir' ? '（文件夹）' : '') + (s.optional ? ' · 可选' : '');
    if (slots.length > 1) out.push('<div class="slotk">' + esc(s.label || s.key) + esc(tag) + '</div>');
    out.push('<div class="pathbox">' +
      '<input class="pathin" id="cfg-file-' + escAttr(s.key) + '" spellcheck="false" value="' + escAttr(v) + '" placeholder="粘贴完整路径">' +
      '<button type="button" class="pick" data-act="pick" data-target="cfg-file-' + escAttr(s.key) + '" data-mode="' + (s.kind === 'dir' ? 'dir' : 'file') + '" title="在资源管理器里选">📁 选择</button>' +
    '</div>');
  }
  if (slots.length) out.push('<div class="note">点「📁 选择」在页面内挑路径（双击进目录，双击文件即选中）；也可以直接粘贴。</div>');

  /* 历史记录：只对"配置文件可写"的 package 引擎显示 */
  if (configEditable && !isNew) {
    const items = cfgCtx.history || [];
    out.push('<div class="sec">历史记录（最近 10 次）</div>');
    out.push('<div class="frow">' +
      '<div class="fi" style="flex:2"><label>按 引擎 + 模型 保存</label>' +
        '<select id="cfg-history"><option value="">— 选择一条 —</option>' +
          items.map((it) => '<option value="' + escAttr(it.id) + '">' +
            esc(String(it.name || '') + ' · ' + String(it.at || '')) + '</option>').join('') +
        '</select></div>' +
      '<div class="fi" style="flex:0 0 auto;display:flex;align-items:flex-end;gap:6px">' +
        '<button type="button" class="btn" data-act="hist-apply">恢复</button>' +
        '<button type="button" class="btn ghost" data-act="hist-rename">改名</button>' +
      '</div>' +
    '</div>');
    out.push('<div class="note">恢复 = 把这条的参数填进表单；确认「立即应用并重启」才会写回配置文件并重启实例。</div>');
  }

  /* 启动方式：package / custom 单选（云端 remote 不需要） */
  const isRemote = engine.mode === 'remote';
  out.push('<div class="sec">启动方式</div>');
  out.push('<label class="chk"><input type="radio" name="cfg-mode" value="custom"' + (!isRemote && mode !== 'package' ? ' checked' : '') + (isRemote ? ' disabled' : '') + '> 按参数运行(可调)</label>');
  out.push('<label class="chk"><input type="radio" name="cfg-mode" value="package"' + (!isRemote && mode === 'package' ? ' checked' : '') + (isRemote ? ' disabled' : '') + '> 原样运行 bat(最稳,改不了)</label>');
  out.push('<div class="note" id="cfg-mode-note"></div>');

  /* 参数 / 投机 / 视觉 / 思考：原样运行时整块禁用 */
  out.push('<div id="cfg-tuning" class="tuning">');

  out.push('<div class="sec">参数</div>');
  out.push('<div class="frow"><div class="fi"><button type="button" class="btn" data-act="cfg-read">从引擎/配置读取</button></div></div>');
  const cfg = fromConfig ? (configInfo.config || {}) : null;
  const naInput = (label, id, title) => '<div class="fi"><label>' + esc(label) + '</label><input value="不适用" disabled data-na="1" title="' + escAttr(title || '引擎模板/配置里没有这个参数') + '"></div>';
  /* 自定义引擎：只有 argv/env/能力模板里真的用到的变量才可填；没用到的不适用。
     没读到的值不补默认，空着显示「未读取」。 */
  const templateVars = engineTemplateVars(engine);
  const customMode = !fromConfig && engine.mode !== 'remote';
  const capabilityKeys = new Set(Object.keys(engine.capabilityArgs || {}));
  /* 能力开关（vision/mtp）不是 {变量}，只体现在 capabilityArgs 的 key 上 */
  const usable = (key) => !customMode || templateVars.has(key) || capabilityKeys.has(key);
  const has = (key) => src[key] != null;
  const fieldNum = (key, id, label, opts) => usable(key)
    ? numInput(id, label, has(key) ? p[key] : '', Object.assign({ placeholder: has(key) ? '' : '未读取' }, opts || {}))
    : naInput(label, id);
  const kvWin = cfg
    ? (cfg.kvWindow == null ? naInput('KV 窗口（显存）', 'cfg-kvWindow') : numInput('cfg-kvWindow', 'KV 窗口（显存）', p.kvWindow, { min: 0 }))
    : fieldNum('kvWindow', 'cfg-kvWindow', 'KV 窗口（显存）', { min: 0 });
  const prefill = cfg
    ? (cfg.prefillChunk == null ? naInput('预填块（显存）', 'cfg-prefillChunk') : numInput('cfg-prefillChunk', '预填块（显存）', p.prefillChunk, { min: 0 }))
    : fieldNum('prefillChunk', 'cfg-prefillChunk', '预填块（显存）', { min: 0 });
  const hostKv = cfg
    ? (cfg.hostKvMib == null ? naInput('主机 KV（内存，不占显存）', 'cfg-hostKvMib') : numInput('cfg-hostKvMib', '主机 KV（内存，不占显存）', p.hostKvMib, { min: 0 }))
    : fieldNum('hostKvMib', 'cfg-hostKvMib', '主机 KV（内存，不占显存）', { min: 0 });
  const headroom = cfg
    ? (cfg.kvHeadroomMib == null ? naInput('headroom（显存）', 'cfg-kvHeadroomMib') : numInput('cfg-kvHeadroomMib', 'headroom（显存）', p.kvHeadroomMib, { min: 0 }))
    : fieldNum('kvHeadroomMib', 'cfg-kvHeadroomMib', 'headroom（显存）', { min: 0 });
  out.push('<div class="frow">' + fieldNum('maxContext', 'cfg-maxContext', '上下文（显存）', { min: 0 }) + kvWin + '</div>');
  out.push('<div class="frow">' + (has('kvDtype') || cfg ? selectField('cfg-kvDtype', '量化（显存）', kvDtypeOptions(p.kvDtype), p.kvDtype) : naInput('量化（显存）', 'cfg-kvDtype')) + prefill + '</div>');
  out.push('<div class="frow">' + hostKv + headroom + '</div>');
  if (configEditable) {
    out.push('<div class="frow">' + numInput('cfg-kvResident', 'KV resident（显存）', p.kvResident, { min: 0 }) + '<div class="fi"></div></div>');
  }
  out.push('<div class="note">上下文 / KV 窗口 / 量化 / 预填块 / headroom 调的是<b>显存</b>上的 KV；「主机 KV」是钉在<b>主机内存</b>里的那份，不占显存——kvmem 复用走的就是它。</div>');
  out.push('<div class="frow">' + numInput('cfg-port', '端口（不填用引擎基址）', model.port, { min: 1024, max: 65535, placeholder: '不填就往上找空闲端口' }) + '</div>');

  out.push('<div class="sec">投机解码</div>');
  const mtpOk = !customMode || usable('mtp') || usable('spec') || usable('draftTokens');
  out.push(mtpOk
    ? '<label class="chk"><input type="checkbox" id="cfg-mtp"' + (p.mtp ? ' checked' : '') + (caps.mtp === false ? ' disabled' : '') + '> 开 <span class="t" id="cfg-mtp-hint">' + esc(fromConfig ? fromWhat : mtpHint(caps, p)) + '</span></label>'
    : '<label class="chk"><input type="checkbox" disabled data-na="1"> <span class="t">投机解码：不适用</span></label>');
  out.push('<div class="frow">' + (configEditable || (customMode && !usable('spec')) ? naInput('后端', 'cfg-specBackend') : selectField('cfg-specBackend', '后端', SPEC_BACKENDS, p.spec)) + (configEditable || (customMode && !usable('draftTokens')) ? naInput('草稿数 (1–15)', 'cfg-draftTokens') : numInput('cfg-draftTokens', '草稿数 (1–15)', p.draftTokens, { min: 1, max: 15 })) + '</div>');
  out.push('<div class="note">草稿多验证也多，27B 上 3–4 最划算' + (caps.mtp === false ? '；这个模型没有 MTP 组件，开了也没用' : '') + '。</div>');

  out.push('<div class="sec">视觉</div>');
  const visionOk = !customMode || usable('vision');
  out.push(visionOk
    ? '<label class="chk"><input type="checkbox" id="cfg-vision"' + (p.vision ? ' checked' : '') + (caps.vision === false ? ' disabled' : '') + '> 开 <span class="t" id="cfg-vision-hint">' + esc(fromConfig ? fromWhat : visHint(caps)) + '</span></label>'
    : '<label class="chk"><input type="checkbox" disabled data-na="1"> <span class="t">视觉：不适用</span></label>');
  out.push('<div class="frow">' + (configEditable || (customMode && !usable('visionResidency')) ? naInput('驻留', 'cfg-visionResidency') : selectField('cfg-visionResidency', '驻留', RESIDENCY, p.visionResidency)) + (configEditable || (customMode && !usable('visionMaxMerged')) ? naInput('最大合并', 'cfg-visionMaxMerged') : numInput('cfg-visionMaxMerged', '最大合并 (64–16384)', p.visionMaxMerged, { min: 64, max: 16384 })) + '</div>');
  out.push('<div class="note">overlay 首字 0.9s · cpu 6.1s 且强制 ≤256。</div>');

  out.push('<div class="sec">思考</div>');
  /* 思考等级/预算能不能改由引擎决定：配置文件里有键、或 argv 模板里有 {thinkingEffort}。
     探测不到就显示"不适用"——不给一个点了没反应的控件。 */
  const reasoning = cfgReasoningCap();
  const reasoningWhy = reasoning ? '' : cfgReasoningWhy();
  const effortValue = (packageMode && configInfo && configInfo.reasoningEffort)
    ? configInfo.reasoningEffort
    : think.effort;
  out.push('<div class="frow">' +
    (reasoning
      ? selectField('cfg-effort', '等级', reasoning.levels, effortValue)
      : naInput('等级', 'cfg-effort', reasoningWhy)) +
    (reasoning
      ? numInput('cfg-budget', '预算', think.budget, { min: 0 })
      : naInput('预算', 'cfg-budget', reasoningWhy)) +
    '</div>');
  out.push('<label class="chk"><input type="checkbox" id="cfg-allowOverride"' + (think.allowRequestOverride ? ' checked' : '') + '> 允许请求覆盖思考等级</label>');
  out.push('<div class="note">' + esc(thinkingNote(reasoning)) + '</div>');

  out.push('<div class="sec">额外参数</div>');
  out.push('<div class="pathbox">' +
    '<input class="pathin" id="cfg-extraArgs" spellcheck="false" value="' + escAttr(model.extraArgs || '') + '" placeholder="--seed 42">' +
    '<span class="pick-static">原样追加</span>' +
  '</div>');

  out.push('</div>'); // cfg-tuning

  /* 最终命令预览（前端按模板拼，只作预览） */
  out.push('<div class="sec">最终命令</div>');
  out.push('<details class="plain cmd"><summary>最终命令(点开看)</summary><pre class="cmdpre" id="cfg-cmd"></pre></details>');
  out.push('<div class="note">前端预览：带 arg 的槽位由系统自动拼在模板之后，实际启动以 M2/M4 的拼装为准。</div>');

  if (st === 'starting') {
    out.push('<div class="warnrow">模型正在启动，先等它起完再改参数。</div>');
  } else if (st === 'ready') {
    out.push('<div class="warnrow" id="cfg-warn">⚠ 这个模型正在跑，改了要重启才生效</div>');
  }
  out.push('<div class="formerr" id="cfg-errors" hidden></div>');

  el('cfg-body').innerHTML = out.join('');

  /* 底部按钮 */
  const disabled = st === 'starting';
  const foot = [];
  if (!isNew) {
    /* 删除模型：以前完全没有这个入口（只有引擎能删），所以"删数据"看起来是假的。
       正在跑的模型不给删（实例还指着它），先让用户关掉。 */
    if (st === 'ready' || st === 'starting') {
      foot.push('<button type="button" class="btn danger" data-act="delete-model" data-model="' + escAttr(model.id) + '" disabled title="正在跑，先关闭实例">删除</button>');
    } else if (S.confirmDelete === 'model:' + model.id) {
      foot.push('<button type="button" class="btn danger" data-act="delete-model" data-model="' + escAttr(model.id) + '">确定删除「' + esc(model.label || model.id) + '」</button>');
    } else {
      foot.push('<button type="button" class="btn danger" data-act="delete-model" data-model="' + escAttr(model.id) + '">删除</button>');
    }
  }
  foot.push('<button type="button" class="btn ghost" data-close="m-cfg">取消</button>');
  if (isNew) {
    foot.push('<button type="button" class="btn primary" data-act="cfg-save"' + (disabled ? ' disabled' : '') + '>保存</button>');
  } else {
    foot.push('<button type="button" class="btn" data-act="cfg-save"' + (disabled ? ' disabled' : '') + '>保存</button>');
    if (st === 'ready') {
      foot.push('<button type="button" class="btn primary" data-act="cfg-save-restart"' + (disabled ? ' disabled' : '') + '>保存并重启</button>');
    }
  }
  el('cfg-foot').innerHTML = foot.join('');

  syncCfgMode();
  renderCmdPreview();
}

function syncCfgMode() {
  if (!cfgCtx) return;
  const tuning = el('cfg-tuning');
  if (!tuning) return;
  const packageMode = !!$('input[name="cfg-mode"][value="package"]:checked');
  const configEditable = !!(cfgCtx.configInfo && cfgCtx.configInfo.source !== 'script');
  const lock = packageMode && !configEditable;
  tuning.classList.toggle('off', lock);
  for (const input of tuning.querySelectorAll('input, select, textarea')) {
    /* "不适用"的字段永远禁用，别被这里重新打开 */
    input.disabled = input.hasAttribute('data-na') ? true : lock;
  }
  /* 能力不支持的开关，切回来也不能重新打开 */
  const mtp = el('cfg-mtp');
  if (mtp) mtp.disabled = lock || !!(cfgCtx.model.caps && cfgCtx.model.caps.mtp === false);
  const vision = el('cfg-vision');
  if (vision) vision.disabled = lock || !!(cfgCtx.model.caps && cfgCtx.model.caps.vision === false);
  clampVisionMax();

  const note = el('cfg-mode-note');
  if (note) {
    if (cfgCtx.engine.mode === 'remote') note.textContent = '云端引擎（mode: remote）：不需要本地启动方式，下面的参数只影响导出。';
    else if (packageMode && cfgCtx.configInfo) {
      if (configEditable) {
        note.textContent = '下面这些值来自配置文件' +
          (cfgCtx.configFile ? '（' + basename(cfgCtx.configFile) + '）' : '') +
          '；可以改，保存会写回文件，重启后生效（会先备份 .bak）。';
      } else {
        note.textContent = '原样运行：下面这些值来自启动脚本' +
          (cfgCtx.configFile ? '（' + basename(cfgCtx.configFile) + '）' : '') +
          '，只读；要改请改那个脚本。';
      }
    } else if (packageMode) note.textContent = '原样运行：参数全按脚本里的来，下面这些不生效。';
    else if (!cfgCtx.engine.argv || !cfgCtx.engine.argv.length) note.textContent = '这个引擎还没有参数模板（argv），按参数运行需要先在引擎档案里配，否则可能起不来。';
    else note.textContent = '';
  }
}

function clampVisionMax() {
  const res = el('cfg-visionResidency');
  const mm = el('cfg-visionMaxMerged');
  if (!res || !mm) return;
  const cpu = res.value === 'cpu';
  /* 常规 64–16384；cpu 驻留时引擎强制 ≤256（§5.6.1） */
  mm.min = '64';
  mm.max = cpu ? '256' : '16384';
  if (cpu && Number(mm.value) > 256) mm.value = '256';
}

/* 读表单（不校验）；预览和保存共用一份取值逻辑 */
function readCfg() {
  if (!cfgCtx) return null;
  const engine = cfgCtx.engine;
  const model = cfgCtx.model;
  const isNew = cfgCtx.isNew;
  const base = !isNew && model.raw && typeof model.raw === 'object' ? Object.assign({}, model.raw) : {};
  const params = Object.assign({}, model.params || {});

  const num = (id) => {
    const node = document.getElementById(id);
    if (!node) return null;
    const raw = String(node.value == null ? '' : node.value).trim();
    if (raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const setNum = (key, v) => { if (v === null || v === undefined) delete params[key]; else params[key] = v; };

  setNum('maxContext', num('cfg-maxContext'));
  setNum('kvWindow', num('cfg-kvWindow'));
  setNum('prefillChunk', num('cfg-prefillChunk'));
  setNum('hostKvMib', num('cfg-hostKvMib'));
  setNum('kvHeadroomMib', num('cfg-kvHeadroomMib'));

  const kvSel = document.getElementById('cfg-kvDtype');
  if (kvSel) params.kvDtype = kvSel.value;

  const mtp = document.getElementById('cfg-mtp');
  params.mtp = !!(mtp && mtp.checked);
  const spec = document.getElementById('cfg-specBackend');
  if (spec) {
    params.spec = spec.value;
    /* 旧档案里可能用的是 specBackend，同步一份，别让两处说法打架 */
    if (params.specBackend != null) params.specBackend = spec.value;
  }
  const draft = num('cfg-draftTokens');
  params.draftTokens = draft === null ? 4 : draft;

  const vision = document.getElementById('cfg-vision');
  params.vision = !!(vision && vision.checked);
  const res = document.getElementById('cfg-visionResidency');
  if (res) params.visionResidency = res.value;
  const merged = num('cfg-visionMaxMerged');
  params.visionMaxMerged = merged === null ? 16384 : merged;

  const files = {};
  /* 先带上已有的路径，再按槽位覆盖 / 删除：清空的槽位要从 files 里去掉 */
  for (const key of Object.keys(model.files || {})) {
    if (model.files[key]) files[key] = model.files[key];
  }
  for (const s of cfgSlots()) {
    const node = document.getElementById('cfg-file-' + s.key);
    const v = node ? cleanPathText(node.value) : '';
    if (v) files[s.key] = v;
    else delete files[s.key];
  }

  const effort = document.getElementById('cfg-effort');
  const budget = num('cfg-budget');
  const allow = document.getElementById('cfg-allowOverride');
  const thinking = {
    /* "不适用"之类的占位值不能当等级存，落回模型档案里的值 */
    effort: effort && EFFORTS.includes(effort.value) ? effort.value : (model.thinking && model.thinking.effort) || 'none',
    budget: budget === null ? 512 : budget,
    allowRequestOverride: !!(allow && allow.checked),
  };

  const idNode = document.getElementById('cfg-id');
  const labelNode = document.getElementById('cfg-label');
  const extraNode = document.getElementById('cfg-extraArgs');

  const body = Object.assign({}, base, {
    id: isNew ? String((idNode && idNode.value) || '').trim() : model.id,
    label: isNew ? String((labelNode && labelNode.value) || '').trim() : (model.label || model.id),
    engineId: model.engineId || engine.id,
    kind: model.kind || 'chat',
    files,
    params,
    thinking,
    /* M1 里 extraArgs 是字符串数组，不是一整行 */
    extraArgs: splitArgs(extraNode ? extraNode.value : ''),
  });
  /* 启动方式在引擎上；模型档案里就算以前留过 mode 也不要再写回去 */
  delete body.mode;

  const port = num('cfg-port');
  if (port === null) delete body.port; else body.port = port;
  return body;
}

function validateCfg(body) {
  const errs = [];
  if (!body) return ['读不到表单'];
  if (!body.id) errs.push('模型 id 不能为空');
  else if (!isSafeId(body.id)) errs.push('模型 id 只能字母/数字开头，含字母数字 . _ -，最多 64 字符，不能以 . 结尾');
  if (!body.label) errs.push('模型名称不能为空');

  for (const s of cfgSlots()) {
    if (!s.optional && !body.files[s.key]) errs.push('「' + (s.label || s.key) + '」还没有路径');
  }

  const ints = [['上下文', 'maxContext'], ['KV 窗口', 'kvWindow'], ['预填块', 'prefillChunk'],
    ['主机 KV', 'hostKvMib'], ['headroom', 'kvHeadroomMib']];
  for (const pair of ints) {
    const v = body.params[pair[1]];
    if (v == null) continue;
    if (!Number.isFinite(Number(v))) errs.push(pair[0] + ' 要是数字');
    else if (Number(v) < 0) errs.push(pair[0] + ' 不能是负数');
  }
  if (body.params.maxContext != null && Number(body.params.maxContext) <= 0) errs.push('上下文要大于 0');

  if (body.params.mtp || body.params.draftTokens != null) {
    const n = Number(body.params.draftTokens);
    if (!Number.isFinite(n) || n < 1 || n > 15) errs.push('草稿数要在 1–15 之间');
  }
  if (body.params.visionMaxMerged != null || body.params.vision) {
    const n = Number(body.params.visionMaxMerged);
    if (!Number.isFinite(n) || n < 64 || n > 16384) errs.push('最大合并要在 64–16384 之间');
    if (body.params.visionResidency === 'cpu' && n > 256) errs.push('cpu 驻留时最大合并不能超过 256');
  }
  if (!Number.isFinite(Number(body.thinking.budget)) || Number(body.thinking.budget) < 0) errs.push('思考预算要是非负数字');
  if (body.port != null && !(body.port >= 1024 && body.port <= 65535)) errs.push('端口要在 1024–65535 之间');
  return errs;
}

function showCfgErrors(list) {
  const box = el('cfg-errors');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = list.map((e) => '<div>• ' + esc(e) + '</div>').join('');
  if (box.scrollIntoView) {
    try { box.scrollIntoView({ block: 'nearest' }); } catch (err) { /* 忽略 */ }
  }
}

function setCfgBusy(on) {
  const foot = el('cfg-foot');
  if (!foot) return;
  for (const btn of foot.querySelectorAll('button')) {
    if (btn.hasAttribute('data-close')) continue;
    btn.disabled = !!on;
  }
}

async function saveCfg(restart) {
  if (!cfgCtx) return;
  const ctx = cfgCtx;
  /* package + 配置文件：保存的是那份 JSON，不是模型档案 */
  if (ctx.configInfo && ctx.configInfo.source !== 'script' && ctx.engine && ctx.engine.mode === 'package') {
    return saveConfigCfg(ctx, restart);
  }
  const body = readCfg();
  const errs = validateCfg(body);
  if (errs.length) { showCfgErrors(errs); return; }

  /* 启动方式是引擎级字段：radio 变了就顺手更新引擎档案（§5.4.2） */
  const mode = ($('input[name="cfg-mode"]:checked') || {}).value || 'custom';
  const modeChanged = ctx.engine &&
    (ctx.engine.mode === 'package' || ctx.engine.mode === 'custom') &&
    ctx.engine.mode !== mode;

  setCfgBusy(true);
  try {
    await api('/models', { method: 'POST', body });
  } catch (err) {
    setCfgBusy(false);
    if (err instanceof ApiError && err.status === 400 && err.body && Array.isArray(err.body.errors)) {
      showCfgErrors(err.body.errors.map((e) => (typeof e === 'string' ? e : (e.message || e.field || JSON.stringify(e)))));
    } else if (err instanceof ApiError && err.status === 409) {
      showCfgErrors(['模型 id 撞车了：' + err.message]);
    } else {
      showCfgErrors([err.message]);
    }
    return;
  }

  if (modeChanged) {
    if (!ctx.engine.raw) {
      setCfgBusy(false);
      showCfgErrors(['模型已保存；但引擎档案读不到，没法把这台的启动方式改成 ' + mode + '，请重新导入引擎。']);
      return;
    }
    try {
      await api('/engines', { method: 'POST', body: engineBodyForSave(ctx.engine, mode) });
    } catch (err) {
      setCfgBusy(false);
      showCfgErrors(['模型已保存，但启动方式没改成 ' + mode + '：' + err.message]);
      return;
    }
  }

  const st = cfgModelState(ctx.model.id);
  closeModal('m-cfg');

  if (restart && !ctx.isNew && st === 'ready') {
    try {
      await restartModel(body.id);
      toast('已保存并重启 ' + (body.label || body.id), 'ok');
    } catch (err) {
      handleError(err, '保存成功，但重启失败');
    }
  } else if (!ctx.isNew && st === 'ready') {
    toast('已保存；这个模型正在跑，重启后才生效', 'info');
  } else {
    toast('已保存 ' + (body.label || body.id), 'ok');
  }
  refresh();
}

/* ---------- 配置文件模式：保存 = 写回那份 JSON（不是模型档案） ---------- */

function cfgNumValue(id) {
  const node = el(id);
  if (!node) return null;
  const raw = String(node.value == null ? '' : node.value).trim();
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function saveConfigCfg(ctx, restart) {
  const cap = cfgReasoningCap();
  const effortSel = el('cfg-effort');
  const values = {
    maxContext: cfgNumValue('cfg-maxContext'),
    kvDtype: (el('cfg-kvDtype') || {}).value || null,
    kvResident: cfgNumValue('cfg-kvResident'),
    draftTokens: cfgNumValue('cfg-draftTokens'),
    mtp: !!(el('cfg-mtp') || {}).checked,
    vision: !!(el('cfg-vision') || {}).checked,
    reasoningBudget: cfgNumValue('cfg-budget'),
  };
  /* 等级只在引擎认这个键时才带（探测不到的引擎界面上本来就是"不适用"） */
  if (cap && cap.mode === 'config' && effortSel) values.reasoningEffort = effortSel.value;

  /* allowRequestOverride 是网关字段（D4），只存在于模型档案：配置模式要单独写一次 */
  const allowOverride = !!(el('cfg-allowOverride') || {}).checked;
  const thinking = { allowRequestOverride: allowOverride };
  if (cap && cap.mode === 'config' && effortSel) thinking.effort = effortSel.value;
  const thinkingChanged = (typeof thinking.effort === 'string' && thinking.effort !== ctx.model.thinking.effort)
    || thinking.allowRequestOverride !== !!ctx.model.thinking.allowRequestOverride;

  setCfgBusy(true);
  try {
    const r = await api('/engines/' + encodeURIComponent(ctx.engine.id) + '/config', {
      method: 'PUT',
      body: { values, expectedMtimeMs: ctx.configMtime, modelId: ctx.model.id },
    });
    ctx.configMtime = r.mtimeMs != null ? r.mtimeMs : ctx.configMtime;
    if (r.config) ctx.configInfo = r.config;
    if (r.history && Array.isArray(r.history.items)) ctx.history = r.history.items;

    /* 配置写成功后再更新档案：配置失败时不要留下半套状态 */
    let thinkingSaved = false;
    if (thinkingChanged) {
      try {
        const saved = await api('/models/' + encodeURIComponent(ctx.model.id) + '/thinking', {
          method: 'POST',
          body: thinking,
        });
        if (saved && saved.model && saved.model.thinking) ctx.model.thinking = saved.model.thinking;
        else Object.assign(ctx.model.thinking, thinking);
        thinkingSaved = true;
      } catch (err) {
        handleError(err, '配置已写入，但思考设置没存进模型档案');
      }
    }

    const changed = Array.isArray(r.changed) ? r.changed : [];
    if (!changed.length && !thinkingSaved) {
      /* 只改了档案但没存成：错误已经弹过，别再补一句"没有变化" */
      if (!thinkingChanged) toast('参数没有变化，没有写文件', 'info');
      renderCfg();
      return;
    }
    if (changed.length && thinkingSaved) {
      toast('已写入 ' + basename(r.file || ctx.configFile || '') + '（' + changed.join('、') + '），并保存思考设置，重启后生效', 'ok');
    } else if (changed.length) {
      toast('已写入 ' + basename(r.file || ctx.configFile || '') + '（' + changed.join('、') + '），重启后生效', 'ok');
    } else {
      toast('已保存思考设置（模型档案）', 'ok');
    }
    renderCfg();

    if (restart && !ctx.isNew) {
      try {
        await restartModel(ctx.model.id);
        toast('已按配置重启 ' + (ctx.model.label || ctx.model.id), 'ok');
      } catch (err) {
        handleError(err, '配置已写入，但重启失败');
      }
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      showCfgErrors(['配置文件在磁盘上被改过了，已重新读取——请再检查一遍再保存']);
      try {
        const found = await api('/engines/' + encodeURIComponent(ctx.engine.id) + '/config');
        if (found && found.found && cfgCtx === ctx) {
          ctx.configInfo = found.config;
          ctx.configFile = found.file || '';
          ctx.configMtime = found.mtimeMs != null ? found.mtimeMs : null;
          renderCfg();
        }
      } catch (e2) { /* 重新读也失败就保持原样 */ }
    } else {
      showCfgErrors([err.message]);
    }
  } finally {
    setCfgBusy(false);
  }
}

/** 把一条历史记录的值填进表单（不保存） */
function fillCfgFromValues(values) {
  if (!values) return;
  const setNum = (id, v) => {
    const node = el(id);
    if (node && v != null) node.value = String(v);
  };
  setNum('cfg-maxContext', values.maxContext);
  setNum('cfg-kvResident', values.kvResident);
  setNum('cfg-draftTokens', values.draftTokens);
  setNum('cfg-budget', values.reasoningBudget);
  if (values.reasoningEffort) {
    const eff = el('cfg-effort');
    if (eff) eff.value = String(values.reasoningEffort);
  }
  if (values.kvDtype) {
    const kv = el('cfg-kvDtype');
    if (kv) {
      if (![...kv.options].some((o) => o.value === String(values.kvDtype))) {
        const opt = document.createElement('option');
        opt.value = String(values.kvDtype);
        opt.textContent = String(values.kvDtype);
        kv.appendChild(opt);
      }
      kv.value = String(values.kvDtype);
    }
  }
  const mtp = el('cfg-mtp');
  if (mtp && values.mtp != null) mtp.checked = !!values.mtp;
  const vision = el('cfg-vision');
  if (vision && values.vision != null) vision.checked = !!values.vision;
}

/** 把"脚本写死模型"的引擎转成「按参数运行」——之后点哪个模型起哪个 */
async function convertEngineToCustom(engineId) {
  if (!engineId) return;
  try {
    const r = await api('/engines/' + encodeURIComponent(engineId) + '/convert', { method: 'POST', body: {} });
    const warnings = Array.isArray(r && r.warnings) ? r.warnings : [];
    toast('已改成按参数运行：现在点哪个模型就起哪个' + (warnings.length ? '（' + warnings.join('；') + '）' : ''), 'ok');
    await refresh();
  } catch (err) {
    toast('转换失败：' + (err && err.message ? err.message : err), 'err');
  }
}

/** 历史记录：恢复（问一句立即应用并重启） */
function applyHistoryItem() {
  if (!cfgCtx) return;
  const sel = el('cfg-history');
  const item = (cfgCtx.history || []).find((x) => x.id === (sel && sel.value));
  if (!item) { toast('先在上面选一条历史记录', 'info'); return; }
  fillCfgFromValues(item.values);
  const yes = window.confirm('立即应用并重启？\n\n取消 = 只把参数填进表单，你自己再点保存。');
  if (yes) void saveConfigCfg(cfgCtx, true);
}

/** 历史记录：改名 */
async function renameHistoryItem() {
  if (!cfgCtx) return;
  const sel = el('cfg-history');
  const item = (cfgCtx.history || []).find((x) => x.id === (sel && sel.value));
  if (!item) { toast('先在上面选一条历史记录', 'info'); return; }
  const name = window.prompt('给这条记录改个名字（最多 40 字）', item.name || '');
  if (name == null) return;
  try {
    const r = await api('/models/' + encodeURIComponent(cfgCtx.model.id) + '/history/rename', {
      method: 'POST',
      body: { engineId: cfgCtx.engine.id, itemId: item.id, name },
    });
    if (r && Array.isArray(r.items)) cfgCtx.history = r.items;
    renderCfg();
    toast('已改名', 'ok');
  } catch (err) {
    toast('改名失败：' + (err && err.message ? err.message : err), 'err');
  }
}

/* 把界面上的引擎对象还原成 M1 能接受的定义（去掉界面自己加的字段） */
function engineBodyForSave(engine, mode) {
  const body = Object.assign({}, engine.raw || {});
  delete body.runningInstances;
  delete body.loadedModels;
  delete body.raw;
  delete body.missing;
  delete body.error;
  body.mode = mode;
  return body;
}

async function restartModel(modelId) {
  const inst = S.byModel.get(modelId) || S.instances.find((i) => i.modelIds.indexOf(modelId) >= 0);
  if (inst) {
    try {
      await api('/instances/' + encodeURIComponent(inst.id) + '?force=1', { method: 'DELETE' });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) console.warn('[LACI] 停止旧实例失败', err);
    }
    await waitGone(inst.id, 8000);
  }
  await api('/instances', { method: 'POST', body: { modelId, wait: false } });
}

/* 等实例真的从 /api/state 里消失，再重新加载（避免 409 正在切换） */
async function waitGone(instanceId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 8000)) {
    try {
      const raw = await api('/state');
      const list = raw && Array.isArray(raw.instances) ? raw.instances : [];
      const alive = list.some((i) => String(pick(i, ['id', 'instanceId']) || '') === String(instanceId) &&
        ['starting', 'ready', 'stopping'].indexOf(String(pick(i, ['phase', 'status', 'state']) || '')) >= 0);
      if (!alive) return true;
    } catch (err) { /* 网络抖一下继续等 */ }
    await sleep(500);
  }
  return false;
}

/* 最终命令预览：变量规则和 M2 的 buildVariables 对齐（runtime.mjs） */
function buildVars(model, engine) {
  const vars = Object.assign({}, model.params || {});
  vars.host = '127.0.0.1';
  const port = model.port || engine.defaultPort;
  if (port) vars.port = String(port);
  vars.modelId = model.engineModelId || model.id || '（模型 id）';
  vars.engineDir = engine.file ? dirname(engine.file) : '';
  /* 思考参数（§5.3）：和 M2 的 buildVariables 对齐；空串会被 dropEmptyPairs 去掉整个 flag 对 */
  vars.thinkingEffort = (model.thinking && model.thinking.effort) || '';
  vars.thinkingBudget = (model.thinking && model.thinking.budget != null) ? String(model.thinking.budget) : '';

  for (const s of cfgSlots()) {
    const v = model.files && model.files[s.key];
    if (!s.arg && v) vars[s.key] = v;
    if (v) vars[s.key + 'Dir'] = s.kind === 'dir' ? v : dirname(v);
  }
  return vars;
}

function lookupTemplateVar(vars, name) {
  if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
  /* M2 支持显式写法 {params.maxContext} */
  if (name.indexOf('params.') === 0) {
    const flat = name.slice('params.'.length);
    if (Object.prototype.hasOwnProperty.call(vars, flat)) return vars[flat];
  }
  return undefined;
}

function tokenHtml(tok, vars) {
  const raw = String(tok);
  let bad = false;
  const replaced = raw.replace(/\{([\w.]+)\}/g, (m, name) => {
    const v = lookupTemplateVar(vars, name);
    if (v === undefined || v === null || v === '') { bad = true; return m; }
    return String(v);
  });
  let html = esc(quoteArg(replaced));
  if (bad) html = '<span class="bad">' + html + '</span>';
  return '<span class="tok">' + html + '</span>';
}

function buildCommand(model) {
  const engine = cfgCtx.engine;
  if (engine.mode === 'remote') {
    return { html: '<span class="tok">云端模型：没有本地启动命令</span>' };
  }
  if (model.mode === 'package') {
    const file = engine.file || '';
    let line = '(还没有启动脚本)';
    if (file) {
      const lower = file.toLowerCase();
      if (lower.endsWith('.bat') || lower.endsWith('.cmd') || engine.kind === 'bat') line = 'cmd /c ' + quoteArg(file);
      else if (lower.endsWith('.py') || engine.kind === 'py') line = 'python ' + quoteArg(file);
      else if (lower.endsWith('.ps1')) line = 'powershell -File ' + quoteArg(file);
      else line = quoteArg(file);
    }
    return { html: '<span class="tok">' + esc(line) + '</span>' };
  }
  const vars = buildVars(model, engine);
  const tokens = [];

  /* D2：带 arg 的槽位由系统自动拼在模板**前面**（和 M2 的 buildCustomCommand 一致） */
  for (const s of cfgSlots()) {
    const v = model.files[s.key];
    if (v && s.arg) tokens.push(s.arg, v);
  }
  for (const t of (engine.argv || [])) tokens.push(t);

  /* 能力开关（视觉/投机）：和 M2 的 buildCustomCommand 同一套规则 ——
     引擎声明 capabilityArgs，模型 params 说 true 才拼；extraArgs 里已手写的跳过 */
  const extraList = Array.isArray(model.extraArgs) ? model.extraArgs.map(String) : splitArgs(model.extraArgs || '');
  const capArgs = (engine.capabilityArgs && typeof engine.capabilityArgs === 'object') ? engine.capabilityArgs : {};
  for (const cap of Object.keys(capArgs)) {
    if (!model.params || model.params[cap] !== true) continue;
    const tpl = capArgs[cap];
    if (!Array.isArray(tpl) || !tpl.length) continue;
    const flag = tpl.map(String).find((t) => t.startsWith('-'));
    if (flag && extraList.includes(flag)) continue;
    for (const t of tpl) tokens.push(t);
  }

  for (const t of extraList) tokens.push(t);

  if (!tokens.length) return { html: '<span class="bad">这个引擎没有参数模板（argv），拼不出命令</span>' };
  return { html: tokens.map((t) => tokenHtml(t, vars)).join(' ') };
}

function currentCfgMode() {
  return ($('input[name="cfg-mode"]:checked') || {}).value || (cfgCtx && cfgCtx.engine.mode) || 'custom';
}

function renderCmdPreview() {
  if (!cfgCtx) return;
  const box = el('cfg-cmd');
  if (!box) return;
  const model = readCfg();
  if (!model) return;
  model.mode = currentCfgMode();
  box.innerHTML = buildCommand(model).html;
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(renderCmdPreview, 120);
}

/* ---------- 8. 显存不足弹窗 ---------- */

function normEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unit = raw.unit === 'GiB' || raw.unit === 'MiB' ? raw.unit : '';
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  const grab = (v) => {
    if (v == null) return { need: null, free: null, short: null };
    if (typeof v === 'number' || typeof v === 'string') return { need: num(v), free: null, short: null };
    const o = obj(v) || {};
    return {
      need: num(o.need != null ? o.need : (o.estimated != null ? o.estimated : (o.total != null ? o.total : null))),
      free: num(o.free != null ? o.free : (o.available != null ? o.available : o.avail)),
      short: num(o.short != null ? o.short : (o.deficit != null ? o.deficit : o.gap)),
    };
  };

  const vram = grab(raw.vram != null ? raw.vram : (raw.vramMiB != null ? raw.vramMiB : (raw.gpu != null ? raw.gpu : raw.memory)));
  const ram = grab(raw.ram != null ? raw.ram : (raw.ramMiB != null ? raw.ramMiB : raw.hostRam));
  const freeTop = num(raw.free != null ? raw.free : raw.freeMiB);
  const shortTop = num(raw.short != null ? raw.short : (raw.shortage != null ? raw.shortage : raw.shortMiB));

  /* M4 的 estimate 用的是这一组名字（单位 MiB） */
  const direct = {
    vramNeed: num(raw.neededVram != null ? raw.neededVram : raw.neededVramMiB),
    ramNeed: num(raw.neededRam != null ? raw.neededRam : raw.hostRamMiB),
    vramFree: num(raw.freeVram != null ? raw.freeVram : raw.freeVramMiB),
    ramFree: num(raw.freeRam != null ? raw.freeRam : raw.freeRamMiB),
    vramShort: num(raw.shortVram),
    ramShort: num(raw.shortRam),
  };

  const toG = (v) => {
    if (v == null) return null;
    if (unit === 'GiB') return v;
    if (unit === 'MiB') return v / 1024;
    return Math.abs(v) >= 100 ? v / 1024 : v;
  };

  const gv = {
    need: toG(direct.vramNeed != null ? direct.vramNeed : vram.need),
    free: toG(direct.vramFree != null ? direct.vramFree : (freeTop != null ? freeTop : vram.free)),
    short: toG(direct.vramShort != null ? direct.vramShort : (shortTop != null ? shortTop : vram.short)),
  };
  const gr = {
    need: toG(direct.ramNeed != null ? direct.ramNeed : ram.need),
    free: toG(direct.ramFree != null ? direct.ramFree : ram.free),
    short: toG(direct.ramShort != null ? direct.ramShort : ram.short),
  };
  if (gv.short == null && gv.need != null && gv.free != null) gv.short = Math.max(0, gv.need - gv.free);
  if (gr.short == null && gr.need != null && gr.free != null) gr.short = Math.max(0, gr.need - gr.free);

  return {
    vram: gv,
    ram: gr,
    breakdown: obj(raw.breakdown),
    source: typeof raw.source === 'string' ? raw.source : (raw.source && raw.source.type ? String(raw.source.type) : ''),
    measuredAt: raw.measuredAt || raw.measured_at || '',
    lastFailure: raw.lastFailure || raw.failure || '',
    unknown: gv.short == null && gr.short == null,
  };
}

function estimateShort(raw) {
  if (raw && raw.short === true) return true;
  const n = normEstimate(raw);
  if (!n) return false;
  if (n.vram.short != null && n.vram.short > 0.001) return true;
  if (n.ram.short != null && n.ram.short > 0.001) return true;
  return false;
}

function sourceText(src, at) {
  const date = at ? String(at).slice(0, 10) : '';
  if (src === 'measured') return '实测' + (date ? '（' + date + '，同卡同驱动）' : '');
  if (src === 'formula') return '公式估算（第一次，或硬件变了）';
  if (src === 'manual') return '手动填写';
  return src;
}

function vramTitle(est) {
  const n = normEstimate(est);
  if (!n) return '显存可能不够';
  const vramShort = n.vram.short;
  const ramShort = n.ram.short;
  if ((vramShort == null || vramShort <= 0) && ramShort != null && ramShort > 0) return '内存可能不够';
  return '显存可能不够';
}

function renderVram(est, model) {
  const n = normEstimate(est);
  const rows = [];
  const row = (k, v, color) => '<div class="crow"><span>' + esc(k) + '</span><span' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(v) + '</span></div>';

  if (n) {
    const v = n.vram;
    if (v.need != null || v.free != null || v.short != null) {
      rows.push('<div class="sec" style="margin-top:0">显存</div>');
      if (v.need != null) rows.push(row('预计需要', gib(v.need)));
      if (v.free != null) rows.push(row('当前可用', gib(v.free)));
      if (v.short != null) rows.push(row('缺口', v.short > 0 ? gib(v.short) : '够', v.short > 0 ? 'var(--red)' : 'var(--green)'));
    }
    const r = n.ram;
    if (r.need != null || r.free != null || r.short != null) {
      rows.push('<div class="sec">内存</div>');
      if (r.need != null) rows.push(row('预计需要', gib(r.need)));
      if (r.free != null) rows.push(row('当前可用', gib(r.free)));
      if (r.short != null) rows.push(row('缺口', r.short > 0 ? gib(r.short) : '够', r.short > 0 ? 'var(--red)' : 'var(--green)'));
    }
  }
  if (!rows.length) rows.push('<div class="hint" style="margin-top:0">后端只说了「可能不够」，没给明细。</div>');

  const hints = [];
  const bd = n && n.breakdown;
  if (bd) {
    const parts = [];
    if (bd.weightsMiB != null) parts.push('权重 ' + gib(mibToGib(bd.weightsMiB)));
    if (bd.kvMiB != null) parts.push('KV ' + gib(mibToGib(bd.kvMiB)));
    const workspace = bd.runtimeMiB != null ? bd.runtimeMiB : bd.workspaceMiB;
    if (workspace != null) parts.push('工作区 ' + gib(mibToGib(workspace)));
    if (parts.length) hints.push(parts.join(' + '));
  }
  const hostKv = est && (est.hostKvMiB != null ? est.hostKvMiB : est.hostKv);
  if (hostKv != null) hints.push('主机 KV ' + gib(mibToGib(hostKv)) + '（主机内存，不占显存）');
  if (n && n.source) hints.push('依据 ' + sourceText(n.source, n.measuredAt));
  if (n && n.lastFailure) {
    const lf = n.lastFailure;
    hints.push('上次强行加载失败：' + (typeof lf === 'string' ? lf : (lf.message || JSON.stringify(lf))));
  }
  hints.push('走主机内存 / 混跑的话，显存实际占用会更少。');

  return '<div class="probeline">' + esc(model ? (model.label || model.id) : '') + '</div>' +
    rows.join('') +
    '<div class="hint">' + hints.map((h) => esc(h)).join('<br>') + '</div>';
}

function openVram(modelId, est, modelIds) {
  const model = S.models.find((m) => m.id === modelId) || null;
  const t = el('vram-title');
  if (t) t.textContent = vramTitle(est);
  const body = el('vram-body');
  if (body) body.innerHTML = renderVram(est, model);
  /* modelIds 只有多模型加载才传：强行加载时要带上这一组，不能退回单个 */
  vramCtx = { modelId, modelIds: Array.isArray(modelIds) ? modelIds : null };
  openModal('m-vram');
}

function vramForce() {
  const ctx = vramCtx;
  vramCtx = null;
  closeModal('m-vram');
  if (!ctx) return;
  if (ctx.modelIds && ctx.modelIds.length > 1) loadMulti(ctx.modelId, true);
  else actLoad(ctx.modelId, true);
}

/* ---------- 9. 在飞请求弹窗 ---------- */

function openInflight(modelId, inst, count) {
  const model = S.models.find((m) => m.id === modelId);
  inflightCtx = { modelId, instanceId: inst ? inst.id : '', count: count || 0 };
  const body = el('inflight-body');
  if (body) {
    const n = Number(count) > 0 ? '还有 ' + count + ' 个请求' : '还有请求';
    body.innerHTML = '<div style="font-size:13px;line-height:1.8">' +
      esc(model ? (model.label || model.id) : modelId) + '<br>' +
      '<span style="color:var(--muted)">' + n + '正在处理，现在关掉会中断它们。</span>' +
    '</div>';
  }
  openModal('m-inflight');
}

function inflightWait() {
  const ctx = inflightCtx;
  inflightCtx = null;
  closeModal('m-inflight');
  if (!ctx) return;
  S.pendingClose.add(ctx.modelId);
  toast('等请求跑完就自动关闭', 'info');
  render();
}

function inflightForce() {
  const ctx = inflightCtx;
  inflightCtx = null;
  closeModal('m-inflight');
  if (!ctx) return;
  const inst = S.instById.get(ctx.instanceId) || S.byModel.get(ctx.modelId);
  if (!inst) { refresh(); return; }
  doClose(inst, ctx.modelId, true);
}

/* ---------- 10. 试启动 / 运行日志弹窗 ---------- */

function resetProbeUI(isLog) {
  const setText = (id, v) => { const node = el(id); if (node) node.textContent = v; };
  setText('probe-title', isLog ? '运行日志' : '试启动');
  const dot = el('probe-dot');
  if (dot) dot.className = 'dot warn';
  setText('probe-status', isLog ? '加载中…' : '准备中…');
  const portbox = el('probe-portbox');
  if (portbox) portbox.hidden = true;
  setText('probe-port', '');
  setText('probe-readyurl', '');
  const stalled = el('probe-stalled');
  if (stalled) { stalled.hidden = true; stalled.textContent = ''; }
  const log = el('probe-log');
  if (log) log.textContent = '';
  const manual = el('probe-manual');
  if (manual) manual.hidden = isLog;
  const accept = el('probe-accept');
  if (accept) { accept.hidden = isLog; accept.disabled = true; }
  const stop = el('probe-stop');
  if (stop) stop.hidden = isLog;
  const input = el('probe-portin');
  if (input) input.value = '';
  setText('probe-hint', isLog
    ? '每 2 秒刷新一次。日志接口 GET /api/instances/:id/log 不在 M6 契约里，没有它会给出提示。'
    : '不设死超时：引擎慢就让它等。30 秒一行输出都没有，才提示「脚本可能停在等输入」。');
}

function openProbe(payload) {
  stopProbe();
  resetProbeUI(false);
  probe = {
    kind: 'probe',
    startedAt: Date.now(),
    lines: [],
    port: null,
    done: false,
    ok: false,
    stalled: 0,
    abort: new AbortController(),
    timer: setInterval(paintProbeStatus, 1000),
  };
  openModal('m-probe');
  paintProbeStatus();
  runProbe(payload);
}

function paintProbeStatus() {
  if (!probe) return;
  const box = el('probe-status');
  if (!box) return;
  if (probe.kind === 'log') {
    box.textContent = '运行日志 · 每 2 秒刷新';
    return;
  }
  const secs = Math.max(0, Math.round((Date.now() - probe.startedAt) / 1000));
  let html;
  if (probe.done && probe.ok) {
    html = '<span class="ok">✓ 试启动成功</span>' + (probe.port ? ' · 端口 <b>:' + esc(String(probe.port)) + '</b>' : '');
  } else if (probe.done) {
    html = '<span style="color:var(--red)">试启动未成功</span>';
  } else {
    html = '正在启动 · 已等 <b>' + secs + '</b> 秒';
    if (probe.port) html += ' · 已探到 <b>:' + esc(String(probe.port)) + '</b>';
    if (probe.stalled) html += ' · <span class="warnc">' + esc(String(probe.stalled)) + ' 秒没输出</span>';
  }
  box.innerHTML = html;
}

function appendProbeLog(line) {
  if (!probe) return;
  probe.lines.push(String(line));
  if (probe.lines.length > MAX_LOG_LINES) probe.lines.splice(0, probe.lines.length - MAX_LOG_LINES);
  const box = el('probe-log');
  if (box) {
    box.textContent = probe.lines.join('\n');
    box.scrollTop = box.scrollHeight;
  }
}

function handleSse(part, ctx) {
  let event = 'message';
  const dataLines = [];
  for (const line of part.split('\n')) {
    if (!line || line.charAt(0) === ':') continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  const dataText = dataLines.join('\n');
  let payload = null;
  if (dataText) {
    try { payload = JSON.parse(dataText); } catch (err) { payload = { line: dataText }; }
  }
  if (probe !== ctx) return;

  if (event === 'log') {
    const line = payload && (payload.line != null ? payload.line : (payload.text != null ? payload.text : payload.message));
    if (line != null) appendProbeLog(line);
    return;
  }
  if (event === 'port') {
    const port = payload && Number(payload.port);
    if (port) {
      ctx.port = port;
      const box = el('probe-portbox');
      if (box) box.hidden = false;
      const p = el('probe-port');
      if (p) p.textContent = '端口 :' + port;
      const ready = el('probe-readyurl');
      if (ready) ready.textContent = payload.readyUrl || '';
      const accept = el('probe-accept');
      if (accept) accept.disabled = false;
      const input = el('probe-portin');
      if (input) input.value = String(port);
      appendProbeLog('发现端口 ' + port + (payload.readyUrl ? ' · 判活地址 ' + payload.readyUrl : ''));
    }
    return;
  }
  if (event === 'stalled') {
    const secs = payload && payload.seconds != null ? Number(payload.seconds) : NaN;
    ctx.stalled = Number.isFinite(secs) ? secs : '';
    const box = el('probe-stalled');
    if (box) {
      box.hidden = false;
      box.textContent = '⚠ ' + (ctx.stalled ? ctx.stalled + ' 秒' : '一段时间') +
        '没有任何输出，脚本可能停在等输入（整合包 bat 经常问「按 1 用 GPU / 按 2 用 CPU」）。';
    }
    paintProbeStatus();
    return;
  }
  if (event === 'done') {
    ctx.done = true;
    ctx.ok = !payload || payload.ok !== false;
    /* M6 是 { ok, result }（result 里才有 port / readyUrl / reason） */
    const result = payload && payload.result && typeof payload.result === 'object' ? payload.result : null;
    const donePort = Number(payload && payload.port != null ? payload.port : (result && result.port));
    if (donePort && !ctx.port) {
      ctx.port = donePort;
      const box = el('probe-portbox');
      if (box) box.hidden = false;
      const p = el('probe-port');
      if (p) p.textContent = '端口 :' + donePort;
      const ready = el('probe-readyurl');
      if (ready) ready.textContent = (payload && payload.readyUrl) || (result && result.readyUrl) || '';
      const input = el('probe-portin');
      if (input) input.value = String(donePort);
    }
    const dot = el('probe-dot');
    if (dot) dot.className = 'dot ' + (ctx.ok ? 'on' : 'err');
    const accept = el('probe-accept');
    if (accept && ctx.port) accept.disabled = false;
    const reason = payload && (payload.reason || payload.error || payload.hint) ||
      (result && (result.hint || result.reason || result.error));
    /* 工具探测结果（§5.5.1）：带进导入草稿，保存模型时才会写进 caps.tools。
       以前这里丢掉，导致 caps.tools 永远是 null。 */
    if (ctx.kind === 'probe' && result && result.caps && importCtx) {
      importCtx.probeCaps = Object.assign({}, importCtx.probeCaps || {}, result.caps);
      if (typeof result.caps.tools === 'boolean') {
        appendProbeLog(result.caps.tools ? '✓ 工具调用：支持' : '⚠ 工具调用：没测出来（只回文本）');
      }
    }
    if (!ctx.ok && reason) appendProbeLog('✗ ' + reason);
    appendProbeLog(ctx.ok ? '✓ 试启动成功' : '✗ 试启动未成功');
    paintProbeStatus();
    return;
  }
  if (event === 'error') {
    ctx.done = true;
    ctx.ok = false;
    appendProbeLog('✗ ' + ((payload && (payload.message || payload.line)) || '未知错误'));
    paintProbeStatus();
    return;
  }
  if (dataText) {
    appendProbeLog((payload && (payload.line || payload.message || payload.text)) || dataText);
  }
}

async function runProbe(payload) {
  const ctx = probe;
  if (!ctx) return;
  try {
    const res = await fetch(API_ROOT + '/engines/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(payload || {}),
      signal: ctx.abort.signal,
    });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch (err) { /* 忽略 */ }
      throw new ApiError(res.status, body);
    }
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('浏览器不支持流式读取');

    appendProbeLog('—— 试启动开始 ——');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const chunk = await reader.read();
      if (probe !== ctx) return;
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const part = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleSse(part, ctx);
      }
    }
    if (buf.trim()) handleSse(buf, ctx);
    if (probe === ctx && !ctx.done) {
      /* 连接断了但没收到 done：探到端口就算成功，否则如实说没结果 */
      ctx.done = true;
      ctx.ok = !!ctx.port;
      appendProbeLog(ctx.port ? '—— 流结束，端口已探到 ——' : '✗ 流结束，但没收到 done 事件');
      paintProbeStatus();
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (probe !== ctx) return;
    ctx.done = true;
    ctx.ok = false;
    const dot = el('probe-dot');
    if (dot) dot.className = 'dot err';
    const box = el('probe-stalled');
    if (box) {
      box.hidden = false;
      box.textContent = '试启动接口不可用：' + err.message + '。可以先自己填端口，再点「用它」。';
    }
    appendProbeLog('✗ ' + err.message);
    paintProbeStatus();
  }
}

function stopProbe() {
  if (!probe) return;
  try { if (probe.abort) probe.abort.abort(); } catch (err) { /* 忽略 */ }
  if (probe.timer) clearInterval(probe.timer);
  probe = null;
}

function useManualPort() {
  if (!probe || probe.kind !== 'probe') return;
  const input = el('probe-portin');
  const port = Number(input ? input.value : '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) { toast('端口要填 1–65535', 'err'); return; }
  probe.port = port;
  probe.done = true;
  probe.ok = true;
  const box = el('probe-portbox');
  if (box) box.hidden = false;
  const p = el('probe-port');
  if (p) p.textContent = '端口 :' + port;
  const accept = el('probe-accept');
  if (accept) accept.disabled = false;
  paintProbeStatus();
  toast('用端口 ' + port, 'ok');
}

function acceptProbe() {
  if (!probe || !probe.port) { toast('还没有端口', 'err'); return; }
  const port = probe.port;
  stopProbe();
  closeModal('m-probe');
  const input = el('imp-eng-port');
  if (input) input.value = String(port);
  toast('端口已写入：' + port, 'ok');
}

function openLog(instanceId, title) {
  if (!instanceId) { toast('没有实例可看', 'info'); return; }
  stopProbe();
  resetProbeUI(true);
  const t = el('probe-title');
  if (t) t.textContent = title || '运行日志';
  probe = {
    kind: 'log',
    instanceId,
    startedAt: Date.now(),
    lines: [],
    logFailures: 0,
    timer: null,
  };
  openModal('m-probe');
  paintProbeStatus();
  fetchInstanceLog(true);
  probe.timer = setInterval(() => { paintProbeStatus(); fetchInstanceLog(false); }, 2000);
}

async function fetchInstanceLog(reset) {
  const ctx = probe;
  if (!ctx || ctx.kind !== 'log') return;
  try {
    const data = await api('/instances/' + encodeURIComponent(ctx.instanceId) + '/log?tail=' + LOG_FETCH_TAIL);
    if (probe !== ctx) return;
    const lines = logLinesOf(data);
    if (!lines) throw new Error('日志接口返回的格式看不懂');
    ctx.lines = lines.slice(-MAX_LOG_LINES);
    const box = el('probe-log');
    if (box) {
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      box.textContent = ctx.lines.join('\n');
      if (reset || atBottom) box.scrollTop = box.scrollHeight;
    }
    ctx.logFailures = 0;
  } catch (err) {
    if (probe !== ctx) return;
    ctx.logFailures++;
    const box = el('probe-stalled');
    if (box) {
      box.hidden = false;
      box.textContent = '日志接口不可用：' + err.message +
        '。M6 契约里没有日志端点，加载中的日志尾随只能靠 /api/state 的 logTail。';
    }
    if (ctx.logFailures >= 2 && ctx.timer) {
      clearInterval(ctx.timer);
      ctx.timer = null;
    }
  }
}

/* ---------- 11. 导入整合包弹窗 ---------- */

function openImport(opts) {
  opts = opts || {};
  importCtx = { dir: opts.dir || '', scan: null, engine: null, modelBase: null, reselect: opts.engine || null, probeCaps: null };
  impIdTouched.eng = false;
  impIdTouched.model = false;
  const setVal = (id, v) => { const node = el(id); if (node) node.value = v == null ? '' : String(v); };
  setVal('imp-dir', importCtx.dir);
  for (const id of ['imp-eng-label', 'imp-eng-id', 'imp-eng-file', 'imp-eng-port',
    'imp-model-label', 'imp-model-id', 'imp-model-file']) {
    setVal(id, '');
  }
  const result = el('imp-result');
  if (result) result.innerHTML = '';
  const warn = el('imp-warn');
  if (warn) { warn.hidden = true; warn.innerHTML = ''; }
  const manual = el('imp-manual');
  if (manual) manual.open = false;
  const custom = $('input[name="imp-mode"][value="custom"]');
  if (custom) custom.checked = true;
  const pkg = $('input[name="imp-mode"][value="package"]');
  if (pkg) pkg.disabled = false; /* 上一轮扫描可能把「原样运行」禁掉了 */

  if (opts.engine) {
    const e = opts.engine;
    setVal('imp-eng-label', e.label || '');
    setVal('imp-eng-id', e.id || '');
    setVal('imp-eng-file', e.file || '');
    setVal('imp-eng-port', e.defaultPort || '');
    setVal('imp-dir', e.file ? dirname(e.file) : '');
    if (manual) manual.open = true;
    if (result) {
      result.innerHTML = '<div class="warnrow">正在重新选择引擎文件：保存后会更新引擎「' +
        esc(e.label || e.id) + '」。模型档案不用重填。</div>';
    }
    const mode = $('input[name="imp-mode"][value="' + (e.mode === 'package' ? 'package' : 'custom') + '"]');
    if (mode) mode.checked = true;
  }
  openModal('m-import');
  setImportBusy(false); /* 上次成功导入后按钮可能还停在 disabled */
}

function showImportWarn(list) {
  const box = el('imp-warn');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = list.map((w) => '<div>• ' + esc(w) + '</div>').join('');
}

function normalizeScan(raw) {
  const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : (raw || {});
  const scripts = [];
  const addScript = (v) => {
    if (!v) return;
    if (typeof v === 'string') { scripts.push({ path: v, label: basename(v) }); return; }
    if (typeof v === 'object') {
      const path = v.path || v.file || v.script || '';
      if (!path) return;
      scripts.push({
        path,
        label: v.label || v.name || basename(path),
        engine: v.engine || null,
        model: v.model || null,
        params: v.params || v.parsed || null,
      });
    }
  };
  const scriptSources = [].concat(
    Array.isArray(data.scripts) ? data.scripts : (data.scripts ? [data.scripts] : []),
    Array.isArray(data.bats) ? data.bats : [],
    Array.isArray(data.candidates && data.candidates.scripts) ? data.candidates.scripts : []
  );
  scriptSources.forEach(addScript);
  if (!scripts.length && data.script) addScript(data.script);
  if (!scripts.length && data.bat) addScript(data.bat);

  let engineRaw = data.engine || (data.candidates && data.candidates.engine) || null;
  if (!engineRaw && Array.isArray(data.candidates && data.candidates.engines)) engineRaw = data.candidates.engines[0];
  if (!engineRaw && Array.isArray(data.engines)) engineRaw = data.engines[0];

  let modelRaw = data.model || (data.candidates && data.candidates.model) || null;
  if (!modelRaw && Array.isArray(data.candidates && data.candidates.models)) modelRaw = data.candidates.models[0];
  if (!modelRaw && Array.isArray(data.models)) modelRaw = data.models[0];

  const dir = data.dir || data.folder || data.path || '';
  const first = scripts[0] || null;
  const params = Object.assign({}, data.params || (first && first.params) || (data.parsed && data.parsed.params) || {});
  /* 启动脚本 --config 指向的 JSON（Strata 这种）：bat 里看不出 MTP/视觉/量化，得从配置里读 */
  const scanConfig = data.config && data.config.summary ? data.config.summary : null;
  if (scanConfig) {
    if (scanConfig.maxContext != null) params.maxContext = scanConfig.maxContext;
    if (scanConfig.kvDtype) params.kvDtype = scanConfig.kvDtype;
    if (scanConfig.mtp != null) params.mtp = scanConfig.mtp;
    if (scanConfig.vision != null) params.vision = scanConfig.vision;
    if (scanConfig.spec) params.spec = scanConfig.spec;
    if (scanConfig.draftTokens != null) params.draftTokens = scanConfig.draftTokens;
  }

  const engine = normalizeScanEngine(engineRaw, dir, first && first.path, params);
  const model = normalizeScanModel(modelRaw, dir, params);
  if (model && scanConfig) {
    model.caps = Object.assign({}, model.caps, { mtp: scanConfig.mtp, vision: scanConfig.vision });
  }

  const warnings = []
    .concat(Array.isArray(data.warnings) ? data.warnings : [])
    .concat(Array.isArray(data.errors) ? data.errors : [])
    .map((w) => (typeof w === 'string' ? w : ((w && w.message) || JSON.stringify(w))));

  const summaryBits = [];
  if (scanConfig) summaryBits.push('参数来自 ' + basename(scanConfig.file || '配置文件'));
  if (params.port) summaryBits.push('端口 ' + params.port);
  if (params.maxContext) summaryBits.push('上下文 ' + params.maxContext);
  if (params.kvDtype) summaryBits.push('量化 ' + params.kvDtype);

  return {
    dir: dir || (engine && engine.file ? dirname(engine.file) : ''),
    scripts,
    scriptIndex: 0,
    scriptName: first ? first.label : '',
    engine,
    model,
    engineSize: engineRaw && (engineRaw.size || engineRaw.sizeBytes),
    modelSize: modelRaw && (modelRaw.size || modelRaw.sizeBytes),
    params,
    config: data.config || null,
    configBacked: Boolean(data.configBacked),
    configScript: data.configScript || null,
    summary: summaryBits.join(' · '),
    warnings,
  };
}

function normalizeScanEngine(raw, dir, scriptPath, params) {
  if (!raw && !scriptPath) return null;
  const r = typeof raw === 'string' ? { file: raw } : (raw || {});
  const file = r.file || r.path || scriptPath || '';
  if (!file) return null;
  return {
    id: r.id || slug(basenameNoExt(file)) || '',
    label: r.label || basename(file),
    mode: r.mode || 'package',
    kind: r.kind || (/\.(bat|cmd)$/i.test(file) ? 'bat' : (/\.py$/i.test(file) ? 'py' : (/\.ps1$/i.test(file) ? 'ps1' : 'exe'))),
    file,
    cwd: r.cwd || dirname(file),
    defaultPort: r.defaultPort || (params && params.port) || 18095,
    fileSlots: Array.isArray(r.fileSlots) && r.fileSlots.length ? r.fileSlots : [{ key: 'model', label: '模型文件', kind: 'file' }],
    argv: Array.isArray(r.argv) ? r.argv.map(String) : (typeof r.argv === 'string' ? splitArgs(r.argv) : []),
    env: r.env || null,
    webUI: r.webUI || null,
    ready: r.ready || null,
    stop: r.stop || null,
    footprintLog: r.footprintLog || null,
  };
}

function normalizeScanModel(raw, dir, params) {
  const r = typeof raw === 'string' ? { file: raw } : (raw || null);
  const files = {};
  if (r && r.files && typeof r.files === 'object') Object.assign(files, r.files);
  if (r && (r.file || r.path) && !Object.keys(files).length) files.model = r.file || r.path;
  if (!Object.keys(files).length && dir && /\.(gguf|ninfer|safetensors)$/i.test(dir)) files.model = dir;
  if (!Object.keys(files).length) return null;

  const values = Object.keys(files).map((k) => files[k]).filter((v) => typeof v === 'string' && v);
  const firstFile = values[0] || '';
  const rawName = (r && (r.label || r.name)) || basenameNoExt(firstFile) || '新模型';
  // 去掉模型扩展名：id 规则不允许以 . 结尾，文件名也不适合直接当显示名
  const name = String(rawName).replace(/\.(gguf|ninfer|safetensors)$/i, '');
  return {
    id: (r && r.id) || slug(name).replace(/^[^a-zA-Z0-9]+/, '') || 'model',
    label: name,
    files,
    params: Object.assign({}, (r && r.params) || params || {}),
    caps: (r && r.caps) || {},
    thinking: (r && r.thinking) || { effort: 'none', budget: 512, allowRequestOverride: false },
    kind: (r && r.kind) || 'chat',
    port: r && r.port,
  };
}

function fillImportFromScan(scan) {
  const e = scan.engine || {};
  const m = scan.model || {};
  const setVal = (id, v) => { const node = el(id); if (node) node.value = v == null ? '' : String(v); };
  const firstFile = m.files ? (m.files.model || Object.keys(m.files).map((k) => m.files[k]).filter((v) => typeof v === 'string')[0]) : '';
  setVal('imp-eng-file', e.file || (scan.scripts[0] && scan.scripts[0].path) || scan.dir || '');
  setVal('imp-eng-label', e.label || basename(scan.dir) || '');
  if (!impIdTouched.eng) setVal('imp-eng-id', e.id || slug(e.label || basename(scan.dir) || basenameNoExt(e.file)));
  setVal('imp-eng-port', scan.params.port || e.defaultPort || 18095);
  setVal('imp-model-file', firstFile || '');
  setVal('imp-model-label', m.label || '');
  if (!impIdTouched.model) setVal('imp-model-id', m.id || slug(m.label || basenameNoExt(firstFile)));
}

function renderScanResult(scan) {
  const box = el('imp-result');
  if (!box) return;
  const scriptName = scan.scripts.length ? (scan.scripts[scan.scriptIndex].label || '') : '';
  const modelFile = scan.model ? modelFirstFile(scan.model) : '';
  const rows = [];

  rows.push('<div class="scan">');
  rows.push('<div>' + (scan.scripts.length ? '<span class="ok">✓</span>' : '<span class="warnc">✗</span>') +
    ' 启动脚本 ' + (scriptName ? '<span style="color:var(--text)">' + esc(scriptName) + '</span>' : '<span style="color:var(--dim)">没找到 .bat / .cmd</span>') + '</div>');
  rows.push('<div>' + (scan.engine ? '<span class="ok">✓</span>' : '<span class="warnc">✗</span>') +
    ' 引擎 ' + (scan.engine ? '<span style="color:var(--text)">' + esc(basename(scan.engine.file)) + '</span>' : '<span style="color:var(--dim)">没找到 .exe</span>') +
    (scan.engineSize ? ' <span style="color:var(--dim)">' + esc(fmtBytes(scan.engineSize)) + '</span>' : '') + '</div>');
  rows.push('<div>' + (scan.model ? '<span class="ok">✓</span>' : '<span class="warnc">✗</span>') +
    ' 模型 ' + (scan.model ? '<span style="color:var(--text)">' + esc(basename(modelFile)) + '</span>' : '<span style="color:var(--dim)">没找到 .gguf / .ninfer</span>') +
    (scan.modelSize ? ' <span style="color:var(--dim)">' + esc(fmtBytes(scan.modelSize)) + '</span>' : '') + '</div>');
  if (scan.summary) {
    rows.push('<div style="margin-top:8px;color:var(--muted);font-size:12px">从 ' + esc(scan.scriptName || '启动脚本') + ' 拆出：' + esc(scan.summary) + '</div>');
  }
  rows.push('</div>');

  if (scan.scripts.length > 1) {
    rows.push('<div class="frow" style="margin-top:8px"><div class="fi"><label>发现 ' + scan.scripts.length + ' 个启动脚本，选一个</label><select id="imp-script">' +
      scan.scripts.map((s, i) => '<option value="' + i + '"' + (i === scan.scriptIndex ? ' selected' : '') + '>' + esc(s.label || s.path) + '</option>').join('') +
      '</select></div></div>');
  }
  box.innerHTML = rows.join('');
}

function modelFirstFile(m) {
  if (!m || !m.files) return '';
  for (const k of Object.keys(m.files)) {
    if (typeof m.files[k] === 'string' && m.files[k]) return m.files[k];
  }
  return '';
}

async function scanImport() {
  const dir = cleanPathText((el('imp-dir') || {}).value);
  if (!dir) { showImportWarn(['先填一个文件夹路径（或整合包里的 bat 路径）']); return; }
  const result = el('imp-result');
  if (result) result.innerHTML = '<div class="note">扫描中…</div>';
  try {
    const raw = await api('/import/scan', { method: 'POST', timeoutMs: 20000, body: { dir } });
    const scan = normalizeScan(raw);
    importCtx.scan = scan;
    importCtx.engine = scan.engine;
    importCtx.modelBase = scan.model;
    fillImportFromScan(scan);
    renderScanResult(scan);

    /* 没有 .bat / .cmd 时「原样运行」是死路：那就是以 argv=[] 直接跑 exe，
       引擎收不到任何参数，只会打印帮助然后 exit 1（ninfer 就是这么失败的）。
       所以直接禁掉这一项并说明原因。 */
    const hasScript = Array.isArray(scan.scripts) && scan.scripts.length > 0;
    const pkg = $('input[name="imp-mode"][value="package"]');
    const cus = $('input[name="imp-mode"][value="custom"]');
    if (pkg) {
      pkg.disabled = !hasScript;
      if (!hasScript) {
        pkg.checked = false;
        if (cus) cus.checked = true;
      }
    }
    const notes = scan.warnings.slice();
    if (!hasScript) {
      notes.push('这个包里没有 .bat / .cmd：已切到「按参数运行」。原样运行会把 exe 直接跑起来（没有任何参数），引擎只会打帮助然后退出。');
    }
    /* 参数都在 --config 指向的 JSON 里：按「原样运行」导入，界面才会走"读写配置"的通道；
       否则 custom 模式下改参数只写模型档案，对启动没有任何影响。 */
    if (scan.configBacked && hasScript) {
      if (pkg && !pkg.disabled) pkg.checked = true;
      if (cus) cus.checked = false;
      notes.push('参数都在 ' + basename((scan.config && scan.config.file) || scan.configScript || '配置文件') +
        ' 里：已按「原样运行」导入，模型配置里改的参数会写回它。');
    }
    if (notes.length) showImportWarn(notes);
    else {
      const warn = el('imp-warn');
      if (warn) { warn.hidden = true; warn.innerHTML = ''; }
    }
  } catch (err) {
    importCtx.scan = null;
    const manual = el('imp-manual');
    if (manual) manual.open = true;
    /* 超时不是"接口没了"：别让界面永远停在"扫描中…" */
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      if (result) {
        result.innerHTML = '<div class="warnrow">扫描超时（20 秒）：目录可能太大，或者盘符正忙。把路径缩小到整合包那一层再试。</div>';
      }
      return;
    }
    if (err instanceof ApiError && err.status === 404) {
      if (result) {
        result.innerHTML = '<div class="warnrow">扫描接口没实现（POST /api/import/scan 不在 M6 契约里）。可以手动填下面的字段：引擎启动文件、模型文件、端口；导入时走 POST /api/engines + POST /api/models。</div>';
      }
      showImportWarn(['扫描不可用，已切到手动填写。']);
    } else {
      if (result) result.innerHTML = '';
      showImportWarn(['扫描失败：' + err.message]);
    }
  }
}

function draftFromForm() {
  const engineObj = (importCtx && importCtx.engine) || {};
  /* 重新选择引擎文件时要用完整档案，不然会把 ready / stop / 槽位等字段写丢 */
  const baseRaw = engineObj.raw && typeof engineObj.raw === 'object' ? engineObj.raw : engineObj;
  const base = Object.assign({}, baseRaw);
  /* 这些是界面/状态里加的，不属于引擎定义 */
  delete base.missing;
  delete base.error;
  delete base.orphan;
  delete base.raw;
  delete base.runningInstances;
  delete base.loadedModels;
  const mBase = (importCtx && importCtx.modelBase) || null;
  const mode = ($('input[name="imp-mode"]:checked') || {}).value || 'custom';
  const val = (id) => cleanPathText((el(id) || {}).value);

  const engineFile = val('imp-eng-file');
  const engineId = val('imp-eng-id') || slug(basenameNoExt(engineFile)) || ('engine-' + Date.now().toString(36));
  const extKind = /\.(bat|cmd)$/i.test(engineFile) ? 'bat'
    : (/\.py$/i.test(engineFile) ? 'py'
      : (/\.ps1$/i.test(engineFile) ? 'ps1' : (/\.(exe|com)$/i.test(engineFile) ? 'exe' : '')));
  const engine = Object.assign({}, base, {
    id: engineId,
    label: val('imp-eng-label') || engineId,
    mode,
    kind: extKind || base.kind || 'exe',
    file: engineFile,
    cwd: base.cwd || dirname(engineFile),
    defaultPort: Number(val('imp-eng-port')) || base.defaultPort || 18095,
    fileSlots: base.fileSlots && base.fileSlots.length ? base.fileSlots : [{ key: 'model', label: '模型文件', kind: 'file' }],
    argv: mode === 'custom'
      ? (base.argv && base.argv.length ? base.argv : DEFAULT_ARGV.slice())
      : [],
  });

  const files = Object.assign({}, (mBase && mBase.files) || {});
  const typed = val('imp-model-file');
  if (typed) {
    const key = (engine.fileSlots[0] && engine.fileSlots[0].key) || 'model';
    files[key] = typed;
  }
  const params = Object.assign({}, (mBase && mBase.params) || {});
  /* 兜底模板里有 {maxContext}，缺了它启动会因变量未解析失败 */
  if (mode === 'custom' && !(base.argv && base.argv.length) && params.maxContext == null) params.maxContext = 32768;
  const modelId = val('imp-model-id') || slug(basenameNoExt(typed)) || ('model-' + Date.now().toString(36));
  const model = {
    id: modelId,
    label: val('imp-model-label') || modelId,
    engineId,
    kind: (mBase && mBase.kind) || 'chat',
    files,
    params,
    caps: Object.assign({}, (mBase && mBase.caps) || {}, (importCtx && importCtx.probeCaps) || {}),
    thinking: (mBase && mBase.thinking) || { effort: 'none', budget: 512, allowRequestOverride: false },
    extraArgs: [],
  };
  if (mBase && mBase.port != null) model.port = mBase.port;
  if (mBase && mBase.port != null) model.port = mBase.port;
  return { engine, model, reselect: !!(importCtx && importCtx.reselect) };
}

function probeDraft() {
  const d = draftFromForm();
  if (!d.engine.file) { showImportWarn(['先填引擎启动文件，再试启动']); return; }
  openProbe({
    engine: d.engine,
    model: d.reselect ? null : d.model,
    dir: (importCtx && importCtx.dir) || '',
  });
}

function setImportBusy(on) {
  const modal = el('m-import');
  if (!modal) return;
  const foot = modal.querySelector('.cfoot');
  if (!foot) return;
  for (const btn of foot.querySelectorAll('button')) {
    if (!btn.hasAttribute('data-close')) btn.disabled = !!on;
  }
}

async function saveImport() {
  if (!importCtx) return;
  const d = draftFromForm();
  const errs = [];
  if (!d.engine.file) errs.push('引擎启动文件没填');
  if (!d.engine.id) errs.push('引擎 id 没填');
  else if (!isSafeId(d.engine.id)) errs.push('引擎 id 只能字母/数字开头，含字母数字 . _ -，不能以 . 结尾（下面「手动填写 / 修改」里可以改）');
  if (d.engine.mode === 'package' && !/\.(bat|cmd)$/i.test(d.engine.file || '')) {
    errs.push('「原样运行」只能用于 .bat / .cmd：exe 这样跑等于不给参数，引擎只会打印帮助然后退出。请选「按参数运行」。');
  }
  if (!d.reselect) {
    if (!Object.keys(d.model.files).length) errs.push('模型文件没填（多槽位引擎请用扫描）');
    if (!d.model.id) errs.push('模型 id 没填');
    else if (!isSafeId(d.model.id)) errs.push('模型 id 只能字母/数字开头，含字母数字 . _ -，不能以 . 结尾（下面「手动填写 / 修改」里可以改）');
  }
  if (errs.length) {
    /* id 有问题：自动展开手动填写区，并把焦点放到那个输入框，别让人自己找 */
    const badEngineId = !isSafeId(d.engine.id);
    const badModelId = !d.reselect && !isSafeId(d.model.id);
    if (badEngineId || badModelId) {
      const manual = el('imp-manual');
      if (manual) manual.open = true;
      const node = el(badEngineId ? 'imp-eng-id' : 'imp-model-id');
      if (node) { try { node.focus(); node.select(); } catch (err) { /* 焦点抢不到就算了 */ } }
    }
    showImportWarn(errs);
    return;
  }

  if (!d.reselect && d.engine.mode === 'custom' && !(importCtx.engine && importCtx.engine.argv && importCtx.engine.argv.length)) {
    showImportWarn(['提示：没有从脚本里拆出参数，按参数运行时用的是通用模板，导入后可能要在模型配置里改。']);
  }

  setImportBusy(true);
  let engineSaved = false;
  try {
    await api('/engines', { method: 'POST', body: d.engine });
    engineSaved = true;
    S.engineMissing.delete(d.engine.id);
    if (!d.reselect) {
      /* 第一次加入：从引擎配置/启动脚本里把真实参数读出来，填进新模型（发布包自描述） */
      try {
        const cfgRes = await api('/engines/' + encodeURIComponent(d.engine.id) + '/config');
        const cfg = (cfgRes && cfgRes.config) || null;
        if (cfg) {
          for (const key of ['maxContext', 'kvWindow', 'kvDtype', 'kvResident', 'hostKvMib', 'kvHeadroomMib', 'prefillChunk', 'mtp', 'draftTokens', 'vision']) {
            if (cfg[key] != null) d.model.params[key] = cfg[key];
          }
        }
      } catch (err) { /* 没有配置就保持默认 */ }
      await api('/models', { method: 'POST', body: d.model });
    }
    closeModal('m-import');
    toast(d.reselect ? '引擎已更新：' + d.engine.id : '已导入 ' + (d.model.label || d.model.id), 'ok');
    refresh();
  } catch (err) {
    setImportBusy(false);
    if (err instanceof ApiError && err.status === 409) {
      showImportWarn(['id 撞车了：' + err.message + '（换个 id 再试）']);
    } else if (engineSaved && !d.reselect) {
      showImportWarn(['引擎已保存，但模型保存失败：' + err.message]);
    } else {
      showImportWarn([err.message]);
    }
  }
}

/* ---------- 12. 接入 DSH 弹窗 ---------- */

async function openDsh() {
  dshText = '';
  const pre = el('dsh-yaml');
  if (pre) pre.textContent = '加载中…';
  const warn = el('dsh-warn');
  if (warn) { warn.hidden = true; warn.innerHTML = ''; }
  const local = el('dsh-local');
  if (local) local.hidden = true;
  openModal('m-dsh');
  try {
    const raw = await api('/dsh/provider');
    const data = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const text = typeof data === 'string' ? data : (data && (data.yaml || data.provider || data.text)) || '';
    if (!text) throw new Error('返回是空的');
    dshText = String(text);
    const noTools = el('dsh-no-tools');
    if (noTools) noTools.checked = false;
    renderDshText();
  } catch (err) {
    if (pre) pre.textContent = '（还没生成）';
    if (warn) {
      warn.hidden = false;
      warn.innerHTML = '⚠ 生成接口 /api/dsh/provider 不可用：' + esc(err.message) +
        '。<br>可以先「本地生成（临时）」——它只按当前状态里的 chat 模型拼，和 M6 的实现可能有出入。';
    }
    if (local) local.hidden = false;
  }
}

function yamlValue(s) {
  const str = String(s);
  if (/[:#\-\[\]{},&*!|>'"%@`\s]/.test(str)) return JSON.stringify(str);
  return str;
}

function buildLocalDsh() {
  const chat = S.models.filter((m) => (m.kind || 'chat') === 'chat');
  const lines = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      kvmem-local:',
    '        displayName: LACI',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:8095/v1',
    '        apiKeyEnv: LACI_LOCAL_API_KEY',
    '        models:',
  ];
  if (!chat.length) lines.push('          []');
  for (const m of chat) {
    let name = m.label || m.id;
    if (m.caps && m.caps.tools === false) name += ' (仅聊天)';
    lines.push('          - id: ' + yamlValue(m.id));
    lines.push('            name: ' + yamlValue(name));
    lines.push('            contextWindow: ' + (pickNum(m.params, ['maxContext']) || 131072));
    lines.push('            maxTokens: ' + (pickNum(m.params, ['maxTokens']) || 8192));
    lines.push('            input:');
    lines.push('              - text');
    if (m.caps && m.caps.vision) lines.push('              - image');
    lines.push('            compat:');
    lines.push('              supportsReasoningEffort: false');
  }
  return lines.join('\n');
}

/** 接入 DSH 弹窗要显示/复制的文本：勾了"禁用其他工具"就补一句 */
function dshDisplayText() {
  const box = el('dsh-no-tools');
  const extra = box && box.checked ? '\n# （本地模型禁用除基本工具外的其他工具）' : '';
  return dshText + extra;
}

function renderDshText() {
  const pre = el('dsh-yaml');
  if (pre) pre.textContent = dshDisplayText();
}

function renderLocalDsh() {
  dshText = buildLocalDsh();
  renderDshText();
  const warn = el('dsh-warn');
  if (warn) {
    warn.hidden = false;
    warn.innerHTML = '⚠ 这是前端临时生成的，只用当前状态里的 chat 模型；正式请用 GET /api/dsh/provider。';
  }
  const local = el('dsh-local');
  if (local) local.hidden = true;
  toast('已本地生成（临时）', 'info');
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  ta.remove();
  if (ok) toast('已复制', 'ok');
  else toast('复制失败，请手动全选复制', 'err');
}

async function copyDsh() {
  const text = dshDisplayText();
  if (!text) { toast('还没有内容可复制', 'err'); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制，发给 agent 即可', 'ok');
  } catch (err) {
    fallbackCopy(text);
  }
}

/* ---------- 13. 弹窗 / 提示 / 事件 ---------- */

function openModal(id) {
  const modal = el(id);
  if (!modal) return;
  modal.classList.add('show');
  document.body.classList.add('modal-open');
  const focusable = modal.querySelector('input:not([type="hidden"]), select, textarea, button');
  if (focusable) {
    setTimeout(() => { try { focusable.focus(); } catch (err) { /* 忽略 */ } }, 30);
  }
}

function closeModal(id) {
  const modal = el(id);
  if (modal) modal.classList.remove('show');
  if (id === 'm-probe') stopProbe();
  if (id === 'm-cfg') cfgCtx = null;
  if (id === 'm-vram') vramCtx = null;
  if (id === 'm-inflight') inflightCtx = null;
  if (!document.querySelector('.modal.show')) document.body.classList.remove('modal-open');
}

function closeAllModals() {
  for (const modal of $$('.modal.show')) modal.classList.remove('show');
  stopProbe();
  cfgCtx = null;
  vramCtx = null;
  inflightCtx = null;
  document.body.classList.remove('modal-open');
}

function toast(message, kind) {
  const box = el('toast');
  if (!box) return;
  const node = document.createElement('div');
  node.className = 'toast ' + (kind || '');
  node.textContent = String(message);
  box.appendChild(node);
  while (box.childElementCount > 4) box.removeChild(box.firstElementChild);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 220);
  }, 3200);
}

function handleError(err, prefix) {
  console.error('[LACI]', prefix, err);
  const msg = err && err.message ? err.message : String(err);
  toast(prefix ? prefix + '：' + msg : msg, 'err');
}

/* 主委托：按钮动作优先于「点行开配置页」，动作按钮上会 stopPropagation */
function onDocumentClick(ev) {
  const target = ev.target;
  if (!target || typeof target.closest !== 'function') return;

  const closeBtn = target.closest('[data-close]');
  if (closeBtn) {
    ev.preventDefault();
    closeModal(closeBtn.getAttribute('data-close'));
    return;
  }

  if (target.classList && target.classList.contains('modal')) {
    closeModal(target.id);
    return;
  }

  const actionEl = target.closest('[data-act]');
  if (actionEl) {
    ev.preventDefault();
    ev.stopPropagation(); /* 关键：点「关闭 / 加载 / 日志」只执行动作，不打开配置页 */
    handleAction(actionEl.getAttribute('data-act'), actionEl);
    return;
  }

  /* 弹窗内部的空白点击不能穿透到主列表 */
  if (target.closest('.modal')) return;

  const add = target.closest('.addmodel');
  if (add) {
    openConfigCreate(add.getAttribute('data-engine'));
    return;
  }

  const row = target.closest('.m');
  if (row) {
    openConfig(row.getAttribute('data-model'));
    return;
  }

  const head = target.closest('.ehead');
  if (head) {
    const card = head.closest('.engine');
    if (card) toggleEngine(card.getAttribute('data-engine'));
  }
}

function toggleEngine(engineId) {
  if (!engineId) return;
  if (S.open.has(engineId)) S.open.delete(engineId);
  else S.open.add(engineId);
  try { localStorage.setItem('laci.ui.open', JSON.stringify(Array.from(S.open))); } catch (err) { /* 忽略 */ }
  renderEngines();
}

function onCfgChange(ev) {
  if (ev.target && ev.target.name === 'cfg-mode') syncCfgMode();
  if (ev.target && ev.target.id === 'cfg-visionResidency') clampVisionMax();
  /* 文件槽位变了：新模型且名称/id 还空着 → 按文件名补上 */
  if (ev.target && /^cfg-file-/.test(String(ev.target.id || ''))) autoFillModelIdentity(ev.target.value);
  schedulePreview();
}

function onImportChange(ev) {
  if (ev.target && ev.target.id === 'imp-model-file') autoFillImportModelIdentity(ev.target.value);
  if (!ev.target || ev.target.id !== 'imp-script') return;
  if (!importCtx || !importCtx.scan) return;
  const idx = Number(ev.target.value);
  const s = importCtx.scan.scripts[idx];
  if (!s) return;
  importCtx.scan.scriptIndex = idx;
  importCtx.scan.scriptName = s.label || basename(s.path);
  const file = el('imp-eng-file');
  if (file) file.value = s.path;
  if (s.engine) importCtx.engine = normalizeScanEngine(s.engine, importCtx.scan.dir, s.path, importCtx.scan.params);
  if (s.model) importCtx.modelBase = normalizeScanModel(s.model, importCtx.scan.dir, importCtx.scan.params);
  toast('已切到 ' + (s.label || s.path), 'info');
}

function handleAction(act, node) {
  const ds = node.dataset || {};
  switch (act) {
    case 'refresh': refresh(); break;
    case 'load': actLoad(ds.model, false); break;
    case 'close': actClose(ds.model); break;
    case 'cancel': actCancel(ds.instance); break;
    case 'webui': openWebUI(ds.model, ds.instance); break;
    case 'log': openLogFor(ds); break;
    case 'delete-engine': S.confirmDelete = ds.engine; renderEngines();
      setTimeout(() => { if (S.confirmDelete === ds.engine) { S.confirmDelete = ''; renderEngines(); } }, 6000);
      break;
    case 'delete-engine-no': S.confirmDelete = ''; renderEngines(); break;
    case 'delete-engine-yes': deleteEngine(ds.engine); break;
    case 'delete-model': deleteModelAction(ds.model); break;
    case 'pick': pickPath(ds.target, ds.mode); break;
    case 'reveal': revealPath(ds.path); break;
    case 'reselect-engine': reselectEngine(ds.engine); break;
    case 'cloud-key-save': saveCloudKey(ds.engine); break;
    case 'cloud-key-clear': saveCloudKey(ds.engine, true); break;
    case 'multi-toggle': toggleMulti(ds.engine, ds.model); break;
    case 'multi-clear': multiSelection(ds.engine).clear(); render(); break;
    case 'multi-load': loadMulti(ds.engine, false); break;
    case 'open-import': openImport(); break;
    case 'open-engine': openEngine(); break;
    case 'engine-save': saveEngineForm(); break;
    case 'open-dsh': openDsh(); break;
    case 'cfg-save': saveCfg(false); break;
    case 'cfg-read': void readCfgFromEngine(); break;
    case 'convert-engine': void convertEngineToCustom(ds.engine); break;
    case 'hist-apply': applyHistoryItem(); break;
    case 'hist-rename': void renameHistoryItem(); break;
    case 'cfg-save-restart': saveCfg(true); break;
    case 'vram-force': vramForce(); break;
    case 'inflight-wait': inflightWait(); break;
    case 'inflight-force': inflightForce(); break;
    case 'import-scan': scanImport(); break;
    case 'import-probe': probeDraft(); break;
    case 'import-save': saveImport(); break;
    case 'probe-stop': {
      stopProbe();
      const s = el('probe-status');
      if (s) s.textContent = '已停止（前端只是断开日志流，试启动进程的清理由后端负责）';
      const d = el('probe-dot');
      if (d) d.className = 'dot off';
      break;
    }
    case 'probe-use-port': useManualPort(); break;
    case 'probe-accept': acceptProbe(); break;
    case 'dsh-copy': copyDsh(); break;
    case 'dsh-local': renderLocalDsh(); break;
    default: console.warn('[LACI] 未处理的动作', act);
  }
}

function tick() {
  const now = Date.now();
  for (const node of $$('[data-elapsed]')) {
    const start = Number(node.getAttribute('data-elapsed'));
    if (Number.isFinite(start)) node.textContent = String(Math.max(0, Math.round((now - start) / 1000)));
  }
}

function init() {
  /* 服务端可能晚一步注入 window.__LACI_EMBED__，这里再兜一次 */
  if (window.__LACI_EMBED__ === true) document.body.classList.add('embed');

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', (ev) => {
    /* 选择器开着时，Escape 只关选择器（面板自己的 keydown 已经把事件吃掉了，
       这里兜的是焦点意外落在面板外的情况） */
    if (ev.key === 'Escape' && picker) { closePicker(); return; }
    if (ev.key === 'Escape') closeAllModals();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  const cfgBody = el('cfg-body');
  if (cfgBody) {
    cfgBody.addEventListener('input', schedulePreview);
    cfgBody.addEventListener('change', onCfgChange);
  }
  const importModal = el('m-import');
  if (importModal) importModal.addEventListener('change', onImportChange);

  wirePicker();             /* 页面内文件选择器（不弹原生对话框） */

  /* 接入 DSH：勾"禁用其他工具"时实时补一句 */
  const dshBox = el('dsh-no-tools');
  if (dshBox) dshBox.addEventListener('change', renderDshText);

  /* 导入弹窗：id 自动填，但用户一改就锁住，后面再扫描也不覆盖 */
  for (const [id, key] of [['imp-eng-id', 'eng'], ['imp-model-id', 'model']]) {
    const node = el(id);
    if (node) node.addEventListener('input', () => { impIdTouched[key] = true; });
  }

  render();                 /* 先画空壳，别白屏 */
  refresh();
  setInterval(refresh, POLL_MS);
  setInterval(tick, TICK_MS);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

/* ==========================================================================
   导入引擎（M7 补）：自己下的引擎，手动配槽位
   ========================================================================== */

function openEngine() {
  const set = (id, v) => { const e = el(id); if (e) e.value = v; };
  set('eng-mode', 'custom');
  set('eng-file', '');
  set('eng-label', '');
  set('eng-id', '');
  set('eng-port', '18095');
  set('eng-template', 'single');
  set('eng-interp', '');
  set('eng-argv', '');
  set('eng-env', '');
  set('eng-baseurl', '');
  set('eng-key', '');
  set('eng-keyenv', '');
  set('eng-remote-models', '');
  const warn = el('eng-warn');
  if (warn) { warn.hidden = true; warn.innerHTML = ''; }
  syncEngineTemplateHint();
  syncEngineMode();
  openModal('m-engine');
  /* 新弹窗从「类型」开始，用户第一眼就知道有云端这条路 */
  const mode = el('eng-mode');
  if (mode) { try { mode.focus({ preventScroll: true }); } catch (err) { /* 忽略 */ } }
}

/** 本地 / 云端两套字段互斥：只显示当前类型要填的那些 */
function syncEngineMode() {
  const mode = (el('eng-mode') || {}).value || 'custom';
  const remote = mode === 'remote';
  const local = el('eng-local');
  const cloud = el('eng-remote');
  if (local) local.hidden = remote;
  if (cloud) cloud.hidden = !remote;
  const save = el('eng-warn');
  if (save) { save.hidden = true; save.innerHTML = ''; }
}

function syncEngineTemplateHint() {
  const tpl = (el('eng-template') || {}).value || 'single';
  const hint = el('eng-tpl-hint');
  if (!hint) return;
  hint.textContent = tpl === 'config'
    ? '配置文件方式：启动文件选 server.py，模型槽位选那份 strata-<模型>.json，通道参数由 server.py 自己解析。'
    : tpl === 'strata'
      ? '六槽位：native（主文件）/ ple（第二分片）/ pack（运行时包，文件夹）/ expertProfile / mtp（文件夹）/ tokenizer。后三个可留空。'
      : '单槽位 = 一个模型文件（.ninfer / .gguf / .safetensors）。';
}

function engineSlotsFor(template) {
  if (template === 'config') {
    // Strata 0.2.10 的真实形态：serve/server.py 读一份 config JSON，
    // pack / native / ple / mtp 全在 JSON 里，不是命令行 flag。
    return [{ key: 'config', label: 'Strata 配置文件', kind: 'file' }];
  }
  if (template === 'strata') {
    return [
      { key: 'native', label: '模型主文件', kind: 'file', arg: '--native' },
      { key: 'ple', label: '第二分片', kind: 'file', arg: '--ple-gguf' },
      { key: 'pack', label: '运行时包', kind: 'dir', arg: '--pack', expect: ['dense.bin', 'index.txt'] },
      { key: 'expertProfile', label: '专家档案', kind: 'file', arg: '--expert-profile', optional: true },
      { key: 'mtp', label: 'MTP 目录', kind: 'dir', arg: '--mtp', optional: true },
      { key: 'tokenizer', label: '分词器', kind: 'dir', optional: true }
    ];
  }
  return [{ key: 'model', label: '模型文件', kind: 'file' }];
}

function engineArgvFor(template) {
  if (template === 'config') {
    // 端口由 server.py 监听；engine 参数决定它起哪种引擎
    return ['--engine', 'strata', '--config', '{config}', '--port', '{port}'];
  }
  if (template === 'strata') {
    // 直连 exe：只写它认识的 flag。--host / --port / --model-id 属于
    // "用 server.py 起"的那条路，写在 exe 上会被判 unknown argument。
    return ['--serve', '--max-context', '{maxContext}', '--kv', '{kvDtype}'];
  }
  return ['{model}', '--max-context', '{maxContext}',
    '--host', '{host}', '--port', '{port}', '--model-id', '{modelId}'];
}

/**
 * 云端模型清单：每行 `id` 或 `id, 上下文, 最大输出`。
 * 只在这里做格式解析，合不合法由 registry.validateRemoteEngine 拍板。
 */
function parseRemoteModels(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) continue;
    const parts = raw.split(',').map((x) => x.trim());
    const entry = { id: parts[0] };
    if (parts[1]) entry.contextWindow = Number(parts[1]);
    if (parts[2]) entry.maxTokens = Number(parts[2]);
    out.push(entry);
  }
  return out;
}

async function saveEngineForm() {
  const val = (id) => { const e = el(id); return e ? cleanPathText(e.value) : ''; };
  const warn = el('eng-warn');
  const bad = (msg) => { if (warn) { warn.hidden = false; warn.textContent = msg; } };
  if (warn) { warn.hidden = true; warn.textContent = ''; }

  const mode = val('eng-mode') || 'custom';
  if (mode === 'remote') return saveRemoteEngine(val, warn, bad);

  const file = val('eng-file');
  if (!file) return bad('先填启动文件的完整路径');
  const template = val('eng-template') || 'single';
  const label = val('eng-label') || basename(file);
  const id = val('eng-id') || slug(basenameNoExt(file)) || 'engine';
  const port = Number(val('eng-port')) || 18095;
  if (!(port > 0 && port < 65536)) return bad('端口不在 1–65535');

  const argvText = el('eng-argv') ? String(el('eng-argv').value || '') : '';
  const argv = argvText.trim() ? splitArgs(argvText) : engineArgvFor(template);
  const interpreter = val('eng-interp') || null;
  const kind = /\.(bat|cmd)$/i.test(file) ? 'bat' : (/\.py$/i.test(file) ? 'py' : (/\.ps1$/i.test(file) ? 'ps1' : 'exe'));

  // 环境变量：每行 KEY=VALUE。这里不 cleanPath（值可能是 URL/正则），只去首尾空格。
  const env = {};
  const envNode = el('eng-env');
  if (envNode) {
    for (const line of String(envNode.value || '').split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq <= 0) return bad('环境变量这一行看不懂（要 KEY=VALUE）：' + text);
      env[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
    }
  }

  const engine = {
    id,
    label,
    mode: 'custom',
    kind,
    file,
    cwd: dirname(file),
    interpreter,
    defaultPort: port,
    fileSlots: engineSlotsFor(template),
    argv,
    env: Object.keys(env).length ? env : null,
    webUI: null,
    footprintLog: null,
    ready: null,
    stop: null,
    multiInstance: false,
    why: template === 'config'
      ? '由 serve/server.py 启动（模型参数在 config JSON 里，不在命令行）'
      : ''
  };

  try {
    await api('/engines', { method: 'POST', body: engine });
    closeModal('m-engine');
    toast('引擎已创建：' + label);
    await refresh();
  } catch (err) {
    bad('创建失败：' + (err && err.message ? err.message : err));
  }
}

/**
 * 云端引擎：只存 baseURL / auth / models，key 单独走 /api/secrets。
 *
 * 分两步是故意的 —— 引擎档案要能导出分享，key 绝不能进档案。
 * 先存引擎（拿到校验结果），再存 key：引擎存不下就没必要写 key 了。
 */
async function saveRemoteEngine(val, warn, bad) {
  const baseURL = val('eng-baseurl');
  if (!baseURL) return bad('先填 baseURL，例如 https://api.deepseek.com/v1');

  const models = parseRemoteModels(String((el('eng-remote-models') || {}).value || ''));
  if (!models.length) return bad('至少列一个云端模型 id（每行一个）');
  const badNum = models.find((m) => (m.contextWindow != null && !Number.isFinite(m.contextWindow))
    || (m.maxTokens != null && !Number.isFinite(m.maxTokens)));
  if (badNum) return bad('模型 ' + badNum.id + ' 的上下文/最大输出要写数字');

  const label = val('eng-label') || models[0].id;
  const id = val('eng-id') || slug(label) || slug(models[0].id) || 'cloud';
  const keyEnv = val('eng-keyenv') || null;

  const engine = {
    id,
    label,
    mode: 'remote',
    baseURL,
    /* keyRef 就是引擎 id：secrets.json 里的键 */
    auth: { type: 'bearer', keyRef: id },
    apiKeyEnv: keyEnv,
    models: models.map((m) => {
      const out = { id: m.id };
      if (m.contextWindow != null) out.contextWindow = m.contextWindow;
      if (m.maxTokens != null) out.maxTokens = m.maxTokens;
      return out;
    }),
  };

  const keyText = String((el('eng-key') || {}).value || '').trim();

  try {
    await api('/engines', { method: 'POST', body: engine });
  } catch (err) {
    return bad('创建失败：' + (err && err.message ? err.message : err));
  }

  let keyNote = '';
  if (keyText) {
    try {
      await api('/secrets/' + encodeURIComponent(id), { method: 'POST', body: { key: keyText } });
      keyNote = '，key 已保存';
    } catch (err) {
      /* 引擎已经建好了，这里失败只提示，不回滚 —— 用户重新填一次 key 就行 */
      keyNote = '，但 key 没存上（' + (err && err.message ? err.message : err) + '）';
    }
  } else if (!keyEnv) {
    keyNote = '，还没配 key（调它会 401）';
  }

  closeModal('m-engine');
  toast('云端引擎已创建：' + label + keyNote, keyText || keyEnv ? 'ok' : 'info');
  await refresh();
}

document.addEventListener('change', (e) => {
  if (!e.target) return;
  if (e.target.id === 'eng-template') syncEngineTemplateHint();
  if (e.target.id === 'eng-mode') syncEngineMode();
});
