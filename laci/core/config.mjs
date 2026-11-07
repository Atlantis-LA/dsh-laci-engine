/**
 * core/config.mjs —— M1 数据层（1/2）：全局配置、密钥、数据目录、原子读写
 * ==========================================================================
 * 这一层是**唯一允许碰 data/*.json 的地方**（主文档 §4）。其它模块只调这里的函数，
 * 不许自己 readFile / writeFile —— 否则路径、编码、原子性、默认值各写一套，早晚对不上。
 *
 * 四条约定（别的模块照着用）：
 *
 * 1. **全同步**。
 *    数据文件只有几 KB，同步读写的代价可以忽略；换来的是「校验 → 写盘」在同一个
 *    tick 里做完，不会被别的请求插进来（Node 单线程，同步就没有交错）。
 *    同步 API 也能被 `await` 包着调（await 一个非 Promise 值是合法的），
 *    所以调用方写 `listEngines()` 或 `await listEngines()` 都行 —— 兼容两种习惯。
 *
 * 2. **原子写**。
 *    先写 `<文件>.<pid>.<序号>.tmp`，fsync 之后再 rename 覆盖。同一卷上的 rename
 *    是原子的，所以并发写只会"后写者赢"，不会出现半截 JSON。
 *    临时名带 pid + 序号：两个进程同时写也不会互相覆盖临时文件。
 *    先 fsync 再 rename：否则停电后可能出现"名字换了、内容还没落盘"的空文件。
 *
 * 3. **不缓存**。
 *    用户手改 JSON 之后立刻生效，比省那几次 stat 重要。数据量小（几十个文件），
 *    网关每次请求读一个模型文件也不慢；真要优化是 M5 的事，不是数据层偷偷缓存。
 *
 * 4. **坏 JSON 不吞**。
 *    读不出来就抛（消息里带完整路径），由调用方决定是跳过还是报错。
 *    list* 那种"列一批"的接口会跳过坏文件，并把原因放进 getLoadIssues()（见 registry.mjs）。
 *
 * 数据目录（主文档 §13.2）：
 *   %USERPROFILE%\.dsh\laci-new\config.json            全局项
 *   %USERPROFILE%\.dsh\laci-new\data\engines\*.json    引擎定义
 *   %USERPROFILE%\.dsh\laci-new\data\models\*.json     模型定义
 *   %USERPROFILE%\.dsh\laci-new\data\instances.json    运行时实例
 *   %USERPROFILE%\.dsh\laci-new\data\secrets.json      API key（永不导出）
 *   %USERPROFILE%\.dsh\laci-new\data\presets.json      参数预设
 *
 * 环境变量 LACI_HOME 可以整体改掉上面那个根目录 —— 验收测试、并行开发时别污染真数据。
 *
 * 返回值约定（和 registry.mjs 一致）：
 *   读：对象 / 数组 / Map 本体，找不到返回 null（或 {}）
 *   写：{ ok, errors[], warnings[], details[] }，外加写成功后的实体
 *   errors 是给人看的字符串（带字段前缀）；details 是同一批问题拆成
 *   { level, field, message } 的结构化版本，供界面把红字标到具体那一行。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PRODUCT_DIR = 'laci-new'

// ---------------------------------------------------------------------------
// 目录与路径
// ---------------------------------------------------------------------------

/**
 * 数据根目录。默认 `%USERPROFILE%\.dsh\laci-new`，可被 `LACI_HOME` 覆盖。
 * 每次调用都重新算：测试里改 process.env.LACI_HOME 之后立刻生效。
 */
export function homeDir() {
  const override = process.env.LACI_HOME
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim())
  const profile = process.env.USERPROFILE || os.homedir()
  return path.join(profile, '.dsh', PRODUCT_DIR)
}

export function dataDir() {
  return path.join(homeDir(), 'data')
}

export function configFile() {
  return path.join(homeDir(), 'config.json')
}

export function enginesDir() {
  return path.join(dataDir(), 'engines')
}

export function modelsDir() {
  return path.join(dataDir(), 'models')
}

export function instancesFile() {
  return path.join(dataDir(), 'instances.json')
}

export function secretsFile() {
  return path.join(dataDir(), 'secrets.json')
}

