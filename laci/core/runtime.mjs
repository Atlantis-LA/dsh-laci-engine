/**
 * LACI 新调度中心 · M2 · 实例运行时（runtime.mjs）
 *
 * 一个实例一个 `InstanceRuntime`。它管四件事：
 *   1. 状态机（只有 idle / starting / ready / stopping / error 五个状态）
 *   2. 进程（起、判活、停——全部走 strategies.mjs 的注册表，**不写 if 链**）
 *   3. 日志（每实例一个文件；写不进去不阻塞启动；尾随日志抓显存行喂 M4）
 *   4. 对账（20 秒一次，只改状态、不重启；连续 2 次探活失败才判死）
 *
 * ── 状态机（主文档 §4.2，只有这一张表）────────────────────────────────
 *
 *   idle ──start──→ starting ──ready──→ ready ──stop──→ stopping ──done──→ idle
 *                      │                  │
 *                      └──fail──→ error ←─┘
 *
 *   error 还能 start（重试）或 stop（复位回 idle）。
 *
 * ── 外部只发事件，不许直接改 phase ──────────────────────────────────
 *
 *   rt.dispatch('started')       idle      → starting
 *   rt.dispatch('probe-ok')      starting  → ready
 *   rt.dispatch('probe-timeout') starting  → error        （fail 是同义事件）
 *   rt.dispatch('stop-requested')starting/ready → stopping；error → idle
 *   rt.dispatch('process-exit')  starting/ready → error；stopping → idle
 *   rt.dispatch('stop-done')     stopping  → idle          （内部兜底用）
 *
 *   `rt.phase = 'ready'` 会直接抛 TypeError —— 这一条能消灭一半竞态。
 *
 * ── 与 M1 / M4 的边界 ─────────────────────────────────────────────
 *
 *   本文件**不直接读写 data/*.json**，也**不算显存**。
 *   M1（registry.mjs）和 M4（ledger.mjs）用「懒加载 + 能力探测」的方式接：
 *     - 拿得到：用它解析 engine/model、落 instances.json、抢租约
 *     - 拿不到（还没写完）：降级，不阻塞状态机与进程管理
 *   这样 M1/M4 没落地时 M2 也能单独跑、单独测。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  DEFAULT_LAUNCHER,
  DEFAULT_PROBER,
  DEFAULT_STOPPER,
  StrategyNotRegisteredError,
  isPidAlive,
  launchers as defaultLaunchers,
  probers as defaultProbers,
  stoppers as defaultStoppers,
  waitForPortClosed,
} from './strategies.mjs';
// 日志目录必须和 data/ 用同一个根（LACI_HOME 能整体搬走数据目录）。
// config.mjs 不 import 任何本地模块，不会形成环；M2 本来就依赖 M1。
import { logsDir, homeDir } from './config.mjs';

/* ==========================================================================
 * 错误
 * ========================================================================== */

/** 运行时错误基类：调用方（M6）直接读 `.message` 回 400/503 */
export class RuntimeError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'RuntimeError';
    this.detail = options.detail ?? null;
  }
}

/** 模板变量缺失：启动前就要拦住，别起一个缺参数的进程再等 300 秒（§5.7.3） */
export class MissingVariablesError extends RuntimeError {
  constructor(missing, where = '') {
    super(`模板变量缺失：${missing.map((k) => `{${k}}`).join('、')}${where ? `（${where}）` : ''}`, {
      detail: { missing, where },
    });
    this.name = 'MissingVariablesError';
    this.missing = missing;
    this.where = where;
  }
}

/** 有 arg 的槽位被写进了模板：D2 里这是硬错误（会拼出两份参数） */
export class ForbiddenSlotVariableError extends RuntimeError {
  constructor(items, where = '') {
    const text = items.map((it) => it.message ?? `「{${it.key}}」是自动拼的，模板里删掉它`).join('；');
    super(`${text}${where ? `（${where}）` : ''}`, { detail: { items, where } });
    this.name = 'ForbiddenSlotVariableError';
    this.items = items;
  }
}

/** 必填槽位没有值：也说清楚是哪几个（用 label，不用 key） */
export class MissingSlotError extends RuntimeError {
  constructor(slots, where = '') {
    const labels = slots.map((s) => s.label ?? s.key ?? '（未命名槽位）');
    super(`缺少必需的槽位：${labels.join('、')}${where ? `（${where}）` : ''}`, {
      detail: { slots: slots.map((s) => s.key), where },
    });
    this.name = 'MissingSlotError';
    this.slots = slots.map((s) => s.key);
  }
}

export class UnknownModeError extends RuntimeError {
  constructor(mode, available) {
    super(`不认识的启动方式 mode=${mode}（支持：${available.join(' / ')}）`, { detail: { mode, available } });
    this.name = 'UnknownModeError';
  }
}

/* ==========================================================================
 * 状态机（唯一的一张表）
 * ========================================================================== */

export const PHASES = Object.freeze(['idle', 'starting', 'ready', 'stopping', 'error']);

/** 主文档 §4.2 原表，一个字都不加 */
export const TRANSITIONS = Object.freeze({
  idle: Object.freeze({ start: 'starting' }),
  starting: Object.freeze({ ready: 'ready', fail: 'error', stop: 'stopping' }),
  ready: Object.freeze({ stop: 'stopping', fail: 'error' }),
  stopping: Object.freeze({ done: 'idle' }),
  error: Object.freeze({ start: 'starting', stop: 'idle' }),
});

/** 外部事件 → 内部转移名。表驱动，避免 if (event === …) 链 */
const EVENT_TRANSITION = Object.freeze({
  started: 'start',
  'probe-ok': 'ready',
  'probe-timeout': 'fail',
  'probe-failed': 'fail', // 别名，读起来更顺
  fail: 'fail',
  'stop-requested': 'stop',
  'stop-done': 'done',
});

/** process-exit 的转移要看当前阶段：起/跑时算失败，停的时候算正常结束 */
const PROCESS_EXIT_TRANSITION = Object.freeze({
  starting: 'fail',
  ready: 'fail',
  stopping: 'done',
});

/** 进入某状态时顺手做的事（只碰时间戳/错误文本，不碰进程） */
const ON_ENTER = Object.freeze({
  starting: (rt, change) => {
    rt.startedAt = change.at;
    rt.readyAt = null;
    rt.stoppingAt = null;
    rt.stoppedAt = null;
    rt.error = null;
  },
  ready: (rt, change) => {
    rt.readyAt = change.at;
    rt.probe.failures = 0;
  },
  stopping: (rt) => {
    rt.stoppingAt = Date.now();
  },
  idle: (rt, change) => {
    rt.stoppedAt = change.at;
    rt.readyAt = null;
    rt.stoppingAt = null;
  },
  error: (rt, change) => {
    if (!rt.error) rt.error = change.detail?.error ?? '未知错误';
  },
});

/* ==========================================================================
 * 事件发射器（零依赖；订阅者抛错不许影响运行时本身）
 * ========================================================================== */

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (typeof handler !== 'function') throw new TypeError(`on(${event}) 需要函数`);
    let set = this._handlers.get(event);
    if (!set) {
      set = new Set();
      this._handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once(event, handler) {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (!set) return false;
    const removed = set.delete(handler);
    if (set.size === 0) this._handlers.delete(event);
    return removed;
  }

  removeAllListeners(event) {
    if (event === undefined) this._handlers.clear();
    else this._handlers.delete(event);
  }

  listenerCount(event) {
    return this._handlers.get(event)?.size ?? 0;
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return false;
    // 复制一份再遍历：订阅者在回调里 off 自己不会打乱本次派发
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        // 订阅者（界面/日志）出错是它自己的问题，不能反过来把实例搞崩。
        // 这里故意不 console.error：运行时不接管控制台输出。
      }
    }
    return true;
  }
}

/* ==========================================================================
 * 变量与命令行拼接（主文档 §5.2 / D2）
 * ========================================================================== */

const VAR_PATTERN = /\{([A-Za-z0-9_.-]+)\}/g;
const SLOTS_OF = new WeakMap();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeModels(models) {
  if (Array.isArray(models)) return models.filter((m) => m && typeof m === 'object');
  if (models && typeof models === 'object') return [models];
  return [];
}

function slotsOf(engine) {
  if (!engine || typeof engine !== 'object') return [];
  const cached = SLOTS_OF.get(engine);
  if (cached) return cached;
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots.filter((s) => s && s.key) : [];
  SLOTS_OF.set(engine, slots);
  return slots;
}

/** 模型给某个槽位填的值；没有就是空串（不是 undefined，方便区分「没填」和「填了空」） */
export function slotValue(model, key) {
  const files = model?.files;
  if (!isPlainObject(files)) return '';
  const value = files[key];
  return value === undefined || value === null ? '' : String(value);
}

/** 槽位所在目录：dir 槽位就是它自己，file 槽位取父目录 */
function slotDir(slot, value) {
  const text = String(value ?? '');
  if (!text) return '';
  return slot.kind === 'dir' ? text : path.dirname(text);
}

/**
 * 铺模板变量。优先级：系统变量 > 槽位变量 > params。
 *
 * 关键规则（D2）：**有 `arg` 的槽位不进变量表**。它由系统拼 `--arg 值`，
 * 模板里再写一次就会拼出两份参数，所以这里故意不提供、并让渲染时报错。
 */
export function buildVariables(engine, models, { port, host = '127.0.0.1' } = {}) {
  const list = normalizeModels(models);
  const primary = list[0] ?? null;
  const params = isPlainObject(primary?.params) ? primary.params : {};
  // null 原型：params 里写 __proto__ 也污染不了
  const vars = Object.create(null);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    vars[key] = value;
  }

  vars.host = host || '127.0.0.1';
  // 没有端口时故意不给 {port}，让模板渲染报「缺 {port}」，而不是拼出 "http://127.0.0.1:/"
  const effectivePort = port ?? primary?.port ?? engine?.defaultPort ?? null;
  if (Number(effectivePort) > 0) {
    vars.port = effectivePort;
  }

  const modelId = primary?.engineModelId || primary?.id;
  if (modelId) vars.modelId = modelId;

  /**
   * 思考参数（§5.3：思考是**模型级**的，启动时翻译成引擎 flag）。
   *
   * 故意给空串而不是 undefined：渲染时空串会被 dropEmptyPairs 连同前面的
   * `--default-reasoning-effort` 一起丢掉 —— 这正是「null = 不干预」的语义。
   */
  const thinking = isPlainObject(primary?.thinking) ? primary.thinking : {};
  vars.thinkingEffort = thinking.effort == null ? '' : String(thinking.effort);
  vars.thinkingBudget = thinking.budget == null ? '' : String(thinking.budget);

  const engineDir = engine?.file ? path.dirname(String(engine.file)) : (engine?.cwd ?? '');
  if (engineDir) vars.engineDir = engineDir;

  for (const slot of slotsOf(engine)) {
    const value = slotValue(primary, slot.key);
    vars[`${slot.key}Dir`] = value ? slotDir(slot, value) : '';
    if (slot.arg) continue; // 有 arg：系统拼，模板里出现即报错
    vars[slot.key] = value; // 无 arg：必须在模板里出现一次（D2）
  }

  return vars;
}

