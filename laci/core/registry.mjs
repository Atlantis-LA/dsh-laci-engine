/**
 * core/registry.mjs —— M1 数据层（2/2）：引擎 / 模型 / 实例的读写与校验
 * ==========================================================================
 * 主文档 §4、§5.1–5.3、§5.9、§15。
 *
 * 三条硬规则（其它模块照这个用）：
 *
 * 1. **只通过这里访问 data/engines、data/models、data/instances**，不许自己读文件
 *    （主文档 §4：路径、校验、原子写只有一套实现）。
 *
 * 2. **全同步**。数据文件只有几 KB；同步让"校验 + 写盘"在同一个 tick 里完成，
 *    两个并发保存不会双双通过唯一性检查（Node 单线程，同步没有交错）。
 *    调用方写 `await` 也兼容 —— await 一个非 Promise 值是合法的。
 *    跨进程并发（两个 LACI 同时跑）靠原子 rename 兜：只会后写者赢，不会半截文件。
 *
 * 3. **校验（validate*）是纯函数**，不碰文件系统；**读盘检查（路径在不在、目录里有没有 expect）只发生在 save* 里**，
 *    结果进 warnings[]，**不拦保存**（§5.4.1：模型文件没拷过来先存着，等会儿再拷）。
 *
 * 返回值：
 *   读   listEngines() → Engine[]（坏文件被跳过，原因见 getLoadIssues()）
 *        loadEngine(id) → Engine | null（id 非法或文件不存在都返回 null，不越界拼路径）
 *        loadInstances() → { [instanceId]: Instance }（永远返回对象）
 *   写   save* / delete* → { ok, errors[], warnings[], details[], ...实体 }
 *        errors 是给人看的字符串；details 是 { level, field, message } 结构化版本，
 *        界面靠 field 把红字标到具体那一行（§5.4.1：错误必须指到具体那一个 `{}`）。
 *   validateEngine(e) / validateModel(m, engine) → { ok, errors, warnings, details }
 *        —— 任务书签名里的 { ok, errors[] } 是它的子集；warnings 是"标黄但允许保存"那条规则需要的。
 *
 * 三条容易踩的约定：
 *   · **文件名就是 id**（engines/<id>.json）。改 id = 换一个文件；内容里的 id 和文件名不一致时
 *     以文件名为准（load 时纠正，保存时写回一致）。
 *   · **id 全局唯一**按任务书理解为：模型 id 在所有引擎下唯一（跨引擎重名 = 网关路由会混），
 *     并且不和引擎 id 重名（同一个字符串别在两处当 id，界面上分不清谁是谁）。
 *   · **归一化只补默认值，不改类型**。类型写错留给 validate 报，不在这里悄悄纠正。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  enginesDir,
  modelsDir,
  instancesFile,
  ensureDataLayout,
  readJson,
  writeJsonAtomic,
  issueCollector,
  isPlainObject,
  isNonEmptyString,
  isPortNumber,
  isPositiveNumber,
  isNonNegativeNumber,
  isSafeId,
  cleanPath,
  previewValue,
  cloneJson,
} from './config.mjs'

// ---------------------------------------------------------------------------
// 枚举 / 常量（别的模块 import 这些，不要自己再抄一份字符串）
// ---------------------------------------------------------------------------

/** 状态机只有这五个（§4.2 / 00-总纲 §三）。 */
export const PHASES = Object.freeze(['idle', 'starting', 'ready', 'stopping', 'error'])

export const ENGINE_MODES = Object.freeze(['package', 'custom', 'remote'])
/** §14.2 的三种预留模式：只提示、不做检查，第一版跑不了。 */
export const FUTURE_ENGINE_MODES = Object.freeze(['attach', 'pty'])

export const ENGINE_KINDS = Object.freeze(['exe', 'bat', 'ps1', 'py', 'sh'])
export const SLOT_KINDS = Object.freeze(['file', 'dir'])

export const MODEL_KINDS = Object.freeze(['chat', 'asr', 'tts', 'image'])

export const THINKING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const STOP_METHODS = Object.freeze(['kill-tree', 'signal'])
export const FUTURE_STOP_METHODS = Object.freeze(['http', 'http-unload'])

export const AUTH_TYPES = Object.freeze(['bearer', 'none'])

/** 变量表里不能当槽位名的保留字（§5.2 变量表 + §5.3 的思考参数）。 */
export const RESERVED_VARS = Object.freeze(['host', 'port', 'modelId', 'engineDir', 'thinkingEffort', 'thinkingBudget'])

/**
 * 已知的数值参数。主文档 §5.3 的 params 示例 + §5.10 的预估公式用到的量。
 * 为什么要有这张表：引擎定义里没有"参数类型声明"的地方，只有一条 argv 模板；
 * 要执行「声明为数字的键，值必须是数字」这条规则，只能靠已知参数名兜。
 * 未知参数（引擎自己的私有参数）不做类型限制 —— 不知道类型就不该瞎拦。
 */
export const NUMERIC_PARAMS = Object.freeze({
  maxContext: { label: '上下文', integer: true, min: 1 },
  kvWindow: { label: 'KV 窗口', integer: true, min: 0 },
  kvHeadroomMib: { label: 'KV headroom', integer: true, min: 0 },
  kvCapacity: { label: 'KV 池容量', integer: true, min: 0 },
  prefillChunk: { label: '预填块', integer: true, min: 1 },
  hostKvMib: { label: '主机 KV', integer: true, min: 0 },
  runtimeReserveMib: { label: '运行时预留', integer: true, min: 0 }, // 引擎权重要之外还要的工作区（实测回填）
  draftTokens: { label: '草稿数', integer: true, min: 1, max: 15 }, // §5.6.1：--draft-tokens 1..15
  visionMaxMerged: { label: '视觉最大合并', integer: true, min: 1 },
  maxConcurrency: { label: '最大并发', integer: true, min: 1 },
  maxTokens: { label: '最大输出', integer: true, min: 1 },
})

export const BOOLEAN_PARAMS = Object.freeze(['mtp', 'vision', 'adaptiveMtp', 'lmHeadDraft'])

/** 引擎层做"像不像拼错"判断用的标准参数名（模型自己的 params 在引擎层是不知道的）。 */
export const KNOWN_PARAM_NAMES = Object.freeze([
  ...Object.keys(NUMERIC_PARAMS),
  ...BOOLEAN_PARAMS,
  'kvDtype',
  'visionResidency',
  'spec',
])

const DEFAULT_PORT_BASE = 18095
const DEFAULT_READY_TIMEOUT_MS = 300000
const DEFAULT_READY_INTERVAL_MS = 900
const DEFAULT_STOP_GRACE_MS = 5000
const JSON_SUFFIX = '.json'

const SLOT_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

const KIND_BY_EXT = Object.freeze({
  '.exe': 'exe',
  '.bat': 'bat',
  '.cmd': 'bat', // .cmd 在 Windows 上和 .bat 同类，交给同一条启动策略
  '.ps1': 'ps1',
  '.py': 'py',
  '.sh': 'sh',
})

/** 这些字段是密钥，不许出现在引擎文件里（引擎定义要能导出、分享，§5.12）。 */
const TOP_SECRET_FIELDS = Object.freeze(['apiKey', 'api_key', 'apikey'])
const AUTH_SECRET_FIELDS = Object.freeze(['apiKey', 'api_key', 'apikey', 'key', 'token', 'secret'])

// ---------------------------------------------------------------------------
// 类型说明（给其它模块看的契约，不是运行时代码）
// ---------------------------------------------------------------------------

/**
 * @typedef {object} FileSlot
 * @property {string} key            模板里写成 `{key}`（无 arg 时）
 * @property {string} label          界面上的名字，也是缺槽位报错里用的名字
 * @property {'file'|'dir'} kind     选文件还是选文件夹
 * @property {string|null} [arg]     有 arg = 系统自动拼 `--flag <路径>`，模板里**不许**再写 `{key}`（D2）
 * @property {boolean} [optional]    可以留空；为空时连它的 flag 一起跳过（§5.2）
 * @property {string[]} [expect]     kind=dir 时，目录里应该有哪些文件（只查"像不像 pack"）
 */

/**
 * @typedef {object} Engine
 * @property {string} id
 * @property {string} label
 * @property {'package'|'custom'|'remote'} mode
 * @property {'exe'|'bat'|'ps1'|'py'|'sh'|null} kind
 * @property {string} file
 * @property {string} cwd
 * @property {string|null} interpreter   每个引擎可以有自己的 venv；null = 用 config.pythonPath
 * @property {number|null} defaultPort
 * @property {FileSlot[]} fileSlots
 * @property {string[]} argv
 * @property {Record<string, string|number|boolean>} env
 * @property {Array} middlewares
 * @property {string|null} webUI
 * @property {string|null} footprintLog
 * @property {{ url: string, timeoutMs: number, intervalMs: number, type?: string }} ready
 * @property {{ method: string, graceMs: number }} stop
 * @property {boolean} multiInstance      默认 false：保守 —— 误开第二个会把卡打爆（§5.9）
 * @property {boolean} supportsMultiModel 默认 false（D1：只支持单槽位引擎）
 * @property {string|null} modelsArg      多模型时拼成 `--models a,b`
 * @property {string} why                 为什么这么写（§5.9 的 "why" 字段）
 * @property {string} [baseURL]           mode=remote
 * @property {{ type: string, keyRef: string }} [auth]  mode=remote，keyRef 只是 secrets 的键名
 * @property {string|null} [apiKeyEnv]    mode=remote，环境变量优先（§5.12）
 * @property {Array<{id: string, contextWindow?: number, maxTokens?: number}>} [models]  mode=remote
 */

/**
 * @typedef {object} Model
 * @property {string} id
 * @property {string} label
 * @property {'chat'|'asr'|'tts'|'image'} kind
 * @property {string} engineId
 * @property {Record<string, string>} files     键 ⊆ 引擎 fileSlots 的键
 * @property {number|null} port                  不给就用引擎 defaultPort 往上找
 * @property {{ mtp: boolean|null, vision: boolean|null, tools: boolean|null }} caps
 * @property {Record<string, string|number|boolean|null>} params
 * @property {{ effort: string|null, budget: number|null, allowRequestOverride: boolean }} thinking
 * @property {string[]} extraArgs
 * @property {string|null} engineModelId         D3：一个进程只有一个 --model-id，不写就等于 id
 * @property {object|null} footprint             M4 回填的实测显存
 */

/**
 * @typedef {object} Instance
 * @property {string} engineId
 * @property {string[]} modelIds
 * @property {number|null} port
 * @property {number|null} pid
 * @property {'idle'|'starting'|'ready'|'stopping'|'error'} phase
 * @property {boolean} ephemeral
 * @property {number|null} startedAt            毫秒时间戳
 */

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const modelPath = (id) => path.join(modelsDir(), `${id}${JSON_SUFFIX}`)
const enginePath = (id) => path.join(enginesDir(), `${id}${JSON_SUFFIX}`)