export function presetsFile() {
  return path.join(dataDir(), 'presets.json')
}

/**
 * 每个实例的日志文件目录（M2 用；logs 不是 JSON，M1 只负责建目录）。
 * 放在数据根目录下、和 data/ 平级，与 M2 的 defaultLogDir() 保持同一个位置。
 */
export function logsDir() {
  return path.join(homeDir(), 'logs')
}

/**
 * 建好目录结构。幂等，重复调用无害。
 * 第一次启动（用户刚装好）和每次写文件前都会走这里，省掉一堆 ENOENT 判断。
 */
export function ensureDataLayout() {
  for (const dir of [homeDir(), dataDir(), enginesDir(), modelsDir(), logsDir()]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return dataDir()
}

// ---------------------------------------------------------------------------
// 通用工具（registry.mjs 也用这几个，避免两边判断标准漂移）
// ---------------------------------------------------------------------------

/** JSON 里的对象：排除 null / 数组。 */
export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** 1–65535 的整数。 */
export function isPortNumber(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

export function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 深拷贝。structuredClone 是 Node 17+ 内置，比 JSON 往返更能保住 undefined / 类型。 */
export function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value)
}

/** 把任意值压成一行错误文案里的预览，太长就截断（错误消息不该刷屏）。 */
export function previewValue(value) {
  if (typeof value === 'string') return value.length > 40 ? `${value.slice(0, 40)}…` : value
  if (value === undefined) return 'undefined'
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return String(value)
    return text.length > 40 ? `${text.slice(0, 40)}…` : text
  } catch {
    return String(value)
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * id → 文件名。它必须能安全地当文件名用，否则 `../../x` 就能写到数据目录外面去。
 * 允许中文（`\p{L}`），但只许"字母/数字/. _ -"，且必须以字母或数字开头；
 * Windows 会偷偷吞掉结尾的点和保留设备名，所以这两类单独挡掉。
 */
const ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u
const RESERVED_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul', 'clock$',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export function isSafeId(id) {
  if (typeof id !== 'string') return false
  if (!ID_RE.test(id)) return false
  if (id.endsWith('.')) return false
  if (RESERVED_DEVICE_NAMES.has(id.toLowerCase())) return false
  return true
}

/**
 * 清理用户粘贴的路径：去掉两端空白，以及**两端的双引号**。
 *
 * Windows 路径本身不能含 `"`，所以剥掉是安全的；而资源管理器
 * 「复制文件地址」给出的正是 `"D:\...\model.ninfer"`，用户粘贴进来
 * 就带引号，原样传给引擎会得到「这不是 .ninfer 文件」这种莫名其妙的报错
 * （2026-11-06 现场：模型 id=2 就是这么失败的）。
 *
 * 只剥双引号，不碰单引号 —— 单引号是合法文件名字符（`it's model.ninfer`）。
 */
export function cleanPath(value) {
  if (typeof value !== 'string') return value
  let out = value.trim()
  // 最多剥三层：用户可能粘了带引号的引号（复制一段命令行时）
  for (let i = 0; i < 3; i += 1) {
    const before = out
    if (out.startsWith('"')) out = out.slice(1).trimStart()
    if (out.endsWith('"')) out = out.slice(0, -1).trimEnd()
    if (out === before) break
  }
  return out
}

/** 写路径时用这个：不安全的 id 必须当场炸，不能悄悄拼出一个越界路径。 */
export function assertSafeId(id, label = 'id') {
  if (isSafeId(id)) return id
  const error = new TypeError(
    `非法的 ${label}：${previewValue(id)}。它会被当成文件名，只能用字母、数字、"."、"_"、"-"，且以字母或数字开头`,
  )
  error.code = 'E_BAD_ID'
  throw error
}

// ---------------------------------------------------------------------------
// 错误 / 警告收集器
// ---------------------------------------------------------------------------

/**
 * 两个模块共用同一种「错误 + 警告」结构，API 层才不用为每个模块各写一套映射。
 *
 * errors / warnings 是给人看的整句（带 `字段：` 前缀）；
 * details 是同一批问题的结构化版本，界面靠 field 把红字标到具体那一行。
 *
 * 特例：有些报错文案是任务书里定死的整句（比如「缺少必需的槽位：模型主文件」），
 * 这时传 field = ''，把结构化字段放进 extra.field，文案里就不会多出前缀。
 */