/** 取值：先看平铺变量，再支持显式写法 {params.maxContext} */
function lookupVar(variables, key) {
  if (hasOwn(variables, key)) return variables[key];
  if (key.startsWith('params.')) {
    const flat = key.slice('params.'.length);
    if (hasOwn(variables, flat)) return variables[flat];
  }
  return undefined;
}

/**
 * 渲染一个字符串模板。
 * `forbidden` 是 Map<槽位key, 报错文案>，用来给「有 arg 的槽位写进模板」一个专门的错。
 */
export function renderTemplate(text, variables, { where = '模板', forbidden = null } = {}) {
  const source = String(text ?? '');
  if (!source.includes('{')) return source;

  const missing = new Set();
  const forbiddenUsed = new Set();
  const output = source.replace(VAR_PATTERN, (whole, rawKey) => {
    const key = String(rawKey);
    const value = lookupVar(variables, key);
    if (value !== undefined && value !== null) return String(value);
    if (forbidden && forbidden.has(key)) {
      forbiddenUsed.add(key);
      return whole;
    }
    missing.add(key);
    return whole;
  });

  if (forbiddenUsed.size > 0) {
    throw new ForbiddenSlotVariableError(
      [...forbiddenUsed].map((key) => ({ key, message: forbidden.get(key) })),
      where,
    );
  }
  if (missing.size > 0) throw new MissingVariablesError([...missing], where);
  return output;
}

/** 渲染 env：值里可以写 {port} 这类变量；非字符串原样保留 */
export function renderEnv(env, variables, { where = 'engine.env', strict = true, warnings = null } = {}) {
  if (!isPlainObject(env)) return {};
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') {
      out[key] = value === undefined || value === null ? '' : String(value);
      continue;
    }
    if (!value.includes('{')) {
      out[key] = value;
      continue;
    }
    try {
      out[key] = renderTemplate(value, variables, { where: `${where}.${key}` });
    } catch (err) {
      if (strict) throw err;
      warnings?.push(`${where}.${key} 的变量没解析：${err.message}`);
      out[key] = value;
    }
  }
  return out;
}

/**
 * 空值清理：模板里某个可选槽位渲染成空串时，把 **它和紧挨着的前一个 flag** 一起丢掉。
 * 和「有 arg 的槽位值为空就整对跳过」是同一条规则，只是发生在模板侧。
 */
export function dropEmptyPairs(tokens) {
  const out = [];
  for (const raw of tokens) {
    const token = raw === undefined || raw === null ? '' : String(raw);
    if (token !== '') {
      out.push(token);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.startsWith('-')) out.pop();
  }
  return out;
}

function quoteForDisplay(value) {
  const text = String(value ?? '');
  if (text === '') return '""';
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function makeDisplay(program, args) {
  return [program, ...args].map(quoteForDisplay).join(' ');
}

/** package：**原样执行** file，不加任何参数（整合包走这条） */
function buildPackageCommand({ engine, variables }) {
  if (!engine.file) throw new RuntimeError(`引擎 ${engine.id ?? '?'} 没有 file，无法原样执行`);
  const warnings = [];
  const cwd = engine.cwd || path.dirname(String(engine.file));
  const env = renderEnv(engine.env, variables, { strict: false, warnings });
  return {
    mode: 'package',
    engineId: engine.id ?? null,
    program: String(engine.file),
    args: [],
    cwd,
    env,
    display: makeDisplay(String(engine.file), []),
    warnings,
    variables,
    modelId: null,
  };
}

/**
 * custom：先拼有 `arg` 的槽位（值为空整对跳过），再渲染 argv 模板。
 *
 * 顺序是有讲究的：槽位对在前、模板在后。模板里的参数顺序由用户控制，
 * 槽位是「系统灌进去的模型路径」，放前面既能被引擎按 flag 解析，也不会打乱模板语义。
 */
function buildCustomCommand({ engine, models, primary, variables, options = {} }) {
  if (!engine.file) throw new RuntimeError(`引擎 ${engine.id ?? '?'} 没有 file，无法启动`);
  const slots = slotsOf(engine);
  const args = [];
  const warnings = [];

  // ① 有 arg 的槽位：`--native <路径>`；值为空 → 整对跳过（**不能**给空串）
  for (const slot of slots) {
    const value = slotValue(primary, slot.key);
    if (!value) {
      if (!slot.optional) throw new MissingSlotError([slot], 'custom 模式启动前校验');
      continue; // 可选槽位没填：连 flag 一起消失
    }
    if (slot.arg) args.push(String(slot.arg), value);
  }

  // ② 多模型实例：单槽位引擎把各模型主文件拼成 `--models a.gguf,b.gguf`（D1 / §5.9.1）
  if (models.length > 1) {
    if (engine.modelsArg) {
      const mainSlot = slots.find((s) => !s.arg);
      const files = models.map((m) => (mainSlot ? slotValue(m, mainSlot.key) : '')).filter(Boolean);
      if (files.length !== models.length) {
        warnings.push(
          `多模型实例要求每个模型都有「${mainSlot?.label ?? mainSlot?.key ?? 'model'}」槽位，缺值的模型已被跳过`,
        );
      }
      if (files.length > 0) args.push(String(engine.modelsArg), files.join(','));
    } else {
      warnings.push('一个实例带了多个模型，但引擎没有声明 modelsArg：只有第一个模型会进命令行');
    }
  }

  // ③ 渲染 argv 模板。有 arg 的槽位名在模板里出现 → 专门报错
  const forbidden = new Map(
    slots
      .filter((s) => s.arg)
      .map((s) => [s.key, `「{${s.key}}」是自动拼的（${s.arg}），模板里删掉它`]),
  );
  const template = Array.isArray(engine.argv) ? engine.argv : [];
  const renderedTemplate = template.map((token) =>
    renderTemplate(token, variables, { where: 'engine.argv', forbidden }),
  );

  args.push(...dropEmptyPairs(renderedTemplate));

  // 多模型 + 模板里还写着单模型槽位 → 命令行会出现两份主文件，明确提醒
  if (models.length > 1 && engine.modelsArg) {
    for (const slot of slots.filter((s) => !s.arg)) {
      const used = template.some((token) => String(token).includes(`{${slot.key}}`));
      if (used) {
        warnings.push(
          `多模型实例的模板仍然引用 {${slot.key}}，命令行里会多出一份模型路径；多模型引擎应该只靠 ${engine.modelsArg} 传模型`,
        );
      }
    }
  }

  // ④ 能力开关 → 命令行（§5.6.1 的「视觉 / 投机解码」复选框）
  //
  // 为什么需要一段专门逻辑：模板是静态字符串，而"开不开视觉/投机"是**模型**上的
  // 布尔值，只有引擎知道"开了该拼哪些 flag"。所以引擎声明 capabilityArgs，
  // 模型只负责说 true/false。
  //
  // 兼容旧数据：如果模型 extraArgs 里已经手写了同一个 flag（例如 q3.8 的
  // --vision），这里就跳过整块，避免同一个参数拼两遍。
  const extraArgs = Array.isArray(primary?.extraArgs)
    ? primary.extraArgs.filter((x) => x != null && String(x) !== '').map(String)
    : [];
  const capabilityArgs = isPlainObject(engine.capabilityArgs) ? engine.capabilityArgs : {};
  for (const [capability, template] of Object.entries(capabilityArgs)) {
    if (primary?.params?.[capability] !== true) continue; // 只有显式 true 才加
    if (!Array.isArray(template) || template.length === 0) continue;

    const tokens = template.map((token) =>
      renderTemplate(token, variables, { where: `engine.capabilityArgs.${capability}` }),
    );
    const flag = tokens.map(String).find((t) => t.startsWith('-'));
    if (flag && extraArgs.includes(flag)) {
      warnings.push(
        `「${capability}」的 ${flag} 已经在模型的额外参数里写死了：按额外参数走，开关只影响其它模型`,
      );
      continue;
    }
    args.push(...dropEmptyPairs(tokens));
  }

  // ⑤ 每个实例一个 device-profile（§5.9.2 第 3 条）
  //
  // 引擎第一次启动会校准显卡，结果写进 device-profiles.json。同一个引擎起两个实例时
  // 两个进程会同时写同一个文件（ninfer README §10 第 10 条）。所以按实例给一个路径。
  if (typeof engine.deviceProfileArg === 'string' && engine.deviceProfileArg.trim() !== ''
    && options.instanceId) {
    const dir = path.join(homeDir(), 'device-profiles');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不了目录就让引擎用自己的默认路径，别因此起不来 */
    }
    args.push(String(engine.deviceProfileArg).trim(), path.join(dir, `${safeFileName(options.instanceId)}.json`));
  }

  // ⑥ 模型级额外参数（界面里的「额外参数」）原样追加，不做变量替换
  for (const extra of extraArgs) args.push(extra);
  const cwd = engine.cwd || path.dirname(String(engine.file));
  const env = renderEnv(engine.env, variables, { strict: true });

  return {
    mode: 'custom',
    engineId: engine.id ?? null,
    program: String(engine.file),
    args,
    cwd,
    env,
    display: makeDisplay(String(engine.file), args),
    warnings,
    variables,
    modelId: primary?.engineModelId || primary?.id || null,
  };
}

const COMMAND_BUILDERS = Object.freeze({
  package: buildPackageCommand,
  custom: buildCustomCommand,
  // 云端不归 M2 管：明确抛错，好过静默当成 custom 去拼
  remote: () => {
    throw new RuntimeError('remote（云端）模式不走本地进程：由网关直连 baseURL，M2 不启动它');
  },
});

/**
 * 生成启动计划（纯函数，不碰进程，方便界面预览「最终命令」）。
 * @returns {{ mode, program, args, cwd, env, display, warnings, variables, modelId, engineId }}
 */
export function buildCommand(engine, models, options = {}) {
  if (!engine || typeof engine !== 'object') {
    throw new RuntimeError('buildCommand 需要一个 engine 对象（不能只给 id）');
  }
  const mode = engine.mode ?? 'custom';
  const builder = COMMAND_BUILDERS[mode];
  if (typeof builder !== 'function') throw new UnknownModeError(mode, Object.keys(COMMAND_BUILDERS));

  const list = normalizeModels(models);
  const variables = buildVariables(engine, list, options);
  const plan = builder({ engine, models: list, primary: list[0] ?? null, variables, options });

  return { ...plan, variables };
}