function sortByLabel(items) {
  return items.sort((a, b) => {
    const left = String(a.label || a.id)
    const right = String(b.label || b.id)
    return left.localeCompare(right, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
      || String(a.id).localeCompare(String(b.id))
  })
}

/** 列出目录里所有 `<id>.json` 的 id（不含扩展名）。目录不存在当空目录。 */
function jsonStems(dir) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const stems = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    if (!name.toLowerCase().endsWith(JSON_SUFFIX)) continue
    stems.push(name.slice(0, -JSON_SUFFIX.length))
  }
  return stems
}

/** 非字符串原样留下交给校验，字符串去首尾空格（用户从资源管理器复制路径常带空格）。 */
function keepText(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value.trim() : value
}

function inferKind(file) {
  if (!isNonEmptyString(file)) return null
  return KIND_BY_EXT[path.extname(file).toLowerCase()] ?? null
}

/** 没填 cwd 时用启动文件所在目录 —— 这是"双击 bat"最接近的语义。 */
function defaultCwd(file) {
  if (!isNonEmptyString(file)) return ''
  if (!path.isAbsolute(file)) return ''
  return path.dirname(file)
}

function countVar(texts, name) {
  let total = 0
  for (const text of texts) {
    if (typeof text !== 'string') continue
    for (const match of text.matchAll(/\{([^{}]*)\}/g)) {
      if (match[1] === name) total += 1
    }
  }
  return total
}

/** 扫一段模板：返回变量名列表，以及有没有没配对的单个 `{` / `}`。 */
function scanTemplate(text) {
  const vars = []
  for (const match of text.matchAll(/\{([^{}]*)\}/g)) vars.push(match[1])
  const unmatched = /[{}]/.test(text.replace(/\{[^{}]*\}/g, ''))
  return { vars, unmatched }
}

function editDistance(a, b) {
  if (a === b) return 0
  const left = [...a]
  const right = [...b]
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    previous = current
  }
  return previous[right.length]
}

/**
 * 近似纠错（§5.4.1）：仅大小写差异优先，其次是编辑距离 ≤ 2 的名字。
 * 返回最像的那个候选，没有就返回 null（不猜）。
 */
function closestName(name, candidates) {
  const lower = name.toLowerCase()
  let best = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) continue
    const candidateLower = candidate.toLowerCase()
    let score
    if (candidateLower === lower) {
      score = 0
    } else {
      const distance = editDistance(lower, candidateLower)
      if (distance > 2) continue
      score = distance + 0.5 // 大小写差异(0) 永远压过"少打一个字母"(1.5)
    }
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best
}

function checkPositive(obj, base, key, label, c) {
  if (!isPositiveNumber(obj[key])) {
    c.error(`${base}.${key}`, `${label}必须是正数（毫秒），现在是 \`${previewValue(obj[key])}\``)
  }
}

// ---------------------------------------------------------------------------
// 引擎：归一化
// ---------------------------------------------------------------------------

function emptyEngine() {
  return {
    id: '',
    label: '',
    mode: 'custom',
    kind: null,
    file: '',
    cwd: '',
    interpreter: null,
    defaultPort: DEFAULT_PORT_BASE,
    fileSlots: [],
    argv: [],
    // 能力开关 → 命令行片段（视觉/投机这类"模型说开不开、引擎知道怎么拼"的东西）
    capabilityArgs: {},
    deviceProfileArg: null,
    env: {},
    middlewares: [],
    webUI: null,
    footprintLog: null,
    ready: { url: 'http://127.0.0.1:{port}/v1/models', timeoutMs: DEFAULT_READY_TIMEOUT_MS, intervalMs: DEFAULT_READY_INTERVAL_MS },
    stop: { method: 'kill-tree', graceMs: DEFAULT_STOP_GRACE_MS },
    multiInstance: false,
    supportsMultiModel: false,
    modelsArg: null,
    why: '',
  }
}

function stripSecretsFromObject(target, removed) {
  if (!isPlainObject(target)) return target
  for (const name of TOP_SECRET_FIELDS) {
    if (Object.hasOwn(target, name)) {
      delete target[name]
      if (removed) removed.push(name)
    }
  }
  if (isPlainObject(target.auth)) {
    for (const name of AUTH_SECRET_FIELDS) {
      if (Object.hasOwn(target.auth, name)) {
        delete target.auth[name]
        if (removed) removed.push(`auth.${name}`)
      }
    }
  }
  return target
}

function normalizeSlot(raw) {
  if (!isPlainObject(raw)) return raw // 结构坏了交给校验报，不在归一化阶段猜
  const out = { ...cloneJson(raw) }
  out.key = isNonEmptyString(raw.key) ? raw.key.trim() : keepText(raw.key)
  out.label = isNonEmptyString(raw.label) ? raw.label.trim() : (isNonEmptyString(out.key) ? out.key : '')
  out.kind = isNonEmptyString(raw.kind) ? raw.kind.trim().toLowerCase() : 'file'
  // 空字符串 = 没写 arg（位置参数）。用 null 表示，后面所有判断只看 !== null。
  out.arg = raw.arg == null || raw.arg === '' ? null : keepText(raw.arg)
  out.optional = raw.optional === true
  out.expect = raw.expect == null
    ? []
    : (Array.isArray(raw.expect)
      ? raw.expect.map((name) => (typeof name === 'string' ? name.trim() : name))
      : raw.expect)
  return out
}

function normalizeReady(raw, mode) {
  if (raw == null) {
    return {
      url: mode === 'remote' ? '' : 'http://127.0.0.1:{port}/v1/models',
      timeoutMs: DEFAULT_READY_TIMEOUT_MS,
      intervalMs: DEFAULT_READY_INTERVAL_MS,
      type: 'http',
    }
  }
  if (!isPlainObject(raw)) return raw // 结构坏了，交给校验
  const out = { ...cloneJson(raw) }
  out.url = raw.url == null || raw.url === '' ? 'http://127.0.0.1:{port}/v1/models' : keepText(raw.url)
  out.timeoutMs = raw.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS
  out.intervalMs = raw.intervalMs ?? DEFAULT_READY_INTERVAL_MS
  out.type = raw.type ?? 'http'
  return out
}

function normalizeStop(raw) {
  if (raw == null) return { method: 'kill-tree', graceMs: DEFAULT_STOP_GRACE_MS }
  if (!isPlainObject(raw)) return raw
  const out = { ...cloneJson(raw) }
  out.method = isNonEmptyString(raw.method) ? raw.method.trim() : 'kill-tree'
  out.graceMs = raw.graceMs ?? DEFAULT_STOP_GRACE_MS
  return out
}

function normalizeAuth(raw, fallbackKeyRef) {
  if (raw != null && !isPlainObject(raw)) return raw
  const out = raw == null ? {} : { ...cloneJson(raw) }
  out.type = isNonEmptyString(out.type) ? out.type.trim().toLowerCase() : 'bearer'
  // 默认拿引擎 id 当 secrets 的键名：填 key 时不用再想一个名字
  out.keyRef = isNonEmptyString(out.keyRef) ? out.keyRef.trim() : fallbackKeyRef
  return out
}

/**
 * 引擎的"思考能力声明"（可空）：
 *   { mode: 'config' | 'argv', key?, budgetKey?, levels? }
 *
 * 为什么要这个字段：思考等级能不能改，是引擎决定的，不是界面决定的。
 * 能探测出来的引擎（Strata 的配置文件 + server.py）导入时会自动写；探测不出来的
 * 引擎可以手写这段声明，界面就按它渲染；不写 = 不知道 = 显示"不适用"。
 */
function normalizeReasoning(raw) {
  if (raw == null) return null
  if (!isPlainObject(raw)) return raw // 结构坏了交给校验
  const out = { ...cloneJson(raw) }
  out.mode = isNonEmptyString(out.mode) ? out.mode.trim().toLowerCase() : 'none'
  if (out.mode === 'config' || out.mode === 'argv') {
    out.levels = Array.isArray(out.levels) && out.levels.length
      ? out.levels.map((level) => String(level)).filter(Boolean)
      /* config 型是引擎自己的值域（先按 Strata 的四档）；argv 型就是模型档案那 7 档 */
      : (out.mode === 'config'
        ? ['none', 'low', 'medium', 'high']
        : THINKING_EFFORTS.slice())
    if (out.mode === 'config') {
      out.key = isNonEmptyString(out.key) ? out.key.trim() : 'reasoning_effort'
      out.budgetKey = isNonEmptyString(out.budgetKey) ? out.budgetKey.trim() : 'reasoning_budget_tokens'
    }
  }
  return out
}

/**
 * 补齐引擎默认值。
 * - 未知字段原样保留（以后加字段不用改 M1）
 * - 只补缺失值，不纠正类型（类型错了让 validateEngine 报，免得用户永远不知道自己写错了）
 * - 顺手剔除密钥字段：就算有人手改文件塞了 apiKey，也不能顺着任何接口漏出去
 */
export function normalizeEngine(input) {
  if (!isPlainObject(input)) return emptyEngine()

  const raw = cloneJson(input)
  const out = { ...raw }

  out.id = keepText(raw.id)
  out.label = isNonEmptyString(raw.label) ? raw.label.trim() : (isNonEmptyString(out.id) ? out.id : '')
  out.mode = isNonEmptyString(raw.mode) ? raw.mode.trim().toLowerCase() : 'custom'
  out.kind = isNonEmptyString(raw.kind) ? raw.kind.trim().toLowerCase() : inferKind(raw.file)
  out.file = cleanPath(keepText(raw.file))
  out.cwd = isNonEmptyString(raw.cwd) ? cleanPath(raw.cwd.trim()) : defaultCwd(out.file)
  out.interpreter = raw.interpreter == null || raw.interpreter === ''
    ? null
    : cleanPath(keepText(raw.interpreter))
  out.defaultPort = raw.defaultPort == null
    ? (out.mode === 'remote' ? null : DEFAULT_PORT_BASE)
    : raw.defaultPort
  out.fileSlots = Array.isArray(raw.fileSlots) ? raw.fileSlots.map(normalizeSlot) : []
  out.argv = Array.isArray(raw.argv) ? raw.argv.slice() : []
  out.capabilityArgs = isPlainObject(raw.capabilityArgs) ? cloneJson(raw.capabilityArgs) : {}
  out.reasoning = normalizeReasoning(raw.reasoning)
  out.deviceProfileArg = raw.deviceProfileArg == null || raw.deviceProfileArg === ''
    ? null
    : keepText(raw.deviceProfileArg)
  out.env = isPlainObject(raw.env) ? cloneJson(raw.env) : {}
  out.middlewares = Array.isArray(raw.middlewares) ? raw.middlewares.slice() : []
  out.webUI = raw.webUI == null || raw.webUI === '' ? null : keepText(raw.webUI)
  out.footprintLog = raw.footprintLog == null || raw.footprintLog === '' ? null : keepText(raw.footprintLog)
  out.ready = normalizeReady(raw.ready, out.mode)
  out.stop = normalizeStop(raw.stop)
  // 保守默认 false：误判成 true 会去开第二个实例把显存打爆；误判成 false 只是不让你开，改一下就行（§5.9）
  out.multiInstance = raw.multiInstance === true
  out.supportsMultiModel = raw.supportsMultiModel === true
  out.modelsArg = isNonEmptyString(raw.modelsArg) ? raw.modelsArg.trim() : null
  out.why = isNonEmptyString(raw.why) ? raw.why.trim() : ''

  if (out.mode === 'remote') {
    out.baseURL = keepText(raw.baseURL)
    out.auth = normalizeAuth(raw.auth, out.id)
    out.apiKeyEnv = isNonEmptyString(raw.apiKeyEnv) ? raw.apiKeyEnv.trim() : null
    out.models = Array.isArray(raw.models) ? cloneJson(raw.models) : []
  }

  // 所有模式都剔一遍：remote 的 auth、以及模式切来切去时留在文件里的旧密钥字段
  stripSecretsFromObject(out)

  return out
}