export function issueCollector() {
  const errors = []
  const warnings = []
  const details = []

  function push(level, field, message, extra) {
    details.push({ level, field: field || null, message, ...(extra || {}) })
    const text = field ? `${field}：${message}` : message
    if (level === 'error') errors.push(text)
    else warnings.push(text)
  }

  return {
    errors,
    warnings,
    details,
    error(field, message, extra) {
      push('error', field, message, extra)
    },
    warn(field, message, extra) {
      push('warning', field, message, extra)
    },
    result(extra) {
      return { ok: errors.length === 0, errors, warnings, details, ...(extra || {}) }
    },
  }
}

// ---------------------------------------------------------------------------
// 原子读写
// ---------------------------------------------------------------------------

let tmpSequence = 0
const RENAME_RETRIES = 3
const RENAME_RETRY_MS = 15

function sleepSync(ms) {
  // Node 主线程没有 sleepSync；Atomics.wait 能精确停一下。只在重试路径上用，正常路径 0 次。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      // Windows：目标正好被别的进程读/扫（杀毒、索引器）时 rename 会 EPERM/EBUSY。
      // 短暂重试；三次还不行就把错误抛出去 —— 绝不能退化成"直接覆盖写"，那就不是原子写了。
      const code = error && error.code
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!transient || attempt >= RENAME_RETRIES) throw error
      sleepSync(RENAME_RETRY_MS)
    }
  }
}

/**
 * 原子写文本：临时文件 → fsync → rename。
 * 目录不存在会自动建（第一次保存时省得调用方到处 mkdir）。
 */
export function atomicWriteFile(file, text, options = {}) {
  const mode = options.mode ?? 0o600
  fs.mkdirSync(path.dirname(file), { recursive: true })

  const tmp = `${file}.${process.pid}.${(tmpSequence += 1)}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, 'w', mode)
    fs.writeFileSync(fd, text, { encoding: 'utf8' })
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    renameWithRetry(tmp, file)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        /* 已经关了，忽略 */
      }
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件可能根本没建出来，忽略 */
    }
    throw error
  }
}

/**
 * 写 JSON。固定 2 空格缩进 + 结尾换行：这些文件是给人看/手改的，
 * 也要让 git diff / 导出对比干净。
 */
export function writeJsonAtomic(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
  return value
}

/**
 * 读 JSON。
 * - 文件不存在 → 返回 fallback（第一次启动的常见情况）
 * - 文件是空的（或只有空白/BOM）→ 也返回 fallback：用户新建了空文件不算"坏"
 * - 解析失败 → 抛，消息带路径。**不吞**：坏文件必须被看见，否则界面会"看起来没数据"。
 */
export function readJson(file, fallback) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback
    throw error
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // 记事本会加 BOM
  if (text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch (error) {
    const wrapped = new Error(`${file} 不是合法 JSON：${error.message}`)
    wrapped.code = 'E_BAD_JSON'
    wrapped.file = file
    throw wrapped
  }
}

// ---------------------------------------------------------------------------
// 全局配置（config.json）
// ---------------------------------------------------------------------------

/**
 * 默认值。数字全部来自主文档/任务书里已经定死的那些：
 *   3101 控制台 / 8095 网关（00-总纲 §三）
 *   18095 起、最多试 20 个（§5.9、M4）
 *   判活 300000ms、间隔 900ms（§5.2 的 ninfer 实测）
 *   网关空闲 180s / 总 15min（M5）
 *   试启动每 3 秒扫端口、抓前 200 行（§5.5）
 *   对账 20s、连续 2 次失败才判死（M2）
 *   空闲卸载 60s（M2）
 *   自愈连续 2 次、90s 去抖（M5）
 *   停机宽限 5000ms（§5.2 的 stop.graceMs）
 *   DSH provider 的 id / 显示名 / apiKeyEnv（§5.11）
 *
 * 这里只放"全局只有一份"的东西。引擎/模型各自的参数不放这里 ——
 * 那些属于档案（§5.1.1：端口、判活属于引擎；上下文、KV 属于模型）。
 */
export const DEFAULT_CONFIG = deepFreeze({
  host: '127.0.0.1',
  consolePort: 3101,
  gatewayPort: 8095,
  pythonPath: null,
  ports: { base: 18095, maxTries: 20 },
  ready: { timeoutMs: 300000, intervalMs: 900 },
  gateway: { idleTimeoutMs: 180000, totalTimeoutMs: 900000 },
  probe: { portScanIntervalMs: 3000, logTailLines: 200, stallMs: 30000 },
  reconcile: { intervalMs: 20000, probeTimeoutMs: 2000, failuresBeforeDead: 2 },
  idleUnload: { intervalMs: 60000 },
  selfHeal: { afterFailures: 2, debounceMs: 90000 },
  stop: { graceMs: 5000 },
  dsh: { providerId: 'kvmem-local', displayName: 'LACI', apiKeyEnv: 'KVMM_LOCAL_API_KEY' },
})

/**
 * 补齐默认值。**只补缺失的键，不改已有值的类型** ——
 * 类型错了留给 validateConfig 报，不在归一化阶段悄悄纠正（否则用户永远不知道自己写错了）。
 * 未知键原样保留：以后加配置项时，旧版本代码不该把它吃掉。
 */
export function normalizeConfig(input) {
  const base = cloneJson(DEFAULT_CONFIG)
  if (!isPlainObject(input)) return base

  const out = {}
  for (const [key, defaultValue] of Object.entries(base)) {
    const given = input[key]
    if (given === undefined) out[key] = defaultValue
    else if (isPlainObject(defaultValue) && isPlainObject(given)) out[key] = { ...defaultValue, ...given }
    else out[key] = given
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(out, key)) out[key] = value
  }
  return out
}

function requireMs(obj, base, key, label, c) {
  if (!isPositiveNumber(obj[key])) {
    c.error(`${base}.${key}`, `${label}必须是正数（毫秒），现在是 \`${previewValue(obj[key])}\``)
  }
}