/** 判活地址渲染（engine.ready.url 里的 {port} {host}） */
export function renderReadyUrl(engine, variables) {
  const raw = engine?.ready?.url;
  if (!raw) return null;
  return renderTemplate(raw, variables, { where: 'engine.ready.url' });
}

/* ==========================================================================
 * 日志
 * ========================================================================== */

const FOOTPRINT_WINDOW = 8192;
const LOG_ROTATE_BYTES = 8 * 1024 * 1024;

/**
 * 「引擎要多少运行时预留」的**廉价预筛**：只判断这一行值不值得往下传，不抓数字。
 * 真正的解析只在 footprint.mjs 的 RESERVE_LOG_RE（一个来源，别在这里抄第二遍）。
 */
const RESERVE_LINE_HINT = /runtime\s+reservation\s+requires/i;

/**
 * 日志目录：**必须跟 data/ 同一个根**（LACI_HOME）。
 *
 * 这里以前自己拼 `os.homedir()/.dsh/laci-new/logs`，结果是设了 LACI_HOME 之后
 * data 搬走了、日志还留在用户目录 —— 排查时两边对不上（交接里的 P1）。
 * 现在统一走 config.logsDir()。
 */
function defaultLogDir() {
  return logsDir();
}

function safeFileName(name) {
  return String(name ?? 'instance').replace(/[^\w.-]+/g, '_');
}

/** 本地时间 `YYYY-MM-DD HH:MM:SS`。日志要和人看到的引擎输出对得上，不能用 UTC。 */
function stamp(date = new Date()) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function rotateIfBig(file, limit = LOG_ROTATE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > limit) fs.renameSync(file, `${file}.1`);
  } catch {
    // 文件不存在 / 改名失败都无所谓：日志是次要功能
  }
}

function compileFootprint(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  try {
    // 's' 让 .*? 能跨行：有的引擎把「KV 池」和「runtime」分两行打
    return new RegExp(pattern, 's');
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}

/**
 * 实例日志。
 *
 * 三条硬规则：
 *   - `open()` 永远不抛：写不进去就标 warning，**引擎照常启动**（§5.7.8）
 *   - 只保留最近 N 行在内存里（给界面尾随），同时整份写文件
 *   - 命中 `engine.footprintLog` 就发 `footprint` 事件，喂给 M4 回填实测显存
 */
export class InstanceLog extends Emitter {
  constructor({ file, engine = null, ownerId = null, maxLines = 300 } = {}) {
    super();
    this.file = file ?? null;
    this.engine = engine;
    this.ownerId = ownerId;
    this.maxLines = maxLines;
    this.lines = [];
    this.bytes = 0;
    this.droppedBytes = 0;
    this.writable = false;
    this.error = null;
    this.fd = null;
    this._buffers = new Map();
    this._window = '';
    this._lastFootprint = null;
    this._lastReserveLine = null;
    this._footprintRe = compileFootprint(engine?.footprintLog);
    this._footprintBroken = Boolean(engine?.footprintLog) && !this._footprintRe;
    this._footprintWarned = false;
  }

  /** 打开日志文件（试写一行表头即视为可写）。失败只标警告，不抛 */
  open() {
    if (this.fd !== null) return true;
    if (this._footprintBroken && !this._footprintWarned) {
      // 正则坏掉不影响启动，只是抓不到实测显存；同一个实例只提醒一次
      this._footprintWarned = true;
      this.emit('warning', {
        message: '引擎的 footprintLog 正则不合法，实测显存抓不到（退回公式估算）',
      });
    }
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      rotateIfBig(this.file);
      this.fd = fs.openSync(this.file, 'a');
      // 试写一行：目录只读 / 磁盘满在这一步就会暴露，而不是等到引擎跑起来
      fs.writeSync(this.fd, `\n[${stamp()}] --- LACI 实例 ${this.ownerId ?? ''} 日志开始 ---\n`);
      this.writable = true;
      this.error = null;
      return true;
    } catch (err) {
      this.fd = null;
      this.writable = false;
      this.error = err;
      this.emit('warning', {
        message: `日志写不进去（${this.file}）：${err.message}；引擎照常启动，只是没有日志文件`,
        error: err,
      });
      return false;
    }
  }

  /** 写原始输出并拆行。**永远不抛** */
  write(chunk, stream = 'stdout') {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '');
    if (text === '') return;

    if (this.fd !== null) {
      try {
        // 用同步写：引擎输出要按顺序落盘，异步写同一个 fd 在大流量下可能错序。
        // 本地单实例的日志量不值得为它引入写队列。
        fs.writeSync(this.fd, text);
        this.bytes += Buffer.byteLength(text);
      } catch (err) {
        this.writable = false;
        this.error = err;
        this.droppedBytes += Buffer.byteLength(text);
        try {
          fs.closeSync(this.fd);
        } catch {
          /* 已经坏了，关不掉也认 */
        }
        this.fd = null;
        this.emit('warning', {
          message: `写日志失败（${this.file}）：${err.message}；引擎不受影响，后续日志丢弃`,
          error: err,
        });
      }
    } else {
      this.droppedBytes += Buffer.byteLength(text);
    }

    // 拆行：stdout / stderr 各自留半行缓冲，避免两路输出串成一行
    const buffer = (this._buffers.get(stream) ?? '') + text;
    const parts = buffer.split(/\r?\n/);
    const tail = parts.pop() ?? '';
    this._buffers.set(stream, tail.length > FOOTPRINT_WINDOW ? tail.slice(-FOOTPRINT_WINDOW) : tail);
    for (const line of parts) this._emitLine(line, stream);
  }

  /** LACI 自己写一行（启动、对账、外部变更） */
  note(text) {
    this.write(`[laci ${stamp()}] ${text}\n`, 'laci');
  }

  /** 把半行缓冲冲出来（进程退出时调用） */
  flush() {
    for (const [stream, tail] of this._buffers) {
      if (tail) this._emitLine(tail, stream);
    }
    this._buffers.clear();
  }

  close() {
    this.flush();
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* 关闭失败没什么可做的 */
      }
      this.fd = null;
    }
  }

  describe() {
    return {
      file: this.file,
      writable: this.writable,
      bytes: this.bytes,
      droppedBytes: this.droppedBytes,
      lines: this.lines.length,
      error: this.error ? String(this.error.message ?? this.error) : null,
    };
  }

  _emitLine(line, stream) {
    const text = line ?? '';
    this.lines.push(text);
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
    this.emit('line', { line: text, stream, at: Date.now(), instanceId: this.ownerId });
    this._scanFootprint(text);
  }

  _scanFootprint(line) {
    // ① 引擎告诉你"还要多少运行时预留"的那一行（失败日志里才有）。
    //    这里只做廉价预筛，**不解析**：解析规则只放 footprint.mjs 一处，
    //    由 RuntimeManager 拿到原始行后调 parseFootprintLine()。
    if (RESERVE_LINE_HINT.test(line) && line !== this._lastReserveLine) {
      this._lastReserveLine = line;
      this.emit('reservation-line', {
        instanceId: this.ownerId,
        at: Date.now(),
        line: line.slice(0, 2000),
      });
    }

    // ② 正常的 capacity 行（KV 池 / runtime 实测）。
    if (!this._footprintRe) return;
    this._window = `${this._window}\n${line}`.slice(-FOOTPRINT_WINDOW);
    const match = this._footprintRe.exec(this._window);
    if (!match) return;
    const key = match[0];
    if (key === this._lastFootprint) return; // 同一行被窗口反复匹配，只报一次
    this._lastFootprint = key;
    this._window = ''; // 命中后清窗，避免下一行重复命中
    const kvTokens = match[1] !== undefined ? Number(String(match[1]).replace(/[,\s]/g, '')) : null;
    const runtimeMiB = match[2] !== undefined ? Number(String(match[2]).replace(/,/g, '')) : null;
    this.emit('footprint', {
      instanceId: this.ownerId,
      at: Date.now(),
      kvTokens: Number.isFinite(kvTokens) ? kvTokens : null,
      runtimeMiB: Number.isFinite(runtimeMiB) ? runtimeMiB : null,
      match: key.slice(0, 500),
    });
  }
}

/* ==========================================================================
 * 策略 key 解析（表驱动，不是 if 链）
 * ========================================================================== */

const LAUNCHER_BY_MODE = Object.freeze({
  package: 'spawn',
  custom: 'spawn',
  remote: 'attach', // 将来由 attach 策略接管；现在没注册，会报「没有注册 attach 策略」
});

export function resolveLauncherKey(engine) {
  const declared = typeof engine?.launcher === 'string' ? engine.launcher.trim() : '';
  if (declared) return declared;
  return LAUNCHER_BY_MODE[engine?.mode ?? 'custom'] ?? DEFAULT_LAUNCHER;
}

export function resolveProberKey(engine) {
  const declared = typeof engine?.ready?.type === 'string' ? engine.ready.type.trim() : '';
  return declared || DEFAULT_PROBER;
}

export function resolveStopperKey(engine) {
  const declared = typeof engine?.stop?.method === 'string' ? engine.stop.method.trim() : '';
  return declared || DEFAULT_STOPPER;
}

/* ==========================================================================
 * 只读工具
 * ========================================================================== */

function sleepSafe(ms, signal) {
  if (!(ms > 0)) return Promise.resolve(true);
  return delay(ms, undefined, { signal })
    .then(() => true)
    .catch(() => false);
}

function makeInstanceId() {
  return `inst-${crypto.randomBytes(2).toString('hex')}`;
}

function engineModelIdOf(model) {
  return model?.engineModelId || model?.id || '';
}

/* ==========================================================================
 * InstanceRuntime
 * ========================================================================== */