// ---------------------------------------------------------------------------
// 引擎：校验
// ---------------------------------------------------------------------------

function checkRawEngineTypes(input, c) {
  if (input.id != null && typeof input.id !== 'string') c.error('id', 'id 必须是字符串')
  if (input.kind != null && typeof input.kind !== 'string') c.error('kind', 'kind 必须是字符串')
  if (input.file != null && typeof input.file !== 'string') c.error('file', 'file 必须是字符串路径')
  if (input.interpreter != null && typeof input.interpreter !== 'string') c.error('interpreter', 'interpreter 必须是字符串路径或 null')
  if (input.defaultPort != null && typeof input.defaultPort !== 'number') c.error('defaultPort', 'defaultPort 必须是数字')
  if (input.webUI != null && typeof input.webUI !== 'string') c.error('webUI', 'webUI 必须是 URL 字符串或 null')
  if (input.footprintLog != null && typeof input.footprintLog !== 'string') c.error('footprintLog', 'footprintLog 必须是正则字符串')
  if (input.fileSlots != null && !Array.isArray(input.fileSlots)) c.error('fileSlots', '文件槽位表必须是数组')
  if (input.argv != null && !Array.isArray(input.argv)) c.error('argv', '启动参数模板必须是数组（每个元素一个参数）')
  if (input.env != null && !isPlainObject(input.env)) c.error('env', '必须是对象（键=环境变量名，值=值）')
  if (input.capabilityArgs != null && !isPlainObject(input.capabilityArgs)) {
    c.error('capabilityArgs', '必须是对象（键=能力名如 vision/mtp，值=命令行片段数组）')
  }
  if (input.reasoning != null && (typeof input.reasoning !== 'object' || Array.isArray(input.reasoning))) {
    c.error('reasoning', '必须是 { mode, key, budgetKey, levels } 对象或 null')
  }
  if (input.deviceProfileArg != null && typeof input.deviceProfileArg !== 'string') {
    c.error('deviceProfileArg', '必须是字符串（如 "--device-profile-path"）或 null')
  }
  if (input.middlewares != null && !Array.isArray(input.middlewares)) c.error('middlewares', '必须是数组')
  if (input.ready != null && !isPlainObject(input.ready)) c.error('ready', '必须是 { url, timeoutMs, intervalMs } 对象')
  if (input.stop != null && !isPlainObject(input.stop)) c.error('stop', '必须是 { method, graceMs } 对象')
  if (input.auth != null && !isPlainObject(input.auth)) c.error('auth', '必须是 { type, keyRef } 对象')
  if (input.models != null && !Array.isArray(input.models)) c.error('models', '必须是数组')
  for (const key of ['multiInstance', 'supportsMultiModel']) {
    if (input[key] != null && typeof input[key] !== 'boolean') {
      c.warn(key, `应该是 true / false（现在是 \`${previewValue(input[key])}\`），本次按 false 处理（保守）`)
    }
  }
}

function validateReady(engine, c) {
  if (!isPlainObject(engine.ready)) {
    c.error('ready', '必须是 { url, timeoutMs, intervalMs } 对象')
    return
  }
  const url = engine.ready.url
  if (!isNonEmptyString(url)) {
    c.error('ready.url', '缺少判活地址：引擎起来了，系统不知道去哪个地址问')
  } else if (!/^https?:\/\//i.test(url)) {
    c.error('ready.url', `必须以 http:// 或 https:// 开头：\`${url}\``)
  } else {
    try {
      const parsed = new URL(url.replaceAll('{port}', String(isPortNumber(engine.defaultPort) ? engine.defaultPort : DEFAULT_PORT_BASE)))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    } catch {
      c.error('ready.url', `不是合法 URL：\`${url}\``)
    }
    if (!url.includes('{port}')) c.warn('ready.url', '没有 {port}：多实例时所有实例会探同一个地址')
  }
  checkPositive(engine.ready, 'ready', 'timeoutMs', '判活超时', c)
  checkPositive(engine.ready, 'ready', 'intervalMs', '判活间隔', c)
  if (isPositiveNumber(engine.ready.timeoutMs) && isPositiveNumber(engine.ready.intervalMs)
    && engine.ready.intervalMs >= engine.ready.timeoutMs) {
    c.warn('ready', 'intervalMs 不小于 timeoutMs：第一次探测之前就已经超时了')
  }
  if (engine.ready.type != null && engine.ready.type !== 'http') {
    if (engine.ready.type === 'script') {
      c.warn('ready.type', '`script` 是预留值（§14.2），第一版只会按 http 探')
    } else {
      c.error('ready.type', `只能是 http，现在是 \`${previewValue(engine.ready.type)}\``)
    }
  }
}

function validateStop(engine, c) {
  if (!isPlainObject(engine.stop)) {
    c.error('stop', '必须是 { method, graceMs } 对象')
    return
  }
  if (!STOP_METHODS.includes(engine.stop.method)) {
    if (FUTURE_STOP_METHODS.includes(engine.stop.method)) {
      c.warn('stop.method', `\`${engine.stop.method}\` 是预留值（§5.6），第一版只有 kill-tree / signal`)
    } else {
      c.error('stop.method', `只能是 kill-tree / signal，现在是 \`${previewValue(engine.stop.method)}\``)
    }
  }
  if (!isNonNegativeNumber(engine.stop.graceMs)) {
    c.error('stop.graceMs', `停机宽限必须是 ≥ 0 的毫秒数，现在是 \`${previewValue(engine.stop.graceMs)}\``)
  }
}

function validateFootprintLog(engine, c) {
  if (engine.footprintLog == null) return
  if (typeof engine.footprintLog !== 'string') {
    c.error('footprintLog', '必须是正则字符串（或 null）')
    return
  }
  const source = engine.footprintLog.trim()
  if (source === '') return
  try {
    // eslint-disable-next-line no-new -- 只为了验证能编译
    new RegExp(source)
    const groupCount = ((new RegExp(`${source}|`).exec('')?.length ?? 1) - 1)
    if (groupCount < 2) {
      c.warn('footprintLog', '需要两个捕获组：先池 token 数、再运行时 MiB；抓不到时系统会退回公式估算')
    }
  } catch (error) {
    c.error('footprintLog', `不是合法正则：${error.message}`)
  }
}

/**
 * capabilityArgs：能力开关 → 命令行片段。
 *
 * 键是**模型 params 里的布尔名**（vision / mtp / …）；值是命令行片段，可以写
 * `{visionResidency}` 这种 params 变量，启动时由模型渲染。
 * 模型上 `params.vision === true` 才追加这一组 —— 界面上的复选框改的就是它。
 */
function validateCapabilityArgs(engine, c) {
  if (engine.capabilityArgs == null) return
  if (!isPlainObject(engine.capabilityArgs)) {
    c.error('capabilityArgs', '必须是对象（键=能力名，值=命令行片段数组）')
    return
  }
  for (const [name, tokens] of Object.entries(engine.capabilityArgs)) {
    const where = `capabilityArgs.${name}`
    if (!BOOLEAN_PARAMS.includes(name)) {
      c.warn(where, `\`${name}\` 不是已知的布尔参数（mtp / vision）：模型 params 里要有同名 true 才会生效`)
    }
    if (!Array.isArray(tokens)) {
      c.error(where, '必须是命令行片段数组，例如 ["--vision"]')
      continue
    }
    if (tokens.length === 0) {
      c.warn(where, '空数组：这个开关不会往命令行加任何东西')
      continue
    }
    tokens.forEach((token, index) => {
      if (typeof token !== 'string' || token.trim() === '') {
        c.error(`${where}[${index}]`, '必须是非空字符串')
      }
    })
  }
}

function validateWebUI(engine, c) {  if (engine.webUI == null) return
  if (!isNonEmptyString(engine.webUI)) {
    c.error('webUI', '必须是 URL 字符串或 null')
    return
  }
  if (!/^https?:\/\//i.test(engine.webUI)) {
    c.error('webUI', `必须以 http:// 或 https:// 开头：\`${engine.webUI}\``)
    return
  }
  if (!engine.webUI.includes('{port}')) c.warn('webUI', '没有 {port}：多实例时每行会打开同一个页面')
}

/**
 * 思考能力声明：形状、模式、等级值域。
 * 声明错了不报"引擎坏了"那么重，但会让界面显示一个写不进去的字段，所以按错误处理。
 */
function validateReasoning(engine, c) {
  if (engine.reasoning == null) return
  if (!isPlainObject(engine.reasoning)) {
    c.error('reasoning', '必须是 { mode, key, budgetKey, levels } 对象或 null')
    return
  }
  const mode = engine.reasoning.mode
  if (mode !== 'none' && mode !== 'config' && mode !== 'argv') {
    c.error('reasoning.mode', `只能是 none / config / argv，现在是 \`${previewValue(mode)}\``)
    return
  }
  if (mode === 'none') return
  if (engine.reasoning.levels != null && !Array.isArray(engine.reasoning.levels)) {
    c.error('reasoning.levels', '必须是等级字符串数组（如 ["none","low","medium","high"]）')
    return
  }
  for (const level of engine.reasoning.levels || []) {
    if (!isNonEmptyString(level)) c.error('reasoning.levels', '等级只能是字符串')
  }
  if (mode === 'config') {
    if (!isNonEmptyString(engine.reasoning.key)) c.error('reasoning.key', 'config 模式要写配置键名（如 "reasoning_effort"）')
    if (engine.reasoning.budgetKey != null && !isNonEmptyString(engine.reasoning.budgetKey)) {
      c.error('reasoning.budgetKey', '必须是配置键名或 null')
    }
  }
}