function requireInt(obj, base, key, label, min, max, c) {
  const value = obj[key]
  if (!Number.isInteger(value) || value < min || value > max) {
    c.error(`${base}.${key}`, `${label}必须是 ${min}–${max} 的整数，现在是 \`${previewValue(value)}\``)
  }
}

/** 配置校验。M6 的「保存设置」可以先调它，把 errors[] 直接回给界面。 */
export function validateConfig(input) {
  const c = issueCollector()
  if (!isPlainObject(input)) {
    c.error('', 'config.json 必须是一个 JSON 对象')
    return c.result()
  }
  const cfg = normalizeConfig(input)

  if (!isNonEmptyString(cfg.host)) c.error('host', '必须是监听地址，如 127.0.0.1')
  else if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost') {
    c.warn('host', `是 \`${cfg.host}\`：控制台和网关会监听在非回环地址上，局域网能访问到`)
  }

  for (const [key, label] of [
    ['consolePort', '控制台端口'],
    ['gatewayPort', '网关端口'],
  ]) {
    if (!isPortNumber(cfg[key])) {
      c.error(key, `${label}必须是 1–65535 的整数，现在是 \`${previewValue(cfg[key])}\``)
    }
  }
  if (isPortNumber(cfg.consolePort) && cfg.consolePort === cfg.gatewayPort) {
    c.error('gatewayPort', `和 consolePort 都是 ${cfg.consolePort}：两个服务会抢同一个端口`)
  }

  if (!isPlainObject(cfg.ports)) c.error('ports', '必须是对象')
  else {
    if (!isPortNumber(cfg.ports.base)) {
      c.error('ports.base', `引擎端口基址必须是 1–65535 的整数，现在是 \`${previewValue(cfg.ports.base)}\``)
    }
    requireInt(cfg.ports, 'ports', 'maxTries', '端口往上找的次数', 1, 1000, c)
  }

  if (!isPlainObject(cfg.ready)) c.error('ready', '必须是对象')
  else {
    requireMs(cfg.ready, 'ready', 'timeoutMs', '判活超时', c)
    requireMs(cfg.ready, 'ready', 'intervalMs', '判活间隔', c)
    if (isPositiveNumber(cfg.ready.timeoutMs) && isPositiveNumber(cfg.ready.intervalMs)
      && cfg.ready.intervalMs >= cfg.ready.timeoutMs) {
      c.warn('ready', 'intervalMs 不小于 timeoutMs：第一次探测之前就已经超时了')
    }
  }

  if (!isPlainObject(cfg.gateway)) c.error('gateway', '必须是对象')
  else {
    requireMs(cfg.gateway, 'gateway', 'idleTimeoutMs', '空闲超时', c)
    requireMs(cfg.gateway, 'gateway', 'totalTimeoutMs', '总时长超时', c)
    if (isPositiveNumber(cfg.gateway.idleTimeoutMs) && isPositiveNumber(cfg.gateway.totalTimeoutMs)
      && cfg.gateway.idleTimeoutMs >= cfg.gateway.totalTimeoutMs) {
      c.warn('gateway', 'idleTimeoutMs 不小于 totalTimeoutMs：总时长那条永远不会先生效')
    }
  }

  if (!isPlainObject(cfg.probe)) c.error('probe', '必须是对象')
  else {
    requireMs(cfg.probe, 'probe', 'portScanIntervalMs', '试启动扫端口间隔', c)
    requireMs(cfg.probe, 'probe', 'stallMs', '试启动卡住判定', c)
    requireInt(cfg.probe, 'probe', 'logTailLines', '试启动抓的日志行数', 10, 10000, c)
  }

  if (!isPlainObject(cfg.reconcile)) c.error('reconcile', '必须是对象')
  else {
    requireMs(cfg.reconcile, 'reconcile', 'intervalMs', '对账周期', c)
    requireMs(cfg.reconcile, 'reconcile', 'probeTimeoutMs', '对账探测超时', c)
    requireInt(cfg.reconcile, 'reconcile', 'failuresBeforeDead', '判死前允许的失败次数', 1, 100, c)
  }

  if (!isPlainObject(cfg.idleUnload)) c.error('idleUnload', '必须是对象')
  else requireMs(cfg.idleUnload, 'idleUnload', 'intervalMs', '空闲卸载检查周期', c)

  if (!isPlainObject(cfg.selfHeal)) c.error('selfHeal', '必须是对象')
  else {
    requireInt(cfg.selfHeal, 'selfHeal', 'afterFailures', '触发自愈的连续失败次数', 1, 100, c)
    if (!isNonNegativeNumber(cfg.selfHeal.debounceMs)) {
      c.error('selfHeal.debounceMs', `自愈去抖必须是 ≥ 0 的毫秒数，现在是 \`${previewValue(cfg.selfHeal.debounceMs)}\``)
    }
  }

  if (!isPlainObject(cfg.stop)) c.error('stop', '必须是对象')
  else if (!isNonNegativeNumber(cfg.stop.graceMs)) {
    c.error('stop.graceMs', `停机宽限必须是 ≥ 0 的毫秒数，现在是 \`${previewValue(cfg.stop.graceMs)}\``)
  }

  if (!isPlainObject(cfg.dsh)) c.error('dsh', '必须是对象')
  else {
    for (const [key, label] of [
      ['providerId', 'DSH provider id'],
      ['displayName', 'DSH 显示名'],
      ['apiKeyEnv', 'DSH apiKey 环境变量名'],
    ]) {
      if (!isNonEmptyString(cfg.dsh[key])) c.error(`dsh.${key}`, `${label}必须是非空字符串`)
    }
  }

  if (cfg.pythonPath != null) {
    if (!isNonEmptyString(cfg.pythonPath)) c.error('pythonPath', '必须是 Python 路径字符串或 null')
    else if (!path.isAbsolute(cfg.pythonPath)) c.warn('pythonPath', '建议写绝对路径')
    else if (!fs.existsSync(cfg.pythonPath)) {
      c.warn('pythonPath', `文件不存在：\`${cfg.pythonPath}\`（.py 引擎没写 interpreter 时会用到它）`)
    }
  }

  // 密钥不属于 config.json：它会被用户打开看、也会跟着配置导出。
  for (const key of ['apiKey', 'api_key', 'apikey', 'secrets', 'tokens']) {
    if (Object.hasOwn(cfg, key)) {
      c.warn(key, 'config.json 是给人看/导出的文件：密钥请放 data/secrets.json 或环境变量（saveSecret）')
    }
  }

  return c.result()
}