export class InstanceRuntime extends Emitter {
  /**
   * @param {object} options
   * @param {string} [options.id]          实例 id（不传就生成 inst-xxxx）
   * @param {object} options.engine        引擎定义（M1 的 engine 对象，必须有 id）
   * @param {object[]} [options.models]    这个实例承载的模型（第一个是主模型）
   * @param {number} [options.port]        实例真实端口（M4 分配好传进来）
   * @param {string} [options.host]        判活/绑定用的 host，默认 127.0.0.1
   * @param {string} [options.phase]       仅用于「重启 LACI 后从 instances.json 认回来」
   * @param {number|null} [options.pid]    同上
   * @param {object|null} [options.lease]  账本租约；stop/崩溃时由本实例负责释放
   */
  constructor(options = {}) {
    super();
    const {
      id,
      engine,
      models = [],
      port = null,
      host = '127.0.0.1',
      phase = 'idle',
      pid = null,
      startedAt = null,
      readyAt = null,
      ephemeral = false,
      lease = null,
      logDir,
      logFile,
      launchers = defaultLaunchers,
      probers = defaultProbers,
      stoppers = defaultStoppers,
    } = options;

    if (!engine || typeof engine !== 'object' || !engine.id) {
      throw new TypeError('InstanceRuntime 需要 engine 对象（至少有 id）');
    }
    if (!PHASES.includes(phase)) {
      throw new TypeError(`InstanceRuntime 的初始 phase 只能是 ${PHASES.join(' / ')}，收到 ${phase}`);
    }

    this.id = id ?? makeInstanceId();
    this.engine = engine;
    this.engineId = engine.id;
    this.engineLabel = engine.label ?? engine.id;
    this.models = normalizeModels(models);
    this._modelIds = this.models.map((m) => m.id).filter(Boolean);
    this.port = port ?? this.models[0]?.port ?? engine.defaultPort ?? null;
    this.host = host || '127.0.0.1';
    this.ephemeral = Boolean(ephemeral);
    this.lease = lease ?? null;

    this.startedAt = startedAt ?? null;
    this.readyAt = readyAt ?? null;
    this.stoppingAt = null;
    this.stoppedAt = null;
    this.error = null;
    this.warnings = [];
    this.lastExit = null;
    this.lastStop = null;
    this.footprint = null;
    this.runtimeReserveMib = null; // 引擎自己报的运行时预留（M4 会回填到模型档案）
    this.reportedModelIds = null;
    this.launch = null;
    this.probe = { lastAt: null, ok: null, failures: 0, lastError: null, models: null, attempts: 0, url: null };

    this._phase = phase;
    this.pid = pid ?? null;
    this._child = null;
    this._childToken = null;
    this._childExited = false;
    this._detached = false;
    this._startPromise = null;
    this._stopPromise = null;
    this._abort = null;
    this._plan = null;

    this._launchers = launchers;
    this._probers = probers;
    this._stoppers = stoppers;

    this.log = new InstanceLog({
      file: logFile ?? path.join(logDir ?? defaultLogDir(), `${safeFileName(this.id)}.log`),
      engine,
      ownerId: this.id,
    });
    this._wireLog();
  }

  /* ---------- 只读属性 ---------- */

  /** 当前状态。**只读**：改它请用 dispatch('事件') */
  get phase() {
    return this._phase;
  }

  /** 外部直接赋值 = 绕开状态机，直接拦下来 */
  set phase(_value) {
    throw new TypeError(
      `不许直接改 phase（实例 ${this.id}）：外部只发事件，请用 rt.dispatch('started' | 'probe-ok' | ...)`,
    );
  }

  get modelIds() {
    return [...this._modelIds];
  }

  /* ---------- 状态机 ---------- */

  /**
   * 唯一的改状态入口。非法事件不抛错（回调里炸掉更难查），返回 false 并留痕。
   * @returns {boolean} 有没有真的发生转移
   */
  dispatch(event, detail = {}) {
    const from = this._phase;
    const transition = event === 'process-exit'
      ? (PROCESS_EXIT_TRANSITION[from] ?? null)
      : (EVENT_TRANSITION[event] ?? null);
    const to = transition ? TRANSITIONS[from]?.[transition] : undefined;

    if (!to) {
      this.emit('transition-rejected', { instanceId: this.id, from, event, detail, at: Date.now() });
      return false;
    }

    this._phase = to;
    const change = { instanceId: this.id, from, to, event, transition, detail, at: Date.now() };
    ON_ENTER[to]?.(this, change);
    this.emit('phase', change);
    return true;
  }

  /* ---------- 命令行 ---------- */

  /** 生成启动计划（不影响当前进程，界面可直接用来预览） */
  buildPlan(models = this.models) {
    const plan = buildCommand(this.engine, models, {
      port: this.port,
      host: this.host,
      instanceId: this.id,
    });
    this._plan = plan;
    return plan;
  }

  /** 判活地址（渲染 {port}/{host}） */
  readyUrl(plan = this._plan) {
    const variables = plan?.variables ?? buildVariables(this.engine, this.models, { port: this.port, host: this.host });
    return renderReadyUrl(this.engine, variables);
  }

  /** 给界面/M3 的「最终命令」预览：不回写内部状态 */
  preview(models = this.models) {
    const plan = buildCommand(this.engine, models, {
      port: this.port,
      host: this.host,
      instanceId: this.id,
    });
    let readyUrl = null;
    let readyError = null;
    try {
      readyUrl = renderReadyUrl(this.engine, plan.variables);
    } catch (err) {
      readyError = err.message;
    }
    return { ...plan, readyUrl, readyError, phase: this._phase };
  }

  /** 换模型（外部对账修正后由编排层调；下一次启动才生效） */
  updateModels(models) {
    this.models = normalizeModels(models);
    this._modelIds = this.models.map((m) => m.id).filter(Boolean);
    this._plan = null;
    return this;
  }

  /* ---------- 快照 ---------- */

  /** JSON 安全的状态快照（M6 直接塞进 /api/state） */
  status() {
    const now = Date.now();
    return {
      id: this.id,
      engineId: this.engineId,
      engineLabel: this.engineLabel,
      modelIds: this.modelIds,
      port: this.port,
      host: this.host,
      pid: this.pid,
      phase: this._phase,
      ephemeral: this.ephemeral,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppingAt: this.stoppingAt,
      stoppedAt: this.stoppedAt,
      uptimeMs: this._phase === 'ready' && this.startedAt ? now - this.startedAt : null,
      error: this.error,
      warnings: [...this.warnings],
      launch: this.launch ? { ...this.launch, args: [...(this.launch.args ?? [])] } : null,
      log: this.log.describe(),
      // 界面要的两样（以前只有 log.describe()，前端拿不到可显示的内容）：
      //   logTail   最后一行日志（加载中/出错时那一行往往就是答案）
      //   poolTokens 引擎报的 KV 池大小（"池 34,560"）
      logTail: this.log.lines.length > 0 ? this.log.lines[this.log.lines.length - 1] : null,
      poolTokens:
        Number.isFinite(Number(this.footprint?.kvTokens)) && Number(this.footprint.kvTokens) > 0
          ? Number(this.footprint.kvTokens)
          : null,
      runtimeReserveMib: this.runtimeReserveMib,
      probe: { ...this.probe },
      reportedModelIds: this.reportedModelIds ? [...this.reportedModelIds] : null,
      footprint: this.footprint ? { ...this.footprint } : null,
      lastExit: this.lastExit ? { ...this.lastExit } : null,
      lastStop: this.lastStop ? { ...this.lastStop } : null,
      updatedAt: now,
    };
  }

  toJSON() {
    return this.status();
  }

  /* ---------- 启动 ---------- */

  /**
   * 启动：idle/error → starting → (判活) → ready / error。
   *
   * 幂等：ready 直接返回；starting 返回进行中的那次启动。
   * `wait:false` 只把流程踢起来，立刻返回当前快照（M6 的 202 语义用这个）。
   *
   * @returns {Promise<object>} status()
   */
  async start(options = {}) {
    const { wait = true, env = null, models = null, lease } = options;

    if (models) this.updateModels(models);
    if (lease !== undefined) this.lease = lease;

    if (this._phase === 'ready') return this.status();
    if (this._phase === 'starting') {
      if (!wait) return this.status();
      if (this._startPromise) return this._startPromise;
      return this.status();
    }
    if (this._phase === 'stopping') {
      throw new RuntimeError(`实例 ${this.id} 正在停止，等它停完再启动`);
    }

    this.error = null;
    this.lastExit = null;
    this.probe = { lastAt: null, ok: null, failures: 0, lastError: null, models: null, attempts: 0, url: null };
    this._abort = new AbortController();
    this._startPromise = this._runStart({ env })
      .catch((err) => this._fail(err))
      .finally(() => {
        this._startPromise = null;
      });

    if (!wait) return this.status();
    await this._startPromise;
    return this.status();
  }

  async _runStart({ env }) {
    if (!this.dispatch('started', { port: this.port, pid: this.pid })) {
      throw new RuntimeError(`实例 ${this.id} 不能从 ${this._phase} 启动`);
    }
    this.emit('starting', this.status());

    try {
      // ① 拼命令行（缺变量/缺槽位在这里就炸，不是等引擎慢慢超时）
      const plan = this.buildPlan();
      for (const warning of plan.warnings ?? []) this.addWarning(warning);

      // ② 开日志（写不进去只标警告，绝不影响启动）
      this.log.open();
      this.log.note(`启动：${plan.display}`);

      // ③ 起进程（策略分派）
      const launcher = this._launchers.get(resolveLauncherKey(this.engine));
      const launched = await launcher({
        engine: this.engine,
        plan,
        instance: this,
        instanceId: this.id,
        extraEnv: env,
      });

      // 万一 stop() 在 spawn 期间插进来：这个刚起来的进程不能留
      this._adoptLaunch(launched, plan);
      if (this._phase !== 'starting') {
        await this._killQuietly('启动被取消');
        return this.status();
      }

      // ④ 判活（策略分派；循环与超时在这里，策略只负责「探一次」）
      const result = await this._waitReady();
      if (result.aborted) return this.status();

      if (!result.ok) {
        await this._fail(result.error ?? new RuntimeError('判活失败'), { url: result.url });
        await this._killQuietly('判活失败后清理');
        await this._releaseLeaseIfNoProcess('判活失败');
        return this.status();
      }

      this.probe = {
        lastAt: Date.now(),
        ok: true,
        failures: 0,
        lastError: null,
        models: result.models ?? null,
        attempts: result.attempts,
        url: result.url,
      };
      this.reportedModelIds = result.models ? [...result.models] : null;
      this.dispatch('probe-ok', {
        url: result.url,
        attempts: result.attempts,
        elapsedMs: result.elapsedMs,
        models: result.models ?? null,
      });
      this.log.note(`就绪：${result.url}（探了 ${result.attempts} 次）`);
      this.emit('ready', this.status());
      return this.status();
    } catch (err) {
      await this._fail(err);
      if (this.pid) await this._killQuietly('启动失败后清理');
      await this._releaseLeaseIfNoProcess('启动失败');
      return this.status();
    }
  }

  _adoptLaunch(launched, plan) {
    this.launch = {
      program: plan.program,
      args: [...plan.args],
      display: plan.display,
      spawn: launched?.spawn ?? null,
    };
    const child = launched?.child ?? null;
    this._child = child;
    this._childExited = false;
    this.pid = launched?.pid ?? child?.pid ?? this.pid ?? null;

    if (!child) return; // 将来 attach 模式没有 child，只有 pid/baseURL

    const token = Symbol('child');
    this._childToken = token;
    child.once('exit', (code, signal) => this._onChildExit(token, code, signal));
    child.once('error', (err) => this.addWarning(`进程错误：${err.message}`));
    this._wireStream(child, 'stdout');
    this._wireStream(child, 'stderr');
  }