/** package / custom 共用的检查（`mode` 决定要不要跑 argv 那套，见 checkEngineTemplate）。 */
function validateLocalEngine(engine, c) {
  if (!isNonEmptyString(engine.kind)) {
    c.error('kind', '缺少 kind（exe / bat / ps1 / py / sh）；file 带扩展名时会自动推断')
  } else if (!ENGINE_KINDS.includes(engine.kind)) {
    c.error('kind', `只能是 ${ENGINE_KINDS.join(' / ')}，现在是 \`${previewValue(engine.kind)}\``)
  }

  if (!isNonEmptyString(engine.file)) {
    c.error('file', '缺少启动文件路径（file）')
  } else if (!path.isAbsolute(engine.file)) {
    c.warn('file', '建议写绝对路径：相对路径按进程当前目录解析，换个目录启动就找不到')
  }

  if (!isNonEmptyString(engine.cwd)) c.warn('cwd', '没填 cwd，会用启动文件所在目录')
  else if (!path.isAbsolute(engine.cwd)) c.warn('cwd', '建议写绝对路径')

  if (engine.interpreter != null && !isNonEmptyString(engine.interpreter)) {
    c.error('interpreter', '必须是解释器路径字符串，或者 null（.py / .ps1 才用）')
  } else if ((engine.kind === 'py' || engine.kind === 'ps1') && engine.interpreter == null) {
    c.warn('interpreter', '没写解释器：会用全局 config.pythonPath 兜底；引擎自带 venv 时最好单独写')
  }

  if (engine.defaultPort == null) c.error('defaultPort', '缺少默认端口（defaultPort）')
  else if (!isPortNumber(engine.defaultPort)) {
    c.error('defaultPort', `必须是 1–65535 的整数，现在是 \`${previewValue(engine.defaultPort)}\``)
  }

  validateReady(engine, c)
  validateStop(engine, c)
  validateFootprintLog(engine, c)
  validateWebUI(engine, c)
  validateCapabilityArgs(engine, c)
  validateReasoning(engine, c)

  if (engine.deviceProfileArg != null) {
    const arg = String(engine.deviceProfileArg || '')
    if (!isNonEmptyString(arg)) c.error('deviceProfileArg', '必须是非空字符串或 null')
    else if (arg.startsWith('-') === false) c.error('deviceProfileArg', `\`${arg}\` 应该是一个 flag（以 - 开头）`)
  }

  if (!Array.isArray(engine.middlewares)) c.error('middlewares', '必须是数组')
  else {
    engine.middlewares.forEach((middleware, index) => {
      if (typeof middleware !== 'string' && !isPlainObject(middleware)) {
        c.warn(`middlewares[${index}]`, '看不懂这一项（既不是字符串也不是对象），先原样留着')
      }
    })
  }

  // 一个 custom 引擎连槽位都没有、模板里却写着变量：多半是导错了，给条软提示（不拦）
  if (engine.mode === 'custom' && Array.isArray(engine.fileSlots) && engine.fileSlots.length === 0
    && Array.isArray(engine.argv) && engine.argv.length > 0) {
    c.warn('fileSlots', '没有声明任何文件槽位：模型文件没有地方可填（固定参数、不需要模型文件的引擎可以忽略）')
  }

  // §5.9.1 / D1：多模型实例只支持单槽位引擎
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots : []
  const primarySlot = slots.length === 1 && isPlainObject(slots[0]) ? slots[0] : null
  if (engine.supportsMultiModel === true) {
    if (!isNonEmptyString(engine.modelsArg)) {
      c.error('modelsArg', '开了 supportsMultiModel 就必须写 modelsArg（多模型时拼成 `--models a,b`）')
    } else if (!engine.modelsArg.startsWith('-')) {
      c.warn('modelsArg', '一般以 - 或 -- 开头')
    }
    if (slots.length !== 1) {
      c.error('fileSlots', `多模型实例只支持单槽位引擎（D1）：这个引擎有 ${slots.length} 个文件槽位，一个进程装不下多个模型`)
    } else if (!primarySlot) {
      // 槽位结构本身有问题，checkEngineTemplate 已经报过，这里不重复
    } else if (isNonEmptyString(primarySlot.arg)) {
      c.error('fileSlots', '多模型引擎的主文件槽位不能再写 arg：模型列表由 modelsArg 统一拼（D2）')
    } else if (primarySlot.kind !== 'file') {
      c.error('fileSlots', '多模型引擎的主文件槽位必须是 kind = file')
    }
  } else if (isNonEmptyString(engine.modelsArg)) {
    c.error('modelsArg', '写了 modelsArg 但没开 supportsMultiModel，系统不会去拼模型列表')
  }
}

/**
 * 槽位与模板的交叉检查（D2）。
 *
 * 为什么单独一个函数：引擎保存和模型保存都要看这些规则
 * （模型保存时也要确认"这个模型填的槽位在模板里有没有位置"）。
 *
 * enforceD2 = false 时（package 模式）只查槽位本身的结构，不查模板 ——
 * package 原样执行 file，argv / fileSlots 根本不参与启动；
 * 但用户之后随时会切到 custom（§5.4.2），所以字段结构还是要保证是好的。
 */
function checkEngineTemplate(engine, c, options = {}) {
  const enforceD2 = options.enforceD2 !== false
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots : []
  const byKey = new Map()
  const argOwners = new Map()

  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]
    const where = `fileSlots[${index}]`
    if (!isPlainObject(slot)) {
      c.error(where, '槽位必须是一个对象')
      continue
    }
    if (!isNonEmptyString(slot.key)) {
      c.error(where, '槽位缺少 key（模板里的 `{key}` 就用它）')
      continue
    }

    const key = slot.key
    if (!SLOT_KEY_RE.test(key)) {
      c.error(where, `槽位 key \`${key}\` 不合法：它会变成模板变量 \`{${key}}\`，只能用字母/数字/下划线，且不能以数字开头`)
    }
    if (byKey.has(key)) c.error(where, `槽位 key \`${key}\` 重复`)
    else byKey.set(key, slot)
    if (RESERVED_VARS.includes(key)) c.error(where, `槽位 key \`${key}\` 和内置变量 \`{${key}}\` 撞了，换个名字`)
    if (RESERVED_VARS.includes(`${key}Dir`)) c.error(where, `\`{${key}Dir}\` 和内置变量同名，换个槽位名`)

    if (!SLOT_KINDS.includes(slot.kind)) {
      c.error(where, `kind 只能是 file / dir，现在是 \`${previewValue(slot.kind)}\``)
    }

    if (slot.arg != null) {
      if (typeof slot.arg !== 'string') {
        c.error(where, 'arg 必须是字符串（旗标本身，如 "--native"），或者不写')
      } else if (slot.arg.trim() === '') {
        c.warn(where, 'arg 是空字符串，按"没有 arg"处理（位置参数）')
      } else {
        const arg = slot.arg
        if (/\s/.test(arg)) c.error(where, `arg \`${arg}\` 里不能有空格：一个槽位只对应一个 flag`)
        if (/[{}]/.test(arg)) c.error(where, `arg \`${arg}\` 里不能写模板变量`)
        if (!arg.startsWith('-')) c.warn(where, `arg \`${arg}\` 一般以 - 或 -- 开头，否则它会变成一个位置参数`)
        if (argOwners.has(arg)) c.error(where, `槽位 \`${argOwners.get(arg)}\` 和 \`${key}\` 的 arg 都是 \`${arg}\``)
        else argOwners.set(arg, key)
      }
    }

    if (slot.expect != null && !Array.isArray(slot.expect)) {
      c.error(where, 'expect 必须是文件名数组')
    } else if (Array.isArray(slot.expect)) {
      for (const name of slot.expect) {
        if (!isNonEmptyString(name)) c.error(where, 'expect 里只能放非空文件名')
      }
      if (slot.kind === 'file' && slot.expect.length > 0) c.warn(where, 'expect 只在 kind = dir 时检查')
    }
  }

  // `{xDir}` 和名为 `xDir` 的槽位会撞成同一个变量
  for (const key of byKey.keys()) {
    if (byKey.has(`${key}Dir`)) {
      c.error('', `\`{${key}Dir}\` 会被解释成"槽位 ${key} 的父目录"，和另一个同名槽位 \`${key}Dir\` 撞了，换一个名字`, { field: `fileSlots.${key}Dir` })
    }
  }

  const parts = []
  const argv = Array.isArray(engine.argv) ? engine.argv : []
  argv.forEach((value, index) => {
    if (typeof value !== 'string') c.error(`argv[${index}]`, `argv 里只能是字符串，现在是 \`${previewValue(value)}\``)
    else parts.push({ where: `argv[${index}]`, text: value })
  })

  const env = isPlainObject(engine.env) ? engine.env : {}
  for (const [name, value] of Object.entries(env)) {
    if (!isNonEmptyString(name)) c.error('env', '环境变量名不能为空')
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      c.error(`env.${name}`, `只能是字符串/数字/布尔，现在是 \`${previewValue(value)}\``)
    } else {
      parts.push({ where: `env.${name}`, text: String(value) })
    }
  }
  if (isPlainObject(engine.ready) && isNonEmptyString(engine.ready.url)) parts.push({ where: 'ready.url', text: engine.ready.url })
  if (isNonEmptyString(engine.webUI)) parts.push({ where: 'webUI', text: engine.webUI })

  const dirKeys = new Set([...byKey.keys()].map((key) => `${key}Dir`))
  const reported = new Set()
  for (const part of parts) {
    const { vars, unmatched } = scanTemplate(part.text)
    if (unmatched) c.error(part.where, `\`${part.text}\` 里的大括号不配对（少了一个 { 或 }）`)
    for (const name of vars) {
      if (name === '') {
        c.error(part.where, '`{}` 是空变量名')
        continue
      }
      if (!VAR_NAME_RE.test(name)) {
        c.error(part.where, `变量名 \`{${name}}\` 不合法：只能用字母/数字/下划线/点，且不能以数字开头`)
        continue
      }
      if (RESERVED_VARS.includes(name) || byKey.has(name) || dirKeys.has(name)) continue
      // 引擎这一层不知道模型 params，所以只对"标准参数名"报近似纠错，而且只警告；
      // 严格的未知变量拦截在 validateModel（那里有完整的 params 候选集）。
      // 名字正好就是标准参数名时不提示（那是合法引用，只是值要由模型提供）。
      if (KNOWN_PARAM_NAMES.includes(name)) continue
      const dedupe = `${part.where}\u0000${name}`
      if (reported.has(dedupe)) continue
      reported.add(dedupe)
      const guess = closestName(name, KNOWN_PARAM_NAMES)
      if (guess) {
        c.warn(part.where, `变量 \`{${name}}\` 不是内置变量也不是槽位——你是不是想写 \`{${guess}}\`?（如果它是模型的 param，忽略这条）`)
      }
    }
  }

  if (!enforceD2) return

  const argvTexts = argv.filter((value) => typeof value === 'string')
  const envTexts = Object.entries(env)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    .map(([, value]) => String(value))
  const everywhere = [...argvTexts, ...envTexts]
  const hasModelsArg = isNonEmptyString(engine.modelsArg)

  for (const slot of byKey.values()) {
    const key = slot.key
    const inArgv = countVar(argvTexts, key)
    const anywhere = countVar(everywhere, key)
    const auto = isNonEmptyString(slot.arg)

    if (auto) {
      // D2：有 arg 的槽位由系统拼 `--flag 路径`，模板里再写就是同一个参数拼两遍
      if (anywhere > 0) c.error('', `\`{${key}}\` 是自动拼的，模板里删掉它`, { field: `fileSlots.${key}` })
    } else if (hasModelsArg) {
      // 多模型引擎：模型列表统一由 modelsArg 拼，模板里不许再写
      if (anywhere > 0) c.error('', `\`modelsArg\` 已经负责拼模型列表，模板里不要再写 \`{${key}}\``, { field: `fileSlots.${key}` })
    } else if (inArgv === 0) {
      if (slot.optional === true) {
        // 可选的位置参数：模板里没位置 = 这个值不会被传出去（保存允许，但要说清楚）
        c.warn(`fileSlots.${key}`, `可选槽位 \`{${key}}\` 没出现在模板里：填了值也不会传给引擎`)
      } else {
        c.error('', `\`{${key}}\` 没放，引擎不知道模型在哪`, { field: `fileSlots.${key}` })
      }
    } else if (inArgv > 1) {
      c.error('', `\`{${key}}\` 在模板里出现了 ${inArgv} 次，只能出现一次`, { field: `fileSlots.${key}` })
    }
  }
}