/**
 * 读配置。缺文件/空文件 → 全套默认值。
 * 不在这里做校验：不想因为一个不影响启动的字段写错就把进程卡死；
 * 需要严格校验的调用方（M6 保存设置时）自己调 validateConfig()。
 */
export function loadConfig() {
  const stored = readJson(configFile(), {})
  if (!isPlainObject(stored)) throw new Error(`config.json 必须是 JSON 对象：${configFile()}`)
  return normalizeConfig(stored)
}

/**
 * 存配置。原子写。校验不过直接抛 TypeError（保存一份跑不起来的配置没有意义），
 * err.errors 里带 errors[]，M6 可以映射成 400。正常返回保存后的完整配置对象。
 */
export function saveConfig(cfg) {
  if (!isPlainObject(cfg)) {
    const invalid = new TypeError('config 必须是一个 JSON 对象')
    invalid.code = 'E_CONFIG_INVALID'
    invalid.errors = ['config 必须是一个 JSON 对象']
    throw invalid
  }
  const normalized = normalizeConfig(cfg)
  const checked = validateConfig(normalized)
  if (!checked.ok) {
    const error = new TypeError(`config 校验失败：${checked.errors.join('；')}`)
    error.code = 'E_CONFIG_INVALID'
    error.errors = checked.errors
    throw error
  }
  ensureDataLayout()
  writeJsonAtomic(configFile(), normalized)
  return normalized
}