  _wireStream(child, name) {
    const stream = child?.[name];
    if (!stream || typeof stream.on !== 'function') return;
    try {
      stream.setEncoding?.('utf8');
    } catch {
      /* 编码设不上就按 Buffer 处理，write() 里会 toString */
    }
    stream.on('data', (chunk) => this.log.write(chunk, name));
    stream.on('error', (err) => this.addWarning(`读 ${name} 出错：${err.message}`));
  }

  /** 判活循环：一直探到 ready / 超时 / 被 stop 打断 / 进程自己没了 */
  async _waitReady() {
    const ready = this.engine?.ready ?? {};
    if (!ready.url) {
      throw new RuntimeError(
        `引擎 ${this.engineId} 没有配置 ready.url，M2 无法判活（§14.2 的 script 判活还没做）`,
      );
    }

    const url = this.readyUrl(this._plan);
    const prober = this._probers.get(resolveProberKey(this.engine));
    const timeoutMs = Number(ready.timeoutMs) > 0 ? Number(ready.timeoutMs) : 300000;
    const intervalMs = Number(ready.intervalMs) > 0 ? Number(ready.intervalMs) : 900;
    const attemptTimeoutMs = Number(ready.attemptTimeoutMs) > 0 ? Number(ready.attemptTimeoutMs) : 2000;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    let attempts = 0;
    let lastError = null;

    while (true) {
      // 被 stop() 打断，或者进程已经退出（退出事件会把 phase 推到 error）
      if (this._abort?.signal.aborted || this._phase !== 'starting') {
        return { ok: false, aborted: true, url, attempts, startedAt };
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          ok: false,
          url,
          attempts,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          error: lastError ?? new RuntimeError(`判活超时（${Math.round(timeoutMs / 1000)} 秒）`),
        };
      }

      attempts += 1;
      let probe;
      try {
        probe = await prober({
          url,
          timeoutMs: Math.min(attemptTimeoutMs, Math.max(500, remaining)),
          signal: this._abort?.signal,
          engine: this.engine,
          instanceId: this.id,
        });
      } catch (err) {
        // 策略抛错也要当成一次「没探到」，不能把启动流程炸掉
        probe = { ok: false, error: err };
      }

      this.probe = {
        lastAt: Date.now(),
        ok: Boolean(probe?.ok),
        failures: probe?.ok ? 0 : this.probe.failures + 1,
        lastError: probe?.ok ? null : (probe?.error?.message ?? '判活失败'),
        models: probe?.models ?? null,
        attempts,
        url,
      };
      this.emit('probe', { instanceId: this.id, ...this.probe, phase: this._phase });

      if (probe?.ok) {
        return {
          ok: true,
          url,
          attempts,
          models: probe.models ?? null,
          startedAt,
          elapsedMs: Date.now() - startedAt,
        };
      }

      lastError = probe?.error instanceof Error ? probe.error : new RuntimeError(String(probe?.error ?? '判活失败'));

      if (!(await sleepSafe(intervalMs, this._abort?.signal))) {
        return { ok: false, aborted: true, url, attempts, startedAt };
      }
    }
  }

  _onChildExit(token, code, signal) {
    if (token !== this._childToken) return; // 旧进程（重启过）的迟到事件，忽略
    this._child = null;
    this._childExited = true;
    this.pid = null;
    this.lastExit = { code: code ?? null, signal: signal ?? null, at: Date.now() };
    this.log.flush();
    this.log.close();

    const phase = this._phase;
    if (phase === 'stopping') {
      this.log.note(`进程已退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`);
      this.dispatch('process-exit', { code, signal, reason: 'stopped' });
      void this._releaseLease('进程退出');
      this.emit('process-exit', { instanceId: this.id, code, signal, status: this.status() });
      return;
    }

    if (phase === 'starting' && (code === 0 || code === null) && !signal) {
      /* 有的整合包启动器是"另开一个窗口跑服务、自己退出"（退出码 0）。
         别急着判死：继续等端口就绪——就绪了就是 ready，真起不来交给判活超时。 */
      this.log.note(`启动器进程退出了（code=${code ?? 'null'}），可能在别处起了服务；继续等端口就绪…`);
      return;
    }

    if (phase === 'starting' || phase === 'ready') {
      // 进程自己没了：这是**意外退出**，不是对账判死。网关要据此回 502（§5.6.4）
      //
      // 界面上的红字必须能当线索用：`code=1` 谁都会写，真正的答案在引擎的
      // 最后一行 FATAL / ERROR 里（比如"runtime reservation requires N bytes"）。
      // 所以把最后一条有信息量的输出一起带上。
      const detail = this._lastMeaningfulLine();
      const head = `引擎进程意外退出（code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''}）`;
      this.error = detail
        ? `${head}：${detail.length > 180 ? `${detail.slice(0, 180)}…` : detail}`
        : head;
      this.log.note(this.error);
      this.dispatch('process-exit', { code, signal, reason: 'crashed' });
      this.emit('crash', { instanceId: this.id, code, signal, status: this.status() });
      void this._releaseLease('进程意外退出');
      this.emit('process-exit', { instanceId: this.id, code, signal, status: this.status() });
    }
  }

  /** 启动失败/判活失败时兜底记一笔（重复调用不会重复转移） */
  async _fail(err, detail = {}) {
    const message = typeof err === 'string' ? err : (err?.message ?? String(err ?? '未知错误'));
    if (this._phase === 'error' && this.error === message) return this.status();

    this.error = message;
    this.log.note(`失败：${message}`);
    this.emit('failed', { instanceId: this.id, message, error: err, status: this.status() });

    if (this._phase === 'starting' || this._phase === 'ready') {
      this.dispatch('fail', { error: message, ...detail });
    }
    return this.status();
  }

  /** 尽力杀干净，不走状态机（清理动作，状态已经有人负责了） */
  async _killQuietly(reason) {
    const pid = this.pid;
    if (!pid) {
      this._child = null;
      return;
    }
    const key = resolveStopperKey(this.engine);
    const stopper = this._stoppers.tryGet(key);
    if (!stopper) {
      this.addWarning(`停止策略「${key}」没注册，进程 ${pid} 可能还在运行`);
      return;
    }
    try {
      const result = await stopper({
        engine: this.engine,
        instance: this,
        instanceId: this.id,
        pid,
        child: this._child,
        graceMs: 1500,
        port: this.port,
        host: this.host,
        reason,
      });
      if (result?.stopped !== false) {
        this.pid = null;
        this._child = null;
      } else {
        this.addWarning(`清理进程 ${pid} 失败：${result?.note ?? '进程仍在'}`);
      }
    } catch (err) {
      this.addWarning(`清理进程 ${pid} 时出错：${err.message}`);
    }
  }

  /* ---------- 停止 ---------- */

  /**
   * 停止：starting/ready → stopping → idle（error 直接复位到 idle）。
   * 先请策略停进程，再等端口释放；并发调用合并成一次。
   */
  async stop(options = {}) {
    const { force = false, graceMs } = options;

    if (this._phase === 'idle') {
      await this._releaseLease('已经空闲');
      return this.status();
    }
    if (this._stopPromise) return this._stopPromise;

    this._stopPromise = this._runStop({ force, graceMs }).finally(() => {
      this._stopPromise = null;
    });
    return this._stopPromise;
  }

  async _runStop({ force, graceMs }) {
    // 先打断判活循环，避免它在停止过程中还把状态往 ready 推
    this._abort?.abort();

    const pid = this.pid;
    this.dispatch('stop-requested', { pid, force });
    if (this._phase === 'stopping') this.emit('stopping', this.status());

    // ?? 不能和 || 直接混用（语法错误），括号写清楚：没传就取引擎配置，再不行按 5 秒
    const effectiveGrace = graceMs ?? (Number(this.engine?.stop?.graceMs) || 5000);

    // error → idle 的直达路径：状态已经是 idle，但可能还留着一个卡死的进程
    if (this._phase === 'idle') {
      if (pid) await this._killQuietly('从 error 复位时清理残留进程');
      this.log.flush();
      this.log.close();
      await this._releaseLease('停止');
      return this.status();
    }

    const stopperKey = resolveStopperKey(this.engine);
    const stopper = this._stoppers.tryGet(stopperKey);
    if (!stopper) {
      this.addWarning(
        `停止策略「${stopperKey}」没注册；只把状态改成 idle，进程 ${pid ?? '（未知）'} 可能还在运行`,
      );
    } else {
      try {
        this.log.note(`停止：pid=${pid ?? 'null'}（策略 ${stopperKey}，宽限 ${effectiveGrace}ms）`);
        const result = await stopper({
          engine: this.engine,
          instance: this,
          instanceId: this.id,
          pid,
          child: this._child,
          graceMs: effectiveGrace,
          port: this.port,
          host: this.host,
          force,
        });
        this.lastStop = { at: Date.now(), ...(result ?? {}) };
        if (result?.stopped === false) {
          this.addWarning(`进程 ${pid ?? '（未知）'} 可能没停掉：${result?.note ?? '杀进程失败'}`);
        }
      } catch (err) {
        this.addWarning(`停进程失败：${err.message}`);
      }
    }

    // 进程退出事件通常已经把 phase 推到 idle；这里兜底（比如 pid 丢了、attach 模式）
    if (this._phase === 'stopping') this.dispatch('stop-done', { pid, source: 'stopper' });

    // 端口释放：只有在「进程确实不在了」时才要求端口关闭。
    // attach / http-unload 这类停止方式进程本来就留着，端口开着是正常的。
    // 判据优先级：退出事件 > pid 探活（pid 可能被系统回收给别的进程，不能只看数字）。
    const gone = !pid || this._childExited || !isPidAlive(pid);
    if (gone) {
      this.pid = null;
      if (this.port) {
        const freed = await waitForPortClosed(this.port, { host: this.host, timeoutMs: 5000 });
        if (!freed) this.addWarning(`端口 ${this.port} 在停止后仍然可连（可能被别的进程占用了）`);
      }
    }

    this.log.flush();
    this.log.close();
    await this._releaseLease('停止');
    this.emit('stopped', this.status());
    return this.status();
  }

  /**
   * 重启（自愈 / 界面「保存并重启」都用它）：停干净再起。
   * 语义就是 stop → start，不是新建实例：engine/models/port 都保留。
   */
  async restart(options = {}) {
    const { force = true, graceMs = 2000, env = null, wait = true } = options;
    if (this._phase !== 'idle') {
      await this.stop({ force, graceMs });
    } else if (this.pid) {
      await this._killQuietly('重启前清理残留进程');
    }
    return this.start({ wait, env });
  }

  /* ---------- 对账（本实例只读地探一次） ---------- */
  /**
   * 对账：**只改状态，不重启**（§5.6.3 规则 1）。
   * 只处理 ready；starting/stopping 由调用方跳过（这里再兜一层）。
   *
   * @returns {Promise<object>} 对账结果（给 manager 汇总）
   */
  async reconcileOnce({ probeTimeoutMs = 2000 } = {}) {
    if (this._phase !== 'ready') {
      return { id: this.id, skipped: true, phase: this._phase, ok: null };
    }

    // ① 进程还在吗（process.kill(pid, 0)）——不在了直接判死
    const pid = this.pid;
    if (pid && !isPidAlive(pid)) {
      this.probe = {
        ...this.probe,
        lastAt: Date.now(),
        ok: false,
        failures: this.probe.failures + 1,
        lastError: `进程 ${pid} 已不在`,
      };
      this.error = `对账发现进程 ${pid} 已退出（可能是外部杀掉的）`;
      this.log.note(`对账：进程 ${pid} 已不在，标 error（不自动重启）`);
      this.pid = null;
      this.dispatch('process-exit', { reason: 'reconcile-pid', pid });
      // 进程确认没了 → 租约必须还；端口判死那条路径不同（见下）
      await this._releaseLease('对账确认进程已退出');
      this.emit('dead', { instanceId: this.id, reason: 'process-gone', pid, status: this.status() });
      return { id: this.id, ok: false, dead: true, reason: 'process-gone', pid, phase: this._phase };
    }

    // ② 端口通吗（GET /v1/models，2 秒超时）
    let url;
    try {
      url = this.readyUrl(this._plan);
    } catch (err) {
      this.addWarning(`对账跳过：判活地址不可用（${err.message}）`);
      return { id: this.id, ok: null, skipped: true, reason: 'no-ready-url', phase: this._phase };
    }

    let probe;
    try {
      const key = resolveProberKey(this.engine);
      const prober = this._probers.tryGet(key);
      if (!prober) throw new StrategyNotRegisteredError('prober', key, this._probers.keys().join(' / '));
      probe = await prober({ url, timeoutMs: probeTimeoutMs, engine: this.engine, instanceId: this.id });
    } catch (err) {
      probe = { ok: false, error: err };
    }

    this.probe = {
      lastAt: Date.now(),
      ok: Boolean(probe?.ok),
      failures: probe?.ok ? 0 : this.probe.failures + 1,
      lastError: probe?.ok ? null : (probe?.error?.message ?? '判活失败'),
      models: probe?.models ?? null,
      attempts: this.probe.attempts,
      url,
    };
    this.emit('probe', { instanceId: this.id, ...this.probe, phase: this._phase, source: 'reconcile' });

    if (probe?.ok) {
      // ③ 模型名对得上吗：引擎是事实，记录只是缓存 → 修正记录 + 记日志
      const change = this._applyReportedModels(probe.models, { source: 'reconcile' });
      return { id: this.id, ok: true, url, models: probe.models ?? null, change };
    }

    const failures = this.probe.failures;
    // 连续 2 次失败才判死：一次超时可能只是引擎在忙 prefill（§5.6.2）
    if (failures >= 2) {
      this.error = `对账连续 ${failures} 次探活失败：${this.probe.lastError}`;
      this.log.note(`对账：连续 ${failures} 次探活失败，标 error（不自动重启）`);
      this.dispatch('process-exit', { reason: 'reconcile-probe', failures });
      // 注意：端口探不到不代表进程死了（可能卡死占着显存）→ 这里**故意不释放租约**，
      // 等用户/自愈真的把进程停掉时再还。
      this.emit('dead', {
        instanceId: this.id,
        reason: 'probe-failed',
        failures,
        status: this.status(),
      });
      return { id: this.id, ok: false, dead: true, failures, reason: 'probe-failed', phase: this._phase };
    }

    return { id: this.id, ok: false, failures, retry: true, phase: this._phase };
  }

  /**
   * 引擎报告的模型名和记录不一致时修正记录。
   * 第一版：能映射回 LACI 模型就改 modelIds，映射不了只记警告（§5.6.2）。
   */
  _applyReportedModels(reported, { source } = {}) {
    if (!Array.isArray(reported) || reported.length === 0) return null;
    this.reportedModelIds = [...reported];

    const expected = new Set(this.models.map(engineModelIdOf).filter(Boolean));
    const same = reported.length === expected.size && reported.every((id) => expected.has(id));
    if (same) return { changed: false, reported };

    const mapped = reported.map((id) => this._laciIdByEngineId(id)).filter(Boolean);
    const complete = mapped.length === reported.length && mapped.length > 0;
    const previous = [...this._modelIds];
    if (complete) this._modelIds = mapped;

    this.log.note(
      `对账：引擎报告模型 ${reported.join(',')}，记录是 ${previous.join(',') || '（空）'}；` +
        (complete ? '已按引擎修正记录' : '部分模型没在 LACI 登记，未修正'),
    );
    this.addWarning(`检测到外部变更：引擎现在载的是 ${reported.join('、')}`);

    const payload = {
      instanceId: this.id,
      source: source ?? 'reconcile',
      reported,
      mapped: complete ? mapped : null,
      previous,
      changed: true,
      at: Date.now(),
    };
    this.emit('external-change', payload);
    return payload;
  }

  _laciIdByEngineId(engineId) {
    const hit = this.models.find((m) => engineModelIdOf(m) === engineId);
    return hit?.id ?? null;
  }

  /* ---------- 杂项 ---------- */

  /** 从 pending 状态的 lease 里还掉（幂等） */
  async _releaseLease(reason = '') {
    const lease = this.lease;
    this.lease = null;
    if (!lease) return;
    try {
      if (typeof lease.release === 'function') await lease.release(reason);
      else if (typeof lease === 'function') await lease(reason);
    } catch (err) {
      this.addWarning(`释放租约失败：${err.message}`);
    }
  }

  /** 进程确实没了才还租约：卡死的进程可能还占着显存，不能提前记账 */
  async _releaseLeaseIfNoProcess(reason = '') {
    if (this.pid) return;
    await this._releaseLease(reason);
  }

  /**
   * 日志里最后一条"能当错误原因"的行。
   *
   * 跳过 LACI 自己写的 `[laci …]` 行（循环引用：那行就是"引擎退出"本身），
   * 优先取 FATAL / ERROR 这类；都没有就返回 null，让调用方用中性文案。
   */
  _lastMeaningfulLine() {
    const lines = this.log.lines;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let text = String(lines[i] ?? '').trim();
      if (!text) continue;
      if (text.startsWith('[laci ')) continue;
      if (!/FATAL|ERROR|Error:|error:|失败|unknown argument|not supported|refused|denied/i.test(text)) continue;
      // 引擎行自带时间戳；界面那一行只有 90 多字，先把时间戳和多余空白压掉
      text = text
        .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/, '')
        .replace(/\s+/g, ' ')
        .trim();
      return text || null;
    }
    return null;
  }

  addWarning(message) {
    const text = String(message ?? '').trim();
    if (!text) return;
    if (this.warnings.includes(text)) return;
    this.warnings.push(text);
    if (this.warnings.length > 20) this.warnings.shift();
    this.emit('warning', { instanceId: this.id, message: text, at: Date.now() });
  }

  /** 日志尾随：最近 n 行 */
  tail(n = 50) {
    return this.log.lines.slice(-Math.max(1, n));
  }

  /** instances.json 里的那一条（字段按 M1 契约） */
  persistShape() {
    return {
      engineId: this.engineId,
      modelIds: [...this._modelIds],
      port: this.port,
      pid: this.pid,
      phase: this._phase,
      ephemeral: this.ephemeral,
      startedAt: this.startedAt,
    };
  }

  /** 不杀进程、只断开：LACI 重启时「认回来」用 */
  detach() {
    this._detached = true;
    this._abort?.abort();
    if (this._child) {
      this._child.removeAllListeners?.('exit');
      this._child.stdout?.removeAllListeners?.('data');
      this._child.stderr?.removeAllListeners?.('data');
    }
    this._child = null;
    this.log.close();
    return this.status();
  }

  _wireLog() {
    this.log.on('line', (payload) => this.emit('log', { ...payload, instanceId: this.id }));
    this.log.on('footprint', (payload) => {
      this.footprint = { ...payload };
      this.emit('footprint', { ...payload, instanceId: this.id });
    });
    // 引擎报的运行时预留：本实例只记下来给界面看，真正写回模型档案的是
    // RuntimeManager（它才拿得到 M4 的 footprint 模块）。
    this.log.on('reservation-line', (payload) => {
      this.emit('reservation', { ...payload, instanceId: this.id });
    });
    this.log.on('warning', (payload) => this.addWarning(payload.message));
  }
}