function validateRemoteEngine(engine, c) {
  if (!isNonEmptyString(engine.baseURL)) {
    c.error('baseURL', '云端引擎必须写 baseURL（如 https://api.deepseek.com/v1）')
  } else {
    let ok = false
    try {
      const parsed = new URL(engine.baseURL)
      ok = parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      ok = false
    }
    if (!ok) c.error('baseURL', `不是合法的 http(s) 地址：\`${engine.baseURL}\``)
  }

  if (!isPlainObject(engine.auth)) {
    c.error('auth', '必须是 { type, keyRef } 对象')
  } else {
    if (!AUTH_TYPES.includes(engine.auth.type)) {
      c.error('auth.type', `只能是 ${AUTH_TYPES.join(' / ')}，现在是 \`${previewValue(engine.auth.type)}\``)
    }
    if (engine.auth.type !== 'none' && !isNonEmptyString(engine.auth.keyRef) && !isNonEmptyString(engine.apiKeyEnv)) {
      c.warn('auth', '既没有 keyRef 也没有 apiKeyEnv：调云端会 401')
    }
  }

  if (!Array.isArray(engine.models)) {
    c.error('models', 'models 必须是数组')
  } else {
    if (engine.models.length === 0) c.warn('models', '一个模型都没列，/v1/models 里看不到这个引擎')
    const seen = new Set()
    engine.models.forEach((model, index) => {
      const where = `models[${index}]`
      if (!isPlainObject(model)) {
        c.error(where, '必须是 { id, contextWindow, maxTokens } 对象')
        return
      }
      if (!isNonEmptyString(model.id)) {
        c.error(where, '缺少模型 id')
      } else if (seen.has(model.id.toLowerCase())) {
        c.error(where, `模型 id \`${model.id}\` 重复`)
      } else {
        seen.add(model.id.toLowerCase())
      }
      for (const field of ['contextWindow', 'maxTokens']) {
        if (model[field] != null && !(Number.isInteger(model[field]) && model[field] > 0)) {
          c.error(`${where}.${field}`, `必须是正整数，现在是 \`${previewValue(model[field])}\``)
        }
      }
    })
  }

  if (isNonEmptyString(engine.file) || (Array.isArray(engine.argv) && engine.argv.length > 0)) {
    c.warn('', '云端引擎不启动进程：file / argv / fileSlots 都会被忽略（留着不影响，切回本地模式时还要用）')
  }
}

function validateEngineInto(input, c) {
  if (!isPlainObject(input)) {
    c.error('', '引擎定义必须是一个 JSON 对象')
    return null
  }
  checkRawEngineTypes(input, c)
  const engine = normalizeEngine(input)

  if (input.id != null && typeof input.id !== 'string') {
    // 类型错误已经在 checkRawEngineTypes 里报过
  } else if (!isNonEmptyString(engine.id)) {
    c.error('id', '缺少 id（它同时是文件名，比如 `ninfer-120a`）')
  } else if (!isSafeId(engine.id)) {
    c.error('id', `\`${engine.id}\` 不能当文件名：只能用字母、数字、"."、"_"、"-"，且以字母或数字开头`)
  }

  if (!isNonEmptyString(engine.label)) c.warn('label', '没填 label，界面会直接显示 id')

  if (!ENGINE_MODES.includes(engine.mode)) {
    if (FUTURE_ENGINE_MODES.includes(engine.mode)) {
      c.warn('mode', `\`${engine.mode}\` 是预留模式（§14.2），第一版只有 package / custom / remote`)
      return engine // 预留模式不知道需要什么字段，不做进一步检查
    }
    c.error('mode', `只能是 ${ENGINE_MODES.join(' / ')}，现在是 \`${previewValue(engine.mode)}\``)
    return engine
  }

  if (engine.mode === 'remote') {
    validateRemoteEngine(engine, c)
  } else {
    validateLocalEngine(engine, c)
    checkEngineTemplate(engine, c, { enforceD2: engine.mode === 'custom' })
  }

  return engine
}

/**
 * 校验引擎定义（纯函数，不读盘）。
 * 保存时的"id 唯一 / 路径存在 / Windows 大小写撞名"在 saveEngine 里补 ——
 * 那些要么需要看其它文件，要么属于"标黄警告"，不该塞进纯校验。
 */
export function validateEngine(input) {
  const c = issueCollector()
  validateEngineInto(input, c)
  return c.result()
}

// ---------------------------------------------------------------------------
// 引擎：读
// ---------------------------------------------------------------------------

let lastIssues = []

/** 上一次 list* / loadInstances 遇到的坏文件。界面可以拿它显示"有 2 个引擎定义读不出来"。 */
export function getLoadIssues() {
  return lastIssues.map((issue) => ({ ...issue }))
}

/**
 * 列全部引擎。坏文件跳过（不因为一个手改坏的文件让整个界面打不开），
 * 跳过原因进 getLoadIssues()。
 * options.strict = true 时改成直接抛（验收/脚本用）。
 */
export function listEngines(options = {}) {
  const strict = Boolean(options && options.strict === true)
  lastIssues = []
  const engines = []

  for (const stem of jsonStems(enginesDir())) {
    const file = enginePath(stem)
    try {
      const raw = readJson(file, null)
      if (!isPlainObject(raw)) throw new Error('内容不是 JSON 对象')
      const engine = normalizeEngine(raw)
      if (isNonEmptyString(raw.id) && raw.id.trim() !== stem) {
        lastIssues.push({ level: 'warning', file, message: `内容里的 id 是 \`${raw.id}\`，和文件名不一致，已按 \`${stem}\` 处理（文件名才是查找键）` })
      }
      // 文件名是查找键：内容里的 id 只作展示，不一致时以文件名为准
      engine.id = stem
      engines.push(engine)
    } catch (error) {
      if (strict) throw error
      lastIssues.push({ level: 'error', file, message: error.message })
    }
  }

  return sortByLabel(engines)
}

/**
 * 读一个引擎。id 非法或文件不存在 → null（不抛；路径穿越也在这里被挡掉）。
 * 文件在但 JSON 坏了 → 抛（坏数据必须被看见，不能假装"没有这个引擎"）。
 */
export function loadEngine(id) {
  if (!isSafeId(id)) return null
  const file = enginePath(id)
  if (!fs.existsSync(file)) return null
  const raw = readJson(file, null)
  if (!isPlainObject(raw)) throw new Error(`引擎文件不是 JSON 对象：${file}`)
  const engine = normalizeEngine(raw)
  engine.id = id
  return engine
}

/**
 * 剔除密钥并给出提示。任务书要求"保存时剔除 apiKey 字段"——
 * 剔除是硬规则（引擎定义要能分享），提示是给用户解释为什么填了却没存。
 */
function stripEngineSecrets(input, c) {
  const clean = cloneJson(input)
  const removed = []
  stripSecretsFromObject(clean, removed)
  if (removed.length > 0) {
    c.warn('', `已剔除 ${removed.map((name) => `\`${name}\``).join('、')}：密钥不能存进引擎文件（引擎定义会被导出/分享），请用 saveSecret() 存到 data/secrets.json`)
  }
  if (isPlainObject(clean.auth) && isNonEmptyString(clean.auth.keyRef) && /^(sk-|gsk_|Bearer\s)/i.test(clean.auth.keyRef)) {
    c.warn('auth.keyRef', '看起来是一把真 key：keyRef 只该填 secrets.json 里的键名，真 key 用 saveSecret() 存')
  }
  return clean
}

function checkEnginePaths(engine, c) {
  if (!isNonEmptyString(engine.file)) return
  if (!fs.existsSync(engine.file)) {
    c.warn('file', `启动文件不存在：\`${engine.file}\`（可以先保存，等会儿再拷）`)
  } else {
    try {
      if (fs.statSync(engine.file).isDirectory()) c.warn('file', `启动文件指向的是文件夹：\`${engine.file}\``)
    } catch {
      /* 存在但读不了属性：上面 existsSync 已经说明问题，这里不重复报 */
    }
  }
  if (isNonEmptyString(engine.cwd) && !fs.existsSync(engine.cwd)) {
    c.warn('cwd', `工作目录不存在：\`${engine.cwd}\``)
  }
  if (isNonEmptyString(engine.interpreter) && !fs.existsSync(engine.interpreter)) {
    c.warn('interpreter', `解释器不存在：\`${engine.interpreter}\``)
  }
}

/**
 * 端口基址撞车（§5.7.2）：两个引擎用同一个 defaultPort 不致命
 * （运行时 allocPort 会往上找），但保存时该说一声，否则用户会以为配错了。
 */
function checkEnginePort(engine, c) {
  if (!isPortNumber(engine.defaultPort)) return
  let others = []
  try {
    others = listEngines().filter((item) => item.id !== engine.id)
  } catch {
    return
  }
  const clash = others.find((item) => Number(item.defaultPort) === Number(engine.defaultPort))
  if (clash) {
    c.warn(
      'defaultPort',
      `和引擎 \`${clash.id}\` 的默认端口相同（${engine.defaultPort}）：同时加载时第二个会自动往上找空闲端口`,
    )
  }
}

function checkEngineGlobal(engine, c) {
  const lower = engine.id.toLowerCase()

  // Windows 文件名不区分大小写：`Foo` 和 `foo` 会落到同一个文件，必须挡（否则一个会悄悄覆盖另一个）
  const clash = jsonStems(enginesDir()).find((stem) => stem !== engine.id && stem.toLowerCase() === lower)
  if (clash) {
    c.error('id', `已有引擎 \`${clash}\`：Windows 文件名不分大小写，\`${engine.id}\` 会写到同一个文件；要改名先删掉旧的`)
  }

  // id 全局唯一：引擎和模型别用同一个字符串，界面上分不清谁是谁
  const modelClash = jsonStems(modelsDir()).find((stem) => stem.toLowerCase() === lower)
  if (modelClash) c.error('id', `\`${engine.id}\` 已经被一个模型用了（id 全局唯一）`)
}

// ---------------------------------------------------------------------------
// 引擎：写 / 删
// ---------------------------------------------------------------------------