// ---------------------------------------------------------------------------
// 密钥（secrets.json）
// ---------------------------------------------------------------------------

/**
 * 读全部密钥：`{ 引擎id: "sk-..." }`。
 * 只有网关/云端转发需要它；**任何 list / load 系列都不许把这里的内容并进引擎对象**，
 * 因为引擎定义是要导出、分享给别人的（§5.12）。
 */
export function loadSecrets() {
  const raw = readJson(secretsFile(), {})
  if (!isPlainObject(raw)) throw new Error(`secrets.json 必须是 { 引擎id: "key" } 对象：${secretsFile()}`)
  const out = {}
  for (const [engineId, key] of Object.entries(raw)) {
    if (typeof key !== 'string' || key.trim() === '') continue // 空值当"没配"
    out[engineId] = key.trim()
  }
  return out
}

/** 界面用来显示"已配置 / 未配置"，不需要把 key 本身拿出来。 */
export function hasSecret(engineId) {
  if (!isNonEmptyString(engineId)) return false
  return Object.hasOwn(loadSecrets(), engineId)
}

/**
 * 写一把密钥。key 传 null / 空串 = 删除。
 * 返回值里**只有"有没有配"**，不回显 key —— 免得被顺手打进日志或接口响应。
 */
export function saveSecret(engineId, key) {
  assertSafeId(engineId, 'engineId')
  const secrets = loadSecrets()

  if (key == null || (typeof key === 'string' && key.trim() === '')) {
    delete secrets[engineId]
  } else if (typeof key !== 'string') {
    throw new TypeError('key 必须是字符串；要删除这把 key 就传 null')
  } else {
    secrets[engineId] = key.trim()
  }

  ensureDataLayout()
  writeJsonAtomic(secretsFile(), secrets)
  return { ok: true, engineId, hasKey: Object.hasOwn(secrets, engineId) }
}

// ---------------------------------------------------------------------------
// 参数预设（presets.json）—— §5.3 说预设从 server.mjs 挪到数据里
// ---------------------------------------------------------------------------

/**
 * 任务书的函数表里没列这两个，但「其它模块只通过 M1 访问数据」是硬规则，
 * 所以预设的读写也放这里，免得 M3 自己开一个口子直接读文件。
 * 结构暂不锁死（按 kind / 名字分组的对象），M3 定下来再收紧校验。
 */
export function loadPresets() {
  const raw = readJson(presetsFile(), {})
  return isPlainObject(raw) ? raw : {}
}

export function savePresets(presets) {
  if (!isPlainObject(presets)) throw new TypeError('presets 必须是 JSON 对象')
  ensureDataLayout()
  writeJsonAtomic(presetsFile(), presets)
  return presets
}