/* ==========================================================================
 * 和 M1（registry.mjs）/ M4（ledger.mjs）的懒连接
 *
 * 为什么用动态 import + 能力探测：
 *   - 并行开发时 M1/M4 可能还没落地，静态 import 会让 M2 直接起不来
 *   - ESM 静态循环依赖（M4 也要 import M2）在顶层求值时容易踩 TDZ
 *   - 拿不到就降级：不阻塞进程管理，只影响「持久化 / 预留」这两个附加能力
 * ========================================================================== */

let _registryModule;
let _registryLoadError;
let _ledgerModule;
let _ledgerLoadError;

async function importRegistryModule() {
  if (_registryModule !== undefined) return _registryModule;
  try {
    _registryModule = await import('./registry.mjs');
  } catch (err) {
    _registryModule = null;
    _registryLoadError = err;
  }
  return _registryModule;
}

async function importLedgerModule() {
  if (_ledgerModule !== undefined) return _ledgerModule;
  try {
    _ledgerModule = await import('./ledger.mjs');
  } catch (err) {
    _ledgerModule = null;
    _ledgerLoadError = err;
  }
  return _ledgerModule;
}

/** 兼容两种导出风格：模块级函数，或默认导出对象上的方法 */
function pickFunction(mod, name) {
  if (!mod) return null;
  const direct = mod[name];
  if (typeof direct === 'function') return direct;
  const fallback = mod.default?.[name];
  if (typeof fallback === 'function') return fallback;
  return null;
}

function describeModuleError(err) {
  return err ? String(err.message ?? err) : '模块还没写好';
}

/* ==========================================================================
 * RuntimeManager
 * ========================================================================== */

/**
 * 实例集合 + 20 秒对账定时器。
 *
 * 定时器只有这一个:对账。空闲卸载（60s）与自愈（429/503）属于 M5/M4：
 * 它们从本类的 `phase` / `dead` / `crash` / `external-change` 事件里拿信号，
 * 要动手前自己去抢账本（§5.6.3 规则 4）。
 */