/**
 * 保存引擎（新建或更新，id 决定文件）。
 * 返回 { ok, engine, errors, warnings, details }；校验不过不落盘，engine 为 null。
 */
export function saveEngine(input) {
  const c = issueCollector()
  if (!isPlainObject(input)) {
    c.error('', '引擎定义必须是一个 JSON 对象')
    return c.result({ engine: null })
  }

  const clean = stripEngineSecrets(input, c)
  const engine = validateEngineInto(clean, c)

  if (engine && isSafeId(engine.id)) {
    checkEngineGlobal(engine, c)
    checkEnginePort(engine, c)
    if (engine.mode !== 'remote') checkEnginePaths(engine, c)
  }

  if (c.errors.length > 0) return c.result({ engine: null })

  ensureDataLayout()
  writeJsonAtomic(enginePath(engine.id), engine)
  return c.result({ engine })
}

/**
 * 删引擎。默认**拒绝**删除还有模型在用的引擎（那些模型会变成孤儿，网关按 engineId 找不到东西）；
 * options.force = true 时连它的模型一起删（界面要明确提示过才传）。
 * 返回 { ok, existed, deletedModels, errors, warnings }。
 */
export function deleteEngine(id, options = {}) {
  const c = issueCollector()
  if (!isSafeId(id)) {
    c.error('id', `非法的引擎 id：${previewValue(id)}`)
    return c.result({ existed: false, deletedModels: [] })
  }

  const owned = modelsOfEngine(id)
  if (owned.length > 0 && options.force !== true) {
    c.error('', `还有 ${owned.length} 个模型在用它：${owned.map((model) => `\`${model.id}\``).join('、')}；先删模型，或者传 { force: true } 连模型一起删`)
    return c.result({ existed: true, deletedModels: [] })
  }

  const instanceRefs = Object.entries(loadInstancesSafe())
    .filter(([, instance]) => instance.engineId === id)
    .map(([instanceId]) => `\`${instanceId}\``)
  if (instanceRefs.length > 0) {
    c.warn('', `有 ${instanceRefs.length} 个实例记录指向这个引擎（${instanceRefs.join('、')}）：删了引擎记录，它们就没法恢复了`)
  }

  let existed = true
  try {
    fs.unlinkSync(enginePath(id))
  } catch (error) {
    if (error && error.code === 'ENOENT') existed = false
    else {
      c.error('', `删不掉 \`${enginePath(id)}\`：${error.message}`)
      return c.result({ existed: true, deletedModels: [] })
    }
  }

  const deletedModels = []
  if (existed) {
    for (const model of owned) {
      try {
        fs.unlinkSync(modelPath(model.id))
        deletedModels.push(model.id)
      } catch (error) {
        if (error && error.code !== 'ENOENT') c.warn('', `模型 \`${model.id}\` 没删掉：${error.message}`)
      }
    }
  }

  return c.result({ existed, deletedModels })
}

// ---------------------------------------------------------------------------
// 模型：归一化
// ---------------------------------------------------------------------------

function emptyModel() {
  return {
    id: '',
    label: '',
    kind: 'chat',
    engineId: '',
    files: {},
    port: null,
    caps: { mtp: null, vision: null, tools: null },
    params: {},
    thinking: { effort: null, budget: null, allowRequestOverride: false },
    extraArgs: [],
    engineModelId: null,
    footprint: null,
  }
}

function normalizeCaps(raw) {
  if (raw == null) return { mtp: null, vision: null, tools: null }
  if (!isPlainObject(raw)) return raw // 结构坏了交给校验
  const out = { ...cloneJson(raw) }
  if (out.mtp === undefined) out.mtp = null
  if (out.vision === undefined) out.vision = null
  if (out.tools === undefined) out.tools = null
  return out
}

function normalizeThinking(raw) {
  if (raw == null) return { effort: null, budget: null, allowRequestOverride: false }
  if (!isPlainObject(raw)) return raw
  const out = { ...cloneJson(raw) }
  out.effort = out.effort ?? null
  out.budget = out.budget ?? null
  // 默认 false：没写就是"请求里的 reasoning_effort 不许盖掉它"（D4 默认锁死更安全，§5.3）
  out.allowRequestOverride = raw.allowRequestOverride === true
  return out
}

function trimPathMap(map) {
  for (const [key, value] of Object.entries(map)) {
    if (typeof value === 'string') map[key] = cleanPath(value)
  }
  return map
}

/**
 * 补齐模型默认值。规则同 normalizeEngine：只补默认、不改类型、未知字段保留。
 */
export function normalizeModel(input) {
  if (!isPlainObject(input)) return emptyModel()

  const raw = cloneJson(input)
  const out = { ...raw }

  out.id = keepText(raw.id)
  out.label = isNonEmptyString(raw.label) ? raw.label.trim() : (isNonEmptyString(out.id) ? out.id : '')
  out.kind = isNonEmptyString(raw.kind) ? raw.kind.trim().toLowerCase() : 'chat'
  out.engineId = isNonEmptyString(raw.engineId) ? raw.engineId.trim() : keepText(raw.engineId)
  out.files = isPlainObject(raw.files) ? trimPathMap(cloneJson(raw.files)) : (raw.files == null ? {} : raw.files)
  out.port = raw.port ?? null
  out.caps = normalizeCaps(raw.caps)
  out.params = isPlainObject(raw.params) ? cloneJson(raw.params) : (raw.params == null ? {} : raw.params)
  out.thinking = normalizeThinking(raw.thinking)
  out.extraArgs = Array.isArray(raw.extraArgs) ? raw.extraArgs.slice() : (raw.extraArgs == null ? [] : raw.extraArgs)
  out.engineModelId = raw.engineModelId == null || raw.engineModelId === '' ? null : keepText(raw.engineModelId)
  out.footprint = raw.footprint == null ? null : cloneJson(raw.footprint)

  return out
}

// ---------------------------------------------------------------------------
// 模型：校验
// ---------------------------------------------------------------------------

function checkRawModelTypes(input, c) {
  if (input.id != null && typeof input.id !== 'string') c.error('id', 'id 必须是字符串')
  if (input.kind != null && typeof input.kind !== 'string') c.error('kind', 'kind 必须是字符串')
  if (input.engineId != null && typeof input.engineId !== 'string') c.error('engineId', 'engineId 必须是字符串')
  if (input.port != null && typeof input.port !== 'number') c.error('port', 'port 必须是整数或 null')
  if (input.files != null && !isPlainObject(input.files)) c.error('files', '必须是 { 槽位key: 路径 } 对象')
  if (input.params != null && !isPlainObject(input.params)) c.error('params', '必须是对象（键=参数名，值=值）')
  if (input.caps != null && !isPlainObject(input.caps)) c.error('caps', '必须是对象')
  if (input.thinking != null && !isPlainObject(input.thinking)) c.error('thinking', '必须是 { effort, budget, allowRequestOverride } 对象')
  if (input.extraArgs != null && !Array.isArray(input.extraArgs)) c.error('extraArgs', '必须是字符串数组')
  if (input.footprint != null && !isPlainObject(input.footprint)) c.error('footprint', '必须是对象或 null（M4 回填的实测值）')
}

function validateCaps(model, c) {
  if (!isPlainObject(model.caps)) {
    c.error('caps', '必须是对象')
    return
  }
  for (const key of ['mtp', 'vision']) {
    const value = model.caps[key]
    if (value != null && typeof value !== 'boolean') {
      c.error(`caps.${key}`, '只能是 true / false / null（null = 没测过）')
    }
  }
  if (model.caps.tools !== null && typeof model.caps.tools !== 'boolean') {
    c.error('caps.tools', '只能是 true / false / null（null = 还没测过会不会调工具）')
  }
}

function validateParams(model, c) {
  if (!isPlainObject(model.params)) {
    c.error('params', '必须是对象')
    return
  }

  for (const [key, value] of Object.entries(model.params)) {
    if (RESERVED_VARS.includes(key)) {
      c.warn(`params.${key}`, `和内置变量 \`{${key}}\` 撞了：模板里的 \`{${key}}\` 永远取内置值，params 里这个名字不会生效`)
    }

    const rule = NUMERIC_PARAMS[key]
    if (rule) {
      if (value === null || value === undefined) continue // 留空 = 用引擎默认，允许
      if (typeof value !== 'number') {
        c.error('', `${rule.label}必须是数字，现在是 \`${previewValue(value)}\``, { field: `params.${key}` })
        continue
      }
      if (!Number.isFinite(value)) {
        c.error('', `${rule.label}必须是有限数字，现在是 \`${previewValue(value)}\``, { field: `params.${key}` })
        continue
      }
      if (rule.integer && !Number.isInteger(value)) {
        c.warn(`params.${key}`, `${rule.label}一般是整数，现在是 \`${value}\``)
      }
      if (rule.min != null && value < rule.min) {
        c.warn(`params.${key}`, `${rule.label}不能小于 ${rule.min}，现在是 \`${value}\``)
      }
      if (rule.max != null && value > rule.max) {
        c.warn(`params.${key}`, `${rule.label}一般不超过 ${rule.max}，现在是 \`${value}\``)
      }
      continue
    }

    if (BOOLEAN_PARAMS.includes(key) && value != null && typeof value !== 'boolean') {
      c.warn(`params.${key}`, `${key} 一般是 true / false，现在是 \`${previewValue(value)}\``)
    }
  }
}

function validateThinking(model, input, c) {
  if (!isPlainObject(model.thinking)) {
    c.error('thinking', '必须是 { effort, budget, allowRequestOverride } 对象')
    return
  }
  const thinking = model.thinking
  if (thinking.effort != null && !THINKING_EFFORTS.includes(thinking.effort)) {
    c.error('thinking.effort', `只能是 ${THINKING_EFFORTS.join(' / ')} 或 null（null = 不干预），现在是 \`${previewValue(thinking.effort)}\``)
  }
  if (thinking.budget != null && !(typeof thinking.budget === 'number' && Number.isFinite(thinking.budget) && thinking.budget >= 0)) {
    c.error('thinking.budget', `必须是 ≥ 0 的数字（token 上限）或 null，现在是 \`${previewValue(thinking.budget)}\``)
  }
  if (isPlainObject(input.thinking) && input.thinking.allowRequestOverride != null && typeof input.thinking.allowRequestOverride !== 'boolean') {
    c.error('thinking.allowRequestOverride', '只能是 true / false；没写默认 false（锁死，D4）')
  }
}

function validateExtraArgs(model, c) {
  if (!Array.isArray(model.extraArgs)) {
    c.error('extraArgs', '必须是字符串数组')
    return
  }
  model.extraArgs.forEach((value, index) => {
    if (typeof value !== 'string') c.error(`extraArgs[${index}]`, '必须是字符串')
  })
}

function validateEngineModelId(model, c) {
  if (model.engineModelId == null) return
  if (typeof model.engineModelId !== 'string' || model.engineModelId.trim() === '') {
    c.error('engineModelId', '必须是非空字符串或 null（不写就等于 id，D3）')
    return
  }
  if (/\s/.test(model.engineModelId)) {
    c.warn('engineModelId', `含空格：\`${model.engineModelId}\`，它会原样当 --model-id，确认引擎认这种名字`)
  }
}