export class RuntimeManager extends Emitter {
  constructor(options = {}) {
    super();
    const {
      launchers = defaultLaunchers,
      probers = defaultProbers,
      stoppers = defaultStoppers,
      reconcileIntervalMs = 20000,
      probeTimeoutMs = 2000,
      logDir = defaultLogDir(),
      host = '127.0.0.1',
      persist = true,
      // 单例（getRuntimeManager）默认自动开对账；直接 new 的实例默认不开，方便测试。
      autoStartReconciler = false,
    } = options;

    this._launchers = launchers;
    this._probers = probers;
    this._stoppers = stoppers;
    this.reconcileIntervalMs = reconcileIntervalMs;
    this.probeTimeoutMs = probeTimeoutMs;
    this.logDir = logDir;
    this.host = host;
    this.persist = persist;

    this._instances = new Map();
    this._reconcileTimer = null;
    this._reconciling = null;
    this._reconcilerStartedAt = null;
    this._lastReconcile = null;
    this._persistTimer = null;
    this._persistDisabled = false;
    this._disposed = false;

    // 20 秒对账：这是 M2 唯一的定时器（空闲卸载 / 自愈在 M5/M4，用事件驱动）
    if (autoStartReconciler) this.startReconciler();
  }

  /* ---------- 实例集合 ---------- */

  /** 直接接管一个已经造好的 InstanceRuntime */
  register(rt) {
    if (!(rt instanceof InstanceRuntime)) throw new TypeError('register() 需要 InstanceRuntime');
    if (this._instances.has(rt.id)) throw new RuntimeError(`实例 id 重复：${rt.id}`);
    this._instances.set(rt.id, rt);

    rt.on('phase', (change) => {
      this._schedulePersist();
      this.emit('phase', change);
      if (change.to === 'idle') this.emit('idle', { instanceId: rt.id, status: rt.status() });
    });
    rt.on('crash', (payload) => {
      this.emit('crash', payload);
      void this._recordFailure(rt, payload?.status?.error || '引擎进程意外退出');
    });
    rt.on('dead', (payload) => this.emit('dead', payload));
    rt.on('failed', (payload) => {
      this.emit('failed', payload);
      void this._recordFailure(rt, payload?.message || payload?.status?.error);
    });
    rt.on('external-change', (payload) => {
      this._schedulePersist();
      this.emit('external-change', payload);
      // 引擎外部换了模型：记录已经改了，但手里的 model 对象还是旧的。
      // 让 M1 重新读一遍，否则下一次启动会拿旧文件路径去拼命令行。
      if (Array.isArray(payload?.mapped) && payload.mapped.length > 0) {
        void this._reloadModels(rt, payload.mapped);
      }
    });
    rt.on('footprint', (payload) => {
      this.emit('footprint', payload);
      // 引擎报了「池 N tokens / runtime M MiB」→ 先记在实例上，**等停止时**再写回档案。
      // 为什么不在启动中写：那会儿显存已经吃掉了，nvidia-smi 读到的空闲值是"加载后"的，
      // 记进指纹后下次空载一比对就判"硬件变了"，实测值永远用不上。
      if (payload && payload.kvTokens != null) rt._measuredPending = payload;
    });
    rt.on('process-exit', () => {
      const pending = rt._measuredPending;
      if (!pending) return;
      rt._measuredPending = null;
      // 等 1.5 秒让驱动把显存还回去，再把空闲值记成指纹
      setTimeout(() => { void this._backfillFootprint(rt, pending); }, 1500);
    });
    // 引擎自己报的运行时预留 → 回填到模型档案（下次预估就准了）。
    rt.on('reservation', (payload) => {
      this.emit('reservation', payload);
      void this._learnRuntimeReserve(rt, payload);
    });
    rt.on('warning', (payload) => this.emit('warning', payload));
    rt.on('log', (payload) => this.emit('log', payload)); // M6 的 SSE 尾随直接用

    return rt;
  }

  /** 造一个实例（不启动） */
  create(options = {}) {
    const rt = new InstanceRuntime({
      host: this.host,
      logDir: this.logDir,
      launchers: this._launchers,
      probers: this._probers,
      stoppers: this._stoppers,
      ...options,
    });
    return this.register(rt);
  }

  get(id) {
    return this._instances.get(id) ?? null;
  }

  has(id) {
    return this._instances.has(id);
  }

  list() {
    return [...this._instances.values()];
  }

  get size() {
    return this._instances.size;
  }

  /**
   * 加载一个实例：解析引擎/模型 → 建实例 → 启动。
   *
   * `reserve` 默认 false：账本（M4）是编排方，正常路径由调用方先 reserve 再把 lease 传进来；
   * 这里再抢一次会重复记账。只有调用方明确说「你帮我预留」时才走 _reserve。
   * `wait:false` 立刻返回（starting 状态），启动流程在后台继续。
   */
  async load(options = {}) {
    const {
      id,
      engineId,
      engine,
      modelIds,
      models,
      port,
      host,
      ephemeral = false,
      lease,
      reserve = false,
      wait = true,
      env = null,
    } = options;

    const resolvedEngine = engine ?? (await this._requireEngine(engineId));
    const ids = modelIds ?? [];
    const resolvedModels = models ?? (await this._requireModels(ids));

    let heldLease = lease ?? null;
    if (!heldLease && reserve) heldLease = await this._reserve(resolvedModels);

    const rt = this.create({
      id: id ?? this._nextInstanceId(),
      engine: resolvedEngine,
      models: resolvedModels,
      port: port ?? resolvedModels[0]?.port ?? resolvedEngine.defaultPort ?? null,
      host: host ?? this.host,
      ephemeral,
      lease: heldLease,
    });

    // 记下"加载前"的空闲显存：实测回填要用启动前后的差值（§5.10）
    try {
      const fp = await import('./footprint.mjs');
      if (typeof fp.readGpu === 'function') rt._gpuBeforeFreeMiB = fp.readGpu({}).freeMiB;
    } catch {
      rt._gpuBeforeFreeMiB = null;
    }

    try {
      await rt.start({ wait, env });
    } catch (err) {
      // 起不来就把它从集合里摘掉，顺手把租约还了——不能因为一次失败把账本挂住
      this._instances.delete(rt.id);
      await rt._releaseLease('加载失败');
      rt.log.close();
      throw err;
    }
    return rt;
  }

  /** 关闭并移除一个实例 */
  async unload(id, options = {}) {
    const rt = this._instances.get(id);
    if (!rt) throw new RuntimeError(`没有实例 ${id}`);
    await rt.stop(options);
    this._instances.delete(id);
    this._schedulePersist();
    return rt.status();
  }

  /** 清掉 M3 试启动留下的 ephemeral 实例（控制台启动时先跑一遍，§5.5.2） */
  async purgeEphemeral() {
    const targets = this.list().filter((rt) => rt.ephemeral);
    const results = [];
    for (const rt of targets) {
      try {
        await rt.stop({ force: true, graceMs: 1000 });
      } catch (err) {
        this.emit('warning', { message: `清理临时实例 ${rt.id} 失败：${err.message}` });
      }
      this._instances.delete(rt.id);
      results.push(rt.id);
    }
    if (results.length > 0) this._schedulePersist();
    return results;
  }

  _nextInstanceId() {
    for (let i = 0; i < 50; i += 1) {
      const id = `inst-${crypto.randomBytes(2).toString('hex')}`;
      if (!this._instances.has(id)) return id;
    }
    return `inst-${Date.now().toString(36)}`;
  }

  /* ---------- 状态 ---------- */

  status() {
    return {
      instances: this.list().map((rt) => rt.status()),
      reconcile: {
        intervalMs: this.reconcileIntervalMs,
        running: Boolean(this._reconcileTimer),
        startedAt: this._reconcilerStartedAt,
        last: this._lastReconcile,
      },
    };
  }

  /* ---------- 对账定时器（20 秒） ---------- */

  startReconciler({ intervalMs = this.reconcileIntervalMs, immediate = false } = {}) {
    if (this._reconcileTimer) return this._reconcileTimer;
    this.reconcileIntervalMs = intervalMs;
    this._reconcilerStartedAt = Date.now();
    this._reconcileTimer = setInterval(() => {
      // 对账是只读的，不用抢账本；它自己也不该把进程搞崩
      void this.reconcileNow();
    }, intervalMs);
    this._reconcileTimer.unref?.(); // 别让定时器把 node 进程留住（测试/CLI 友好）
    this.emit('reconciler-started', { intervalMs, at: this._reconcilerStartedAt });
    if (immediate) void this.reconcileNow();
    return this._reconcileTimer;
  }

  stopReconciler() {
    if (!this._reconcileTimer) return false;
    clearInterval(this._reconcileTimer);
    this._reconcileTimer = null;
    this.emit('reconciler-stopped', { at: Date.now() });
    return true;
  }

  /**
   * 立刻对账一次（不重启、只改状态）。
   * 只探 ready；starting/stopping 直接跳过（起停过程中端口本来就不通）。
   */
  async reconcileNow() {
    if (this._reconciling) return this._reconciling;

    this._reconciling = (async () => {
      const all = this.list();
      const readyList = all.filter((rt) => rt.phase === 'ready');
      const skipped = all
        .filter((rt) => rt.phase !== 'ready')
        .map((rt) => ({ id: rt.id, skipped: true, phase: rt.phase, ok: null }));

      const results = await Promise.all(
        readyList.map((rt) =>
          rt
            .reconcileOnce({ probeTimeoutMs: this.probeTimeoutMs })
            .catch((err) => ({ id: rt.id, ok: false, error: err?.message ?? String(err) })),
        ),
      );

      const summary = {
        at: Date.now(),
        checked: readyList.length,
        skipped: skipped.length,
        dead: results.filter((r) => r?.dead).length,
        results: [...results, ...skipped],
      };
      this._lastReconcile = summary;
      this.emit('reconcile', summary);
      return summary;
    })()
      .catch((err) => {
        this.emit('warning', { message: `对账出错：${err.message}` });
        return { at: Date.now(), ok: false, error: err.message, results: [] };
      })
      .finally(() => {
        this._reconciling = null;
      });

    return this._reconciling;
  }

  /* ---------- 与 M1 / M4 的接口 ---------- */

  async _requireEngine(engineId) {
    if (!engineId) throw new RuntimeError('load() 需要 engine 对象或 engineId');
    const mod = await importRegistryModule();
    const loadEngine = pickFunction(mod, 'loadEngine');
    if (!loadEngine) {
      throw new RuntimeError(
        `M1 registry.mjs 还不能用（${describeModuleError(_registryLoadError)}）：请直接传 engine 对象`,
      );
    }
    const engine = await loadEngine(engineId);
    if (!engine) throw new RuntimeError(`引擎不存在：${engineId}`);
    return engine;
  }

  async _requireModels(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const mod = await importRegistryModule();
    const loadModel = pickFunction(mod, 'loadModel');
    if (!loadModel) {
      throw new RuntimeError(
        `M1 registry.mjs 还不能用（${describeModuleError(_registryLoadError)}）：请直接传 models 数组`,
      );
    }
    const out = [];
    for (const modelId of ids) {
      const model = await loadModel(modelId);
      if (!model) throw new RuntimeError(`模型不存在：${modelId}`);
      out.push(model);
    }
    return out;
  }

  /** 外部变更后用 M1 的最新模型定义替换实例手里的旧对象（失败只警告，不影响已就绪的进程） */
  async _reloadModels(rt, modelIds) {
    try {
      rt.updateModels(await this._requireModels(modelIds));
    } catch (err) {
      this.emit('warning', {
        message: `外部变更后重新载入模型失败（实例 ${rt.id}）：${err.message}`,
      });
    }
  }

  /**
   * 实测回填（§5.10）：引擎打出 `capacity | KV N tokens … runtime M MiB` 后，
   * 把「权重 + KV + runtime」算成 footprint(measured) 写回模型档案。
   * 下次预估直接引用实测值，不再弹"按公式估"。
   */
  async _backfillFootprint(rt, payload) {
    try {
      if (!payload || payload.kvTokens == null) return; // 只回填真实的 capacity 行
      const modelId = rt.modelIds[0];
      if (!modelId) return;
      const mod = await import('./footprint.mjs');
      const afterFreeMiB = typeof mod.readGpu === 'function'
        ? mod.readGpu({ fresh: true }).freeMiB
        : null;
      const result = mod.backfillMeasured({
        modelId,
        parsed: { kvTokens: payload.kvTokens, runtimeMiB: payload.runtimeMiB },
        beforeFreeMiB: rt._gpuBeforeFreeMiB,
        afterFreeMiB,
        engine: rt.engine,
      });
      if (result && result.saved) {
        rt.log.note(
          `实测回填：${result.footprint.vramMiB} MiB（${result.basis}），已写回模型 ${modelId}`,
        );
        this.emit('footprint-saved', { instanceId: rt.id, modelId, ...result });
      }
    } catch (err) {
      this.emit('warning', { message: `实测回填失败：${err.message}` });
    }
  }

  /** 起不来时把原因写进 lastFailure，下次预检提示更具体（§5.10） */
  async _recordFailure(rt, message) {
    try {
      const modelId = rt.modelIds[0];
      if (!modelId || !message) return;
      const mod = await import('./footprint.mjs');
      if (typeof mod.recordFailure === 'function') mod.recordFailure(modelId, message);
      this.emit('failure-saved', { instanceId: rt.id, modelId, message });
    } catch (err) {
      this.emit('warning', { message: `记录失败原因失败：${err.message}` });
    }
  }

  /**
   * 从引擎日志里学到"运行时预留要多少"，写回模型档案。
   *
   * 这条链路对应手册 §5.10「启动后从日志抓真实值回填」——只是它抓的这条
   * 出现在**失败**日志里（成功启动前就先撞上了），所以价值更大：
   * 第一次起不来，第二次的预检就能如实说出缺口，而不是再说"大概够"。
   */
  async _learnRuntimeReserve(rt, payload) {
    try {
      const mod = await import('./footprint.mjs');
      const parsed = typeof mod.parseFootprintLine === 'function'
        ? mod.parseFootprintLine(payload?.line)
        : null;
      if (!parsed || parsed.source !== 'reservation' || !(parsed.runtimeMiB > 0)) return;

      rt.runtimeReserveMib = parsed.runtimeMiB;
      for (const modelId of rt.modelIds) {
        const saved = typeof mod.saveRuntimeReserve === 'function'
          ? mod.saveRuntimeReserve(modelId, parsed.runtimeMiB)
          : null;
        if (!saved) continue;
        rt.log.note(
          `学到运行时预留：${saved.value} MiB（原来按 ${saved.previous} MiB 估），已写回模型 ${modelId}`,
        );
        this.emit('reserve-learned', { ...saved, instanceId: rt.id });
      }
    } catch (err) {
      this.emit('warning', { message: `回填运行时预留失败：${err.message}` });
    }
  }

  /** 抢租约（只有 load({reserve:true}) 才会走；账本永远不硬拦启动） */
  async _reserve(models) {
    if (!Array.isArray(models) || models.length === 0) return null;
    const mod = await importLedgerModule();
    const reserve = pickFunction(mod, 'reserve');
    if (!reserve) {
      this.emit('warning', {
        message: `M4 ledger.mjs 还不能用（${describeModuleError(_ledgerLoadError)}）：本次启动没有预留显存`,
      });
      return null;
    }

    const leases = [];
    for (const model of models) {
      try {
        const lease = await reserve(model);
        if (lease) leases.push(lease);
      } catch (err) {
        this.emit('warning', { message: `预留显存失败（${model?.id}）：${err.message}` });
      }
    }
    if (leases.length === 0) return null;
    return {
      async release(reason = '') {
        for (const lease of leases) {
          try {
            if (typeof lease?.release === 'function') await lease.release(reason);
            else if (typeof lease === 'function') await lease(reason);
          } catch {
            /* 归还失败不阻塞停止：账本只是建议 */
          }
        }
      },
    };
  }

  /** 把实例快照落到 instances.json（走 M1 的 saveInstances；没有就静默跳过） */
  _schedulePersist() {
    if (!this.persist || this._persistDisabled || this._disposed) return;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      void this._persistNow();
    }, 200);
    this._persistTimer.unref?.();
  }

  async _persistNow() {
    if (!this.persist || this._persistDisabled || this._disposed) return;
    const snapshot = {};
    for (const rt of this._instances.values()) snapshot[rt.id] = rt.persistShape();

    try {
      const mod = await importRegistryModule();
      const saveInstances = pickFunction(mod, 'saveInstances');
      if (!saveInstances) {
        // M1 还没写完：只提示一次，之后不再刷屏
        this._persistDisabled = true;
        this.emit('warning', {
          message: `M1 registry.mjs 还没有 saveInstances()，实例状态不会落盘（${describeModuleError(_registryLoadError)}）`,
        });
        return;
      }
      // M1 的 saveInstances 校验不过时**不落盘但也不抛**，只返回 { ok:false, errors }。
      // 这里必须把结果看一眼，否则「状态没存下来」这件事会完全静默。
      const result = await saveInstances(snapshot);
      if (result && result.ok === false) {
        const detail = (result.errors ?? [])
          .map((item) => item?.message ?? String(item))
          .join('；');
        this.emit('warning', { message: `instances.json 没写进去：${detail || '校验失败'}` });
      }
    } catch (err) {
      this.emit('warning', { message: `写 instances.json 失败：${err.message}` });
    }
  }

  /**
   * 从 instances.json 认回上次的实例（LACI 重启后）。
   * 记成 starting 的按 ready 处理，让对账去判真伪——总比永远卡在 starting 好。
   */
  async restore() {
    const mod = await importRegistryModule();
    const loadInstances = pickFunction(mod, 'loadInstances');
    if (!loadInstances) {
      throw new RuntimeError(
        `M1 registry.mjs 还不能用（${describeModuleError(_registryLoadError)}）：无法认回实例`,
      );
    }

    const records = (await loadInstances()) ?? {};
    const restored = [];
    let dropped = 0;

    for (const [id, record] of Object.entries(records)) {
      if (!record || this._instances.has(id)) continue;
      // error 记录只是历史：进程早没了，认回来等于给界面塞一条假的"空闲实例"，
      // 而且它占着端口号，会让下一次分配从 18096 开始爬。直接丢，写盘时自然消失。
      if (record.phase === 'error') {
        dropped += 1;
        continue;
      }
      try {
        const engine = await this._requireEngine(record.engineId);
        const models = await this._requireModels(record.modelIds ?? []);
        const phase = record.phase === 'ready' || record.phase === 'starting' ? 'ready' : 'idle';
        const rt = this.create({
          id,
          engine,
          models,
          port: record.port ?? null,
          phase,
          pid: record.pid ?? null,
          startedAt: record.startedAt ?? null,
          ephemeral: Boolean(record.ephemeral),
        });
        restored.push(rt);
      } catch (err) {
        this.emit('warning', { message: `认回实例 ${id} 失败：${err.message}` });
      }
    }
    if (dropped > 0) {
      this.emit('warning', { message: `丢掉了 ${dropped} 条 error 实例记录（进程早已退出，只留作历史）` });
      this._schedulePersist();
    }

    // 立刻对一次账：上次留下的 pid/端口是真是假，20 秒内就能说清
    if (restored.length > 0) await this.reconcileNow();
    return restored.map((rt) => rt.status());
  }

  /* ---------- 收尾 ---------- */

  /** 关定时器 + 停所有进程（测试/退出时用） */
  async dispose({ kill = true } = {}) {
    this._disposed = true;
    this.stopReconciler();
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }

    const all = this.list();
    this._instances.clear();
    await Promise.allSettled(
      all.map(async (rt) => {
        if (kill) await rt.stop({ force: true, graceMs: 2000 });
        else rt.detach();
        rt.removeAllListeners();
      }),
    );
    this.removeAllListeners();
  }
}

/* ==========================================================================
 * 默认单例（M6 直接用这一个）
 * ========================================================================== */

let _defaultManager = null;

export function getRuntimeManager(options = {}) {
  if (!_defaultManager) {
    // 单例默认把 20 秒对账开起来：server.mjs 只管起 HTTP，没有别的地方会记得开这个定时器。
    _defaultManager = new RuntimeManager({ autoStartReconciler: true, ...options });
  }
  return _defaultManager;
}

/** 测试用：丢掉单例（不会自动杀进程，调用方自己先 dispose） */
export function resetRuntimeManager() {
  _defaultManager = null;
}

/* ==========================================================================
 * 模块级便捷函数（server.mjs / M5 网关按名字找的就是这些）
 * ========================================================================== */

/** 按实例 id 取运行时对象（给 M5 的 getInstance/getRuntime 探测用） */
export function getInstance(instanceId) {
  return getRuntimeManager().get(instanceId);
}

/** 重启一个实例（M5 自愈、M6「保存并重启」）；没有这个实例就抛，别静默返回 */
export async function restartInstance(instanceId, options = {}) {
  const rt = getInstance(instanceId);
  if (!rt) throw new RuntimeError(`没有实例 ${instanceId}`);
  await rt.restart(options);
  return rt.status();
}

/**
 * 停掉本进程拉起来的所有引擎（server.mjs 的 SIGINT/SIGTERM 收尾用）。
 * 只停进程、不删实例记录——实例表由 M1/M4 负责落盘，收尾阶段不折腾它。
 *
 * @returns {Promise<number>} 停掉了几个
 */
export async function stopAllInstances(options = {}) {
  const manager = getRuntimeManager();
  manager.stopReconciler();
  const all = manager.list();
  await Promise.allSettled(all.map((rt) => rt.stop({ force: true, graceMs: 2000, ...options })));
  return all.length;
}