function validateFootprint(model, c) {
  if (model.footprint == null) return
  if (!isPlainObject(model.footprint)) {
    c.error('footprint', '必须是对象或 null（M4 回填的实测值）')
    return
  }
  const footprint = model.footprint
  if (footprint.source != null && !['measured', 'formula', 'manual'].includes(footprint.source)) {
    c.warn('footprint.source', `不认识 \`${previewValue(footprint.source)}\`，应该是 measured / formula / manual`)
  }
  for (const field of ['vramMiB', 'hostRamMiB']) {
    if (footprint[field] != null && !(typeof footprint[field] === 'number' && Number.isFinite(footprint[field]))) {
      c.warn(`footprint.${field}`, '应该是数字（MiB）')
    }
  }
  if (footprint.fingerprint != null && !isPlainObject(footprint.fingerprint)) {
    c.warn('footprint.fingerprint', '应该是 { gpu, driver, totalMiB } 对象')
  }
}

/**
 * 模板里出现的变量，逐个确认能被这个模型解析出来（§5.4.1：错误必须指到具体那一个 `{}`）。
 * - 已知：内置变量 / 槽位 / 槽位Dir / params 的键（`{maxContext}` 和 `{params.maxContext}` 都认）
 * - 近似拼错（大小写或编辑距离 ≤2）→ **错误**（这里候选集完整，不会像引擎层那样误报）
 * - 离得很远的未知变量 → **警告**：可能只是参数还没填，先让存着，启动前必须补
 */
function checkModelVariables(model, engine, c) {
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots.filter((slot) => isPlainObject(slot)) : []
  const slotKeys = slots.map((slot) => slot.key).filter(isNonEmptyString)
  const dirKeys = slotKeys.map((key) => `${key}Dir`)
  const params = isPlainObject(model.params) ? model.params : {}
  const paramKeys = Object.keys(params)
  const known = new Set([...RESERVED_VARS, ...slotKeys, ...dirKeys])
  const candidates = [...new Set([...known, ...paramKeys, ...paramKeys.map((key) => `params.${key}`)])]

  const parts = []
  if (Array.isArray(engine.argv)) {
    engine.argv.forEach((value, index) => {
      if (typeof value === 'string') parts.push({ where: `argv[${index}]`, text: value })
    })
  }
  if (isPlainObject(engine.env)) {
    for (const [key, value] of Object.entries(engine.env)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        parts.push({ where: `env.${key}`, text: String(value) })
      }
    }
  }
  if (isPlainObject(engine.ready) && isNonEmptyString(engine.ready.url)) parts.push({ where: 'ready.url', text: engine.ready.url })
  if (isNonEmptyString(engine.webUI)) parts.push({ where: 'webUI', text: engine.webUI })

  const reported = new Set()
  for (const part of parts) {
    for (const name of scanTemplate(part.text).vars) {
      if (!VAR_NAME_RE.test(name)) continue // 语法错误由引擎校验负责
      if (known.has(name)) continue

      let paramKey = null
      if (name.startsWith('params.') && paramKeys.includes(name.slice('params.'.length))) {
        paramKey = name.slice('params.'.length)
      } else if (paramKeys.includes(name)) {
        paramKey = name
      }

      if (paramKey) {
        const value = params[paramKey]
        if (value === null || value === undefined) {
          c.error(part.where, `\`params.${paramKey}\` 是空的，模板里却用了 \`{${name}}\``)
        } else if (typeof value === 'object') {
          c.error(part.where, `\`params.${paramKey}\` 是数组/对象，插不进命令行（只能字符串/数字/布尔）`)
        }
        continue
      }

      const dedupe = `${part.where}\u0000${name}`
      if (reported.has(dedupe)) continue
      reported.add(dedupe)

      const guess = closestName(name, candidates)
      if (guess) {
        c.error(part.where, `未知变量 \`{${name}}\`——你是不是想写 \`{${guess}}\`?`)
      } else {
        c.warn(part.where, `未知变量 \`{${name}}\`：不是内置变量/槽位，也不在这个模型的 params 里；启动前得补上（先存着可以）`)
      }
    }
  }
}

/** 模型 ↔ 引擎的交叉检查：槽位键、必需槽位、可选位置参数。 */
function checkModelAgainstEngine(model, engine, c) {
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots.filter((slot) => isPlainObject(slot)) : []
  const byKey = new Map()
  for (const slot of slots) {
    if (isNonEmptyString(slot.key)) byKey.set(slot.key, slot)
  }

  if (isPlainObject(model.files)) {
    for (const [key, value] of Object.entries(model.files)) {
      if (!byKey.has(key)) {
        c.error('', `文件槽位 \`${key}\` 在引擎里没定义（引擎只有：${[...byKey.keys()].join('、') || '没有槽位'}）`, { field: `files.${key}` })
      } else if (value != null && typeof value !== 'string') {
        c.error(`files.${key}`, '路径必须是字符串')
      }
    }

    const missing = []
    for (const slot of slots) {
      if (isNonEmptyString(model.files[slot.key])) continue
      if (slot.optional === true) continue
      missing.push(isNonEmptyString(slot.label) ? slot.label : slot.key)
    }
    if (missing.length > 0) {
      c.error('', `缺少必需的槽位：${missing.join('、')}`, { field: 'files' })
    }
  }

  // 可选 + 无 arg + 模板里没位置 → 填了也传不出去，提前说清楚
  const argvTexts = Array.isArray(engine.argv) ? engine.argv.filter((value) => typeof value === 'string') : []
  const hasModelsArg = isNonEmptyString(engine.modelsArg)
  for (const slot of slots) {
    if (slot.optional !== true) continue
    if (!isPlainObject(model.files) || !isNonEmptyString(model.files[slot.key])) continue
    if (isNonEmptyString(slot.arg) || hasModelsArg) continue
    if (countVar(argvTexts, slot.key) === 0) {
      c.warn(`files.${slot.key}`, `填了路径，但模板里没有 \`{${slot.key}}\`：这个值不会传给引擎`)
    }
  }

  checkModelVariables(model, engine, c)
}

function validateModelInto(input, engineMaybe, c) {
  if (!isPlainObject(input)) {
    c.error('', '模型定义必须是一个 JSON 对象')
    return null
  }
  checkRawModelTypes(input, c)
  const model = normalizeModel(input)

  // 显式传了 engine（包括 null）就用传进来的；没传才自己查，方便单独测校验函数
  const engine = engineMaybe === undefined
    ? (isSafeId(model.engineId) ? loadEngine(model.engineId) : null)
    : engineMaybe

  if (input.id != null && typeof input.id !== 'string') {
    // 类型错误已经在 checkRawModelTypes 里报过
  } else if (!isNonEmptyString(model.id)) {
    c.error('id', '缺少 id（它同时是文件名，也是 --model-id 和 DSH 里的模型名）')
  } else if (!isSafeId(model.id)) {
    c.error('id', `\`${model.id}\` 不能当文件名：只能用字母、数字、"."、"_"、"-"，且以字母或数字开头`)
  }

  if (!MODEL_KINDS.includes(model.kind)) {
    c.error('kind', `只能是 ${MODEL_KINDS.join(' / ')}，现在是 \`${previewValue(model.kind)}\``)
  }

  if (!isNonEmptyString(model.engineId)) {
    c.error('engineId', '缺少 engineId（这个模型用哪个引擎跑）')
  } else if (!isSafeId(model.engineId)) {
    c.error('engineId', `\`${model.engineId}\` 不是合法的引擎 id`)
  } else if (!engine) {
    c.error('engineId', `找不到引擎 \`${model.engineId}\`：先把引擎导进来，模型才有地方挂`)
  } else if (engine.id !== model.engineId) {
    c.error('engineId', `传进来的引擎是 \`${engine.id}\`，模型写的却是 \`${model.engineId}\``)
  }

  if (model.port != null && !isPortNumber(model.port)) {
    c.error('port', `必须是 1–65535 的整数或 null，现在是 \`${previewValue(model.port)}\``)
  }

  validateCaps(model, c)
  validateParams(model, c)
  validateThinking(model, input, c)
  validateExtraArgs(model, c)
  validateEngineModelId(model, c)
  validateFootprint(model, c)

  if (engine && engine.id === model.engineId) {
    if (engine.mode === 'custom') {
      checkModelAgainstEngine(model, engine, c)
    } else if (engine.mode === 'package') {
      // package 原样执行 file：模型文件与参数不参与启动，但切到 custom 之后还要用，所以允许先填
      c.warn('', `引擎 \`${engine.id}\` 是 package 模式：files / params 不会进命令行，切到 custom 才用得上（现在存着没关系）`)
    } else if (engine.mode === 'remote') {
      c.warn('', `引擎 \`${engine.id}\` 是云端引擎（remote）：模型档案只提供 id / label，不启动本地进程`)
    }
  }

  return model
}

/**
 * 校验模型定义（纯函数，可以显式传 engine；不传就按 engineId 去注册表里读）。
 * 保存时的"id 全局唯一 / engineModelId 冲突 / 路径存在"在 saveModel 里补。
 */
export function validateModel(input, engine) {
  const c = issueCollector()
  validateModelInto(input, engine, c)
  return c.result()
}

// ---------------------------------------------------------------------------
// 模型：读
// ---------------------------------------------------------------------------

/** 列全部模型。坏文件跳过，原因进 getLoadIssues()。 */
export function listModels(options = {}) {
  const strict = Boolean(options && options.strict === true)
  lastIssues = []
  const models = []

  for (const stem of jsonStems(modelsDir())) {
    const file = modelPath(stem)
    try {
      const raw = readJson(file, null)
      if (!isPlainObject(raw)) throw new Error('内容不是 JSON 对象')
      const model = normalizeModel(raw)
      if (isNonEmptyString(raw.id) && raw.id.trim() !== stem) {
        lastIssues.push({ level: 'warning', file, message: `内容里的 id 是 \`${raw.id}\`，和文件名不一致，已按 \`${stem}\` 处理（文件名才是查找键）` })
      }
      model.id = stem
      models.push(model)
    } catch (error) {
      if (strict) throw error
      lastIssues.push({ level: 'error', file, message: error.message })
    }
  }

  return sortByLabel(models)
}

/** 读一个模型。id 非法或文件不存在 → null；文件在但 JSON 坏了 → 抛。 */
export function loadModel(id) {
  if (!isSafeId(id)) return null
  const file = modelPath(id)
  if (!fs.existsSync(file)) return null
  const raw = readJson(file, null)
  if (!isPlainObject(raw)) throw new Error(`模型文件不是 JSON 对象：${file}`)
  const model = normalizeModel(raw)
  model.id = id
  return model
}

/** 这个引擎下的模型（界面按「引擎 → 模型」分组，§5.1.1）。 */
export function modelsOfEngine(engineId) {
  if (!isNonEmptyString(engineId)) return []
  return listModels().filter((model) => model.engineId === engineId)
}

function checkModelPaths(model, engine, c) {
  if (!isPlainObject(model.files)) return
  const slots = Array.isArray(engine.fileSlots) ? engine.fileSlots.filter((slot) => isPlainObject(slot)) : []

  for (const slot of slots) {
    if (!isNonEmptyString(slot.key)) continue
    const value = model.files[slot.key]
    if (!isNonEmptyString(value)) continue
    const where = `files.${slot.key}`

    let stats
    try {
      stats = fs.statSync(value)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 任务书：路径不存在只标黄，允许保存（等会儿再拷）
        c.warn(where, `路径不存在：\`${value}\`（可以先保存，等会儿再拷）`)
      } else {
        c.warn(where, `读不到路径 \`${value}\`：${error.message}`)
      }
      continue
    }

    const wantsDir = slot.kind === 'dir'
    if (wantsDir && !stats.isDirectory()) {
      c.warn(where, `槽位要求文件夹，但 \`${value}\` 是文件`)
      continue
    }
    if (!wantsDir && !stats.isFile()) {
      c.warn(where, `槽位要求文件，但 \`${value}\` 是文件夹`)
      continue
    }
    if (wantsDir && stats.isDirectory() && Array.isArray(slot.expect) && slot.expect.length > 0) {
      const missing = slot.expect.filter((name) => isNonEmptyString(name) && !fs.existsSync(path.join(value, name)))
      if (missing.length > 0) {
        c.warn(where, `目录里缺少 ${missing.map((name) => `\`${name}\``).join('、')}，看起来不像${slot.label || '运行时包'}；确认一下是不是选错目录`)
      }
    }
  }
}

function checkModelGlobal(model, c) {
  const lower = model.id.toLowerCase()
  const stems = jsonStems(modelsDir())

  // Windows 大小写撞名
  const clash = stems.find((stem) => stem !== model.id && stem.toLowerCase() === lower)
  if (clash) {
    c.error('id', `已有模型 \`${clash}\`：Windows 文件名不分大小写，\`${model.id}\` 会写到同一个文件；要改 id 先删旧的`)
  }

  // id 全局唯一：同一个 id 换个引擎 = 网关按 model.id 路由会混（§2.2 / D3）
  if (stems.includes(model.id)) {
    let existing = null
    try {
      existing = loadModel(model.id)
    } catch (error) {
      c.error('id', `已有同名模型文件 \`${model.id}.json\` 但读不出来：${error.message}`)
    }
    if (existing && existing.engineId !== model.engineId) {
      c.error('id', `\`${model.id}\` 已被另一个引擎下的模型用了（\`${existing.engineId}\`）；同一个 id 换引擎会让网关路由混掉，改个 id 或者先删旧的`)
    }
  }

  // 和引擎 id 撞：id 全局唯一
  const engineClash = jsonStems(enginesDir()).find((stem) => stem.toLowerCase() === lower)
  if (engineClash) c.error('id', `\`${model.id}\` 已经被一个引擎用了（id 全局唯一）`)

  // 同一个引擎下 engineModelId 不能重复：一个进程只能报一个 --model-id（D3）
  if (isNonEmptyString(model.engineModelId)) {
    let siblings = []
    try {
      siblings = modelsOfEngine(model.engineId)
    } catch {
      siblings = []
    }
    const duplicate = siblings.find((other) => other.id !== model.id && other.engineModelId === model.engineModelId)
    if (duplicate) {
      c.error('engineModelId', `引擎 \`${model.engineId}\` 下的 \`${duplicate.id}\` 已经用了 \`${model.engineModelId}\` 当 engineModelId；一个进程只能报一个 --model-id`)
    }
  }
}

// ---------------------------------------------------------------------------
// 模型：写 / 删
// ---------------------------------------------------------------------------

/**
 * 保存模型（新建或更新，id 决定文件）。
 * 返回 { ok, model, errors, warnings, details }；校验不过不落盘。
 */
export function saveModel(input) {
  const c = issueCollector()
  if (!isPlainObject(input)) {
    c.error('', '模型定义必须是一个 JSON 对象')
    return c.result({ model: null })
  }

  const engine = isSafeId(input.engineId) ? loadEngine(input.engineId) : null
  const model = validateModelInto(input, engine, c)

  if (model && isSafeId(model.id)) {
    checkModelGlobal(model, c)
    if (engine && engine.mode === 'custom') checkModelPaths(model, engine, c)
  }

  if (c.errors.length > 0) return c.result({ model: null })

  ensureDataLayout()
  writeJsonAtomic(modelPath(model.id), model)
  return c.result({ model })
}

/**
 * 删模型。id 不存在时返回 existed=false（删除是幂等的，界面不用为 404 处理两次）。
 * 返回 { ok, existed, errors, warnings }。
 */
export function deleteModel(id) {
  const c = issueCollector()
  if (!isSafeId(id)) {
    c.error('id', `非法的模型 id：${previewValue(id)}`)
    return c.result({ existed: false })
  }

  let existed = true
  try {
    fs.unlinkSync(modelPath(id))
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      existed = false
    } else {
      c.error('', `删不掉 \`${modelPath(id)}\`：${error.message}`)
      return c.result({ existed: true })
    }
  }

  if (existed) {
    const refs = Object.entries(loadInstancesSafe())
      .filter(([, instance]) => Array.isArray(instance.modelIds) && instance.modelIds.includes(id))
      .map(([instanceId]) => `\`${instanceId}\``)
    if (refs.length > 0) {
      c.warn('', `实例 ${refs.join('、')} 还引用着 \`${id}\`：重启后对账会把它标成不一致，记得也把实例记录清掉`)
    }
  }

  return c.result({ existed })
}

// ---------------------------------------------------------------------------
// 实例表（instances.json，单个文件装全部）
// ---------------------------------------------------------------------------

/**
 * 实例记录的归一化。
 * 未知字段保留：M2/M4 可能往里塞 inflight 计数、日志路径之类的运行时快照，
 * M1 不负责理解它们，但也**不许把它们吃掉**（否则每次写盘都在丢 M2 的状态）。
 */
function normalizeInstance(raw, options = {}) {
  const defaultPhase = options.defaultPhase ?? 'error'
  const out = { ...raw }

  out.engineId = isNonEmptyString(out.engineId) ? out.engineId.trim() : ''
  out.modelIds = Array.isArray(out.modelIds) ? out.modelIds.filter((id) => typeof id === 'string') : []
  out.port = Number.isInteger(out.port) && out.port > 0 ? out.port : null
  out.pid = Number.isInteger(out.pid) && out.pid > 0 ? out.pid : null
  // 未知状态当成 error，不能当成 idle：
  // 把"不知道什么状态"当成"没在跑"，下一次加载就会再起一个进程（打爆显存）。
  out.phase = PHASES.includes(out.phase) ? out.phase : defaultPhase
  out.ephemeral = out.ephemeral === true
  out.startedAt = Number.isFinite(out.startedAt) ? out.startedAt : null
  return out
}

function loadInstancesSafe() {
  try {
    return loadInstances()
  } catch {
    return {}
  }
}

/**
 * 读实例表。没有文件 → {}（第一次启动）。
 * 整个文件不是对象 → 抛（这种损坏没法猜，安静返回 {} 会让系统忘掉在跑的进程）。
 */
export function loadInstances() {
  lastIssues = []
  const raw = readJson(instancesFile(), {})
  if (!isPlainObject(raw)) throw new Error(`instances.json 必须是 { 实例id: {...} } 对象：${instancesFile()}`)

  const out = {}
  for (const [instanceId, entry] of Object.entries(raw)) {
    if (!isPlainObject(entry)) {
      lastIssues.push({ level: 'error', file: instancesFile(), message: `实例 \`${instanceId}\` 不是对象，已忽略` })
      continue
    }
    if (entry.phase != null && !PHASES.includes(entry.phase)) {
      lastIssues.push({ level: 'warning', file: instancesFile(), message: `实例 \`${instanceId}\` 的 phase=\`${previewValue(entry.phase)}\` 不认识，按 error 处理（保守：不能当 idle，否则会再起一个）` })
    }
    out[instanceId] = normalizeInstance(entry)
  }
  return out
}

/**
 * 写实例表（整体覆盖，原子写）。
 * 返回 { ok, instances, errors, warnings, details }。
 */
export function saveInstances(map) {
  const c = issueCollector()
  if (!isPlainObject(map)) {
    c.error('', '实例表必须是 { 实例id: {...} } 形式的对象')
    return c.result({ instances: null })
  }

  const engineIds = new Set(jsonStems(enginesDir()).map((stem) => stem.toLowerCase()))
  const modelIds = new Set(jsonStems(modelsDir()).map((stem) => stem.toLowerCase()))
  const out = {}

  for (const [instanceId, entry] of Object.entries(map)) {
    const where = `instances.${instanceId}`
    if (!isNonEmptyString(instanceId)) {
      c.error(where, '实例 id 不能为空')
      continue
    }
    if (!isPlainObject(entry)) {
      c.error(where, '实例必须是对象')
      continue
    }

    // 试启动的临时实例（§5.5.2）在引擎还没入库时登记，engineId 允许为空（可能是 null）。
    // 常驻实例必须挂在一个真实引擎上，否则重启后没法恢复。
    const ephemeral = entry.ephemeral === true
    if (ephemeral) {
      if (entry.engineId != null && typeof entry.engineId !== 'string') {
        c.error(where, 'engineId 必须是字符串或 null')
      }
    } else if (!isNonEmptyString(entry.engineId)) {
      c.error(where, '缺少 engineId')
    } else if (!engineIds.has(entry.engineId.toLowerCase())) {
      c.warn(where, `引擎 \`${entry.engineId}\` 不存在了（记录会留着，但重启后没法恢复这个实例）`)
    }

    if (!Array.isArray(entry.modelIds) || entry.modelIds.some((id) => typeof id !== 'string')) {
      c.error(where, 'modelIds 必须是字符串数组')
    } else if (!ephemeral) {
      for (const modelId of entry.modelIds) {
        if (!modelIds.has(modelId.toLowerCase())) c.warn(where, `模型 \`${modelId}\` 不存在了`)
      }
    }

    if (entry.port != null && !isPortNumber(entry.port)) c.error(where, 'port 必须是 1–65535 的整数或 null')
    if (entry.pid != null && !(Number.isInteger(entry.pid) && entry.pid > 0)) c.error(where, 'pid 必须是正整数或 null')
    if (entry.phase != null && !PHASES.includes(entry.phase)) c.error(where, `phase 只能是 ${PHASES.join(' / ')}，现在是 \`${previewValue(entry.phase)}\``)
    if (entry.startedAt != null && !Number.isFinite(entry.startedAt)) c.error(where, 'startedAt 必须是毫秒时间戳或 null')

    out[instanceId] = normalizeInstance(entry, { defaultPhase: 'idle' })
  }

  if (c.errors.length > 0) return c.result({ instances: null })

  ensureDataLayout()
  writeJsonAtomic(instancesFile(), out)
  return c.result({ instances: out })
}
