/**
 * M5 · 网关（127.0.0.1:8095）
 * =============================================================================
 * DSH 和其他客户端只认识 `http://127.0.0.1:8095/v1`。后面换哪个引擎、哪个模型、
 * 哪个端口，网关不管。
 *
 * 端点：
 *   GET  /v1/models                  —— 从模型档案生成列表（不依赖引擎在不在）
 *   POST /v1/chat/completions        —— 含 SSE 流式
 *   POST /v1/messages                —— Anthropic 兼容
 *   POST /v1/responses
 *   POST /v1/audio/transcriptions    —— multipart，直接 pipe
 *   POST /v1/audio/speech            —— JSON body
 *   POST /v1/images/generations      —— JSON body
 *   GET  /health                     —— 给自己看的状态（格式可自由改）
 *   其余 /v1/*                       —— 兜底透传（embeddings / completions / ...）
 *
 * 路由规则（只认 model 字段，不看路径）：
 *   model → 模型档案 → engineId
 *     engine.mode === "remote" → 转发到 baseURL（带 secrets / 环境变量里的 key）
 *     否则                     → 找 modelIds 里包含它的那个 ready 实例，按实例真实端口转发
 *   本地没加载 → 503，绝不自动转云端（静默花钱比静默报错更糟）。
 *   路径原样透传，因此 /v1/audio/transcriptions 打到 ASR 实例、/v1/chat/completions
 *   打到 chat 实例，靠的是 model，不是路径。
 *
 * 三条硬规矩：
 *   1. SSE 原样 pipe，不缓冲、不聚合（首字节延迟就是用户体验）。
 *   2. multipart 直接 `req.pipe(upstream)`，一个字节都不读出来解析。
 *      代价：multipart 里的 model 字段读不到，所以这类请求用
 *      `?model=` / `x-laci-model` 头指定；都没给时按路径的 kind 找"唯一在跑"的
 *      同类模型，多个就回 400 要求显式指定（见 #proxyMultipart）。
 *   3. D4：模型 `thinking.allowRequestOverride === false`（或不写，默认 false）时，
 *      网关把请求里的 `reasoning_effort`（以及 Responses 的 `reasoning.effort`、
 *      Anthropic /v1/messages 的 `thinking`）剥掉。配置说锁死就必须真锁。
 *
 * 超时（两道，对应旧 router 的教训）：
 *   - 空闲 180 秒没有数据往来 → 504。单并发引擎挂住会把后面全堵死。
 *   - 总时长 900 秒还没结束     → 504。防"一直在吐但结束不了"。
 *   两条都计数，/health 能看。响应头已经发出去时无法再改状态码，只能掐断连接
 *   （SSE 客户端会看到流提前结束），计数照记。
 *
 * 自愈（§5.6.3 / §5.6.4）：
 *   同一实例连续两次 429 / 503 → 重启一次，90 秒去抖。
 *   - 抢账本：M4 提供锁接口就抢；抢不到（用户正在加载/切换）就跳过这次。
 *   - 重启会掐断在飞请求：那些请求回 502 +「引擎意外退出，已自动重启，请重发」。
 *   - 不重放：agent 的工具调用不幂等，偷偷重放可能把文件写两次（比报错糟得多）。
 *   网关自己**不 spawn 进程**（边界：不启停进程），重启是调 M2/M4 的接口。
 *
 * 依赖（M1/M2/M4 正在并行开发，这里全部"运行时才 import"，缺文件不抛）：
 *   M1 core/registry.mjs：listModels / loadModel / listEngines / loadEngine /
 *                          loadInstances（已有；读不到时 /v1/models 返回空列表、
 *                          转发请求回 503 registry_unavailable，网关本身不崩）
 *   M1 core/config.mjs  ：loadConfig / loadSecrets（已有；同步函数也兼容）
 *   M4 core/ledger.mjs  ：tryLock / lock / acquireLock / tryAcquire（锁语义，不用 reserve）
 *                          目前 ledger 只有显存预留，没有互斥锁 → 退化为进程内锁
 *   M2 core/runtime.mjs ：getRuntimeManager().get(id) → InstanceRuntime.stop()+start()
 *                          （现在没有 restart()；有 restart() 就优先用它）
 *   M4 core/scheduler.mjs：以上没有时宽容试一次（文件名未定）
 *   这些都可以通过构造参数 `core` / `deps` 注入，集成时不必等模块就位：
 *     deps.restartInstance(instance)    自愈重启
 *     deps.acquireLock({reason})        账本互斥（M6 的加载/切换锁）
 *     deps.lockInfo() → { held }        只读探测"用户正在忙"
 *     deps.httpTransport                单测用的假 transport
 *     deps.runtimeStats() → { unloads } /health 的空闲卸载计数
 *
 * 和根入口的接法：M6 的 server.mjs 里是 `await startGateway(config)`（直接把整份
 * config.json 传进来），失败时它 catch 住继续跑控制台。所以 startGateway 支持
 * 配置对象参数，并且在监听失败时**抛异常**（Gateway.start() 本身仍返回 ok:false）。
 *
 * 边界：
 *   ❌ 不启停进程（只请求 M2/M4 重启）   ❌ 不算显存   ❌ 不做导入
 *   ❌ 不读 data/*.json（一律走 M1）     ❌ 不改别人的文件
 */

import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const GATEWAY_PORT = 8095
/** 空闲超时：180 秒没有任何数据往来就掐。 */
export const IDLE_TIMEOUT_MS = 180_000
/** 总时长超时：15 分钟。 */
export const TOTAL_TIMEOUT_MS = 900_000
/** 连续几次 429/503 触发自愈。 */
export const SELF_HEAL_CONSECUTIVE = 2
/** 自愈去抖：90 秒内不重复重启同一个实例。 */
export const SELF_HEAL_DEBOUNCE_MS = 90_000
/** JSON body 上限（视觉模型的 base64 图片会很大）。 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

/** 自愈重启时，在飞请求的 502 文案（§5.6.4 原话）。 */
export const ENGINE_RESTARTED_MESSAGE =
  '引擎意外退出，已自动重启，请重发这次请求。网关不会自动重放（工具调用不幂等，重放可能写两次文件）。'

/** 引擎自己崩了、但没有触发自愈时，在飞请求的 502 文案。 */
export const ENGINE_CRASHED_MESSAGE =
  '引擎意外退出或连接中断，请重发这次请求。网关不会自动重放（工具调用不幂等，重放可能写两次文件）。'

const MODULE_RETRY_MS = 2_000
const CACHE_TTL = {
  models: 2_000,
  engines: 3_000,
  instances: 250, // 控制台点「加载/关闭」后，网关最多 250ms 就能看到新状态
  config: 3_000,
}

const REGISTRY_MODULE = '../core/registry.mjs'
const CONFIG_MODULE = '../core/config.mjs'
const RUNTIME_MODULE = '../core/runtime.mjs'
const LEDGER_MODULE = '../core/ledger.mjs'
const SCHEDULER_MODULE = '../core/scheduler.mjs'

// 逐跳头（RFC 7230）：只对单条连接有意义，不能转发。
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * M6 的根 server.mjs 是这么写的：`await startGateway(config)`——把整份 config.json
 * 直接当参数传进来，不是 `{ port, ... }`。这里认一下"这是配置对象还是网关选项"，
 * 两种调用法都支持（显式 `{ config }` 也支持）。
 */
function looksLikeConfig(value) {
  if (!isPlainObject(value)) return false
  if (value.core || value.deps || value.port !== undefined) return false
  return (
    value.gatewayPort !== undefined ||
    value.consolePort !== undefined ||
    (isPlainObject(value.gateway) && value.gateway.idleTimeoutMs !== undefined)
  )
}

/** 从模块 / 对象里按候选名取第一个函数，并绑定 this。 */
function pickFunction(target, names) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return null
  for (const name of names) {
    if (typeof target[name] === 'function') return target[name].bind(target)
  }
  return null
}

/**
 * 一个模块可能把能力挂在 module / default / 子对象上（M4/M2 的文件名和导出形态
 * 还没最终定），这里把所有候选都列出来，找到了就用。
 */
function moduleCandidates(mod) {
  if (!mod) return []
  const list = [mod, mod.default, mod.ledger, mod.scheduler, mod.runtime, mod.lock, mod.locks]
  return list.filter((value, index) => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return false
    return list.indexOf(value) === index
  })
}

function normalizeModel(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  return { ...raw, id: raw.id.trim(), kind: raw.kind || 'chat' }
}

function normalizeModels(raw) {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.values(raw) : []
  return list.map(normalizeModel).filter(Boolean)
}

function normalizeEngine(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  return { ...raw, id: raw.id.trim() }
}

function normalizeEngines(raw) {
  const list = Array.isArray(raw) ? raw : isPlainObject(raw) ? Object.values(raw) : []
  return list.map(normalizeEngine).filter(Boolean)
}

/**
 * instances.json 是 `{ "inst-xxx": {...} }`，也兼容数组形态。
 * 统一成 [{ id, engineId, modelIds, port, phase, ... }]，别的模块不用关心原始形态。
 */
function normalizeInstances(raw) {
  const out = []
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (!isPlainObject(item)) return
      out.push({ ...item, id: String(item.id ?? item.instanceId ?? `inst-${index}`) })
    })
    return out
  }
  if (isPlainObject(raw)) {
    for (const [key, item] of Object.entries(raw)) {
      if (!isPlainObject(item)) continue
      out.push({ ...item, id: String(item.id ?? key) })
    }
  }
  return out
}

/** 一个实例承载哪些 model id。兼容 modelIds / models / 单个 modelId 三种写法。 */
function instanceModelIds(instance) {
  const raw = instance?.modelIds ?? instance?.models ?? (instance?.modelId ? [instance.modelId] : [])
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string' && id.trim() !== '')
}

/** 状态名只有五个：idle / starting / ready / stopping / error。 */
function instancePhase(instance) {
  const phase = instance?.phase ?? instance?.state ?? 'idle'
  return typeof phase === 'string' ? phase : 'idle'
}

/**
 * 是否是可路由的实例：ready + 有真实端口 + 不是试启动留下的临时实例。
 * 临时实例（engine probe）只活几十秒，网关路由过去只会打架。
 */
function isReadyInstance(instance) {
  if (instancePhase(instance) !== 'ready') return false
  if (instance?.ephemeral === true) return false
  const port = Number(instance?.port)
  return Number.isInteger(port) && port > 0
}

/** 路径 → 默认 kind。只在 multipart 读不到 model 时兜底用，正常路由只认 model。 */
function kindForPath(pathname) {
  if (/\/audio\/(transcriptions|translations)$/.test(pathname)) return 'asr'
  if (/\/audio\/speech$/.test(pathname)) return 'tts'
  if (/\/images\//.test(pathname)) return 'image'
  return 'chat'
}

function kindLabel(kind) {
  if (kind === 'asr') return '语音转写（ASR）'
  if (kind === 'tts') return '语音合成（TTS）'
  if (kind === 'image') return '绘画'
  return '对话'
}

function modelMatchesKind(model, kind) {
  const actual = model?.kind || 'chat'
  if (kind === 'asr') return actual === 'asr'
  if (kind === 'tts') return actual === 'tts'
  if (kind === 'image') return actual === 'image'
  return actual === 'chat'
}

function normalizeModelId(value) {
  if (Array.isArray(value)) value = value[0]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/** 请求里的 model：body 优先，然后 query，最后兼容两个自定义头。 */
function requestModelHint(req, url, body) {
  const candidates = [
    body?.model,
    url?.searchParams?.get('model'),
    req.headers['x-laci-model'],
    req.headers['x-model'],
  ]
  for (const candidate of candidates) {
    const id = normalizeModelId(candidate)
    if (id) return id
  }
  return null
}

function isMultipart(contentType) {
  return /^multipart\//i.test(String(contentType || ''))
}

// ---------------------------------------------------------------------------
// D4：思考等级锁定
// ---------------------------------------------------------------------------

/**
 * 只对「声明了 thinking 的模型」生效。
 * 没写 thinking 的模型（比如云端 reasoner）不动它——那类模型本来就要收
 * reasoning_effort，剥了反而坏事。
 * `thinking` 存在但没写 allowRequestOverride 时按默认 false 处理（§5.3）。
 */
function thinkingOverrideLocked(model) {
  const thinking = model?.thinking
  if (!isPlainObject(thinking)) return false
  return thinking.allowRequestOverride !== true
}

/**
 * 剥掉请求里的思考覆盖项：
 *   - 顶层 `reasoning_effort`（OpenAI chat/completions 的写法，D4 原文）
 *   - 顶层 `reasoningEffort`（部分客户端的驼峰写法）
 *   - `reasoning.effort`（Responses API 的写法，同一件事）
 *   - `/v1/messages` 的 `thinking`（Anthropic 的写法，同一件事）
 * 返回是否改动过——只有改动过才需要重新序列化 body。
 */
function stripThinkingOverrides(body, model, pathname) {
  if (!isPlainObject(body) || !thinkingOverrideLocked(model)) return false
  let changed = false

  for (const key of ['reasoning_effort', 'reasoningEffort']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      delete body[key]
      changed = true
    }
  }

  if (isPlainObject(body.reasoning) && Object.prototype.hasOwnProperty.call(body.reasoning, 'effort')) {
    delete body.reasoning.effort
    changed = true
    if (Object.keys(body.reasoning).length === 0) delete body.reasoning
  }

  if (pathname === '/v1/messages' && isPlainObject(body.thinking)) {
    delete body.thinking
    changed = true
  }

  return changed
}

// ---------------------------------------------------------------------------
// D3：model.id → 引擎的 --model-id
// ---------------------------------------------------------------------------

/**
 * 本地实例只有一个 `--model-id`。模型档案可以写 `engineModelId` 覆盖，
 * 不写就等于 id（D3）。所以这里永远按 `engineModelId || id` 改写；
 * 没配覆盖时等于原样转发。
 *
 * 云端不改编：云端认的是它自己的模型名（model.id 本身就是云端 id）。
 * 多模型实例同样按 engineModelId 映射——不配置时就是 id，也就是"原样"。
 */
function rewriteModelId(body, model, target) {
  if (!isPlainObject(body)) return false
  if (target?.kind === 'remote') return false
  const reported = Array.isArray(target?.instance?.reportedModelIds)
    ? target.instance.reportedModelIds.filter((x) => typeof x === 'string' && x)
    : []
  /* 引擎自己报的模型名优先：package 引擎的 --model-id 写在启动脚本里，
     和 LACI 登记的 id 可以不一样，转下去必须用引擎认的那个（否则上游 404）。 */
  const mapped = model?.engineModelId
    || (reported.length === 1 ? reported[0] : null)
    || model?.id
  if (!mapped || body.model === mapped) return false
  body.model = mapped
  return true
}

// ---------------------------------------------------------------------------
// URL / header 处理
// ---------------------------------------------------------------------------

/**
 * 把请求路径接到云端 baseURL 后面。
 * baseURL 通常已经带 `/v1`（如 https://api.deepseek.com/v1），而请求路径也是
 * `/v1/chat/completions`，直接拼会变成 `/v1/v1/...`。规则：
 *   base 以 `/v1` 结尾且请求以 `/v1/` 开头 → 去掉请求的 `/v1` 前缀。
 * query 原样保留。
 */
function joinRemotePath(basePath, requestUrl) {
  const rawUrl = String(requestUrl || '/')
  const queryAt = rawUrl.indexOf('?')
  const rawPath = queryAt >= 0 ? rawUrl.slice(0, queryAt) : rawUrl
  const search = queryAt >= 0 ? rawUrl.slice(queryAt) : ''
  const base = String(basePath || '').replace(/\/+$/, '')
  let path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (base.endsWith('/v1') && path.startsWith('/v1/')) path = path.slice(3)
  return `${base}${path}${search}`
}

/**
 * 自定义调试头只放 ASCII；模型 id 万一是中文，用百分号编码，别让 Node 抛
 * ERR_INVALID_CHAR（一个调试头不值得把响应搞挂）。
 */
function asciiHeaderValue(value) {
  if (value === undefined || value === null) return null
  const text = String(value)
  if (text === '') return null
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return encodeURIComponent(text)
}

/**
 * 构造转发给引擎的请求头：
 *   - 保留客户端的所有头（Authorization / x-api-key / anthropic-version ...）
 *   - 只改 host（DSH 依赖的语义）
 *   - 另外只动三样，且都有理由：
 *       accept-encoding：引擎一旦压缩 SSE，客户端首字节会被压住；Node 的 http 客户端
 *                        也不会自动解压，虽然透传压缩流可行，但和「原样 pipe」的
 *                        直觉相反，干脆不要压缩。
 *       hop-by-hop：逐跳头不能过代理（RFC 7230）。
 *       content-length：body 被改写（D3/D4）后必须按新长度写。
 *   - expect：Node 服务端已经自动回过 100-continue，再转给引擎会让引擎也等一次。
 */
function buildUpstreamHeaders(req, target, body) {
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    const lower = name.toLowerCase()
    if (lower === 'host') continue
    if (lower === 'accept-encoding') continue
    if (lower === 'expect') continue
    if (HOP_BY_HOP.has(lower)) continue
    headers[lower] = value
  }

  if (target.kind === 'remote') {
    headers.host = target.url.host
    // 云端用引擎自己的 key，绝不把客户端填给网关的假 key 转出去。
    if (target.key) headers.authorization = `Bearer ${target.key}`
    else delete headers.authorization
    delete headers['x-api-key']
  } else {
    headers.host = `${target.host}:${target.port}`
  }

  if (Buffer.isBuffer(body)) headers['content-length'] = String(body.length)
  return headers
}

/** 回给客户端的头：去掉逐跳头，加两个调试头（客户端不认识也无害）。 */
function buildDownstreamHeaders(upstreamHeaders, target, modelId) {
  const headers = {}
  for (const [name, value] of Object.entries(upstreamHeaders || {})) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  const model = asciiHeaderValue(modelId)
  if (model) headers['x-laci-model'] = model
  if (target.kind === 'remote') {
    const engineId = asciiHeaderValue(target.engine?.id)
    if (engineId) headers['x-laci-remote'] = engineId
  } else {
    const instanceId = asciiHeaderValue(target.instance?.id)
    if (instanceId) headers['x-laci-instance'] = instanceId
  }
  return headers
}

/** 锁的返回值形态不统一：对象 / 函数 / true 都当成"抢到了"。 */
function toLease(value, onRelease) {
  if (!value) return null
  if (typeof value === 'function') return { release: value }
  if (typeof value === 'object') {
    if (typeof value.release === 'function') return { release: () => value.release() }
    if (typeof value.unlock === 'function') return { release: () => value.unlock() }
  }
  if (value === true) return { release: onRelease || (() => {}) }
  return { release: onRelease || (() => {}) }
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function formatHost(host) {
  const text = String(host)
  return text.includes(':') && !text.startsWith('[') ? `[${text}]` : text
}

function safeUrlForLog(rawUrl) {
  try {
    const url = new URL(String(rawUrl || '/'), 'http://127.0.0.1')
    for (const name of ['key', 'api_key', 'token', 'access_token']) {
      if (url.searchParams.has(name)) url.searchParams.set(name, '***')
    }
    return `${url.pathname}${url.search}`
  } catch {
    return String(rawUrl || '/')
  }
}

// ---------------------------------------------------------------------------
// 数据层适配器：M1 还没写完也能跑
// ---------------------------------------------------------------------------

/**
 * 所有 data/*.json 的访问都走这里，网关自己不读文件（契约：其他模块只通过
 * M1 访问数据）。模块通过 `new Gateway({ core: { registry, config } })` 注入；
 * 没注入时运行时 `import()`，文件不存在只记警告，不抛异常。
 */
class DataLayer {
  constructor({ core = {} } = {}) {
    this.core = core || {}
    this.modules = new Map()
    this.cache = new Map()
  }

  async #module(spec) {
    const injected = this.#injected(spec)
    if (injected) {
      // 注入的模块也登记一下，/health 的 deps 才能如实说是 ok 还是缺函数。
      this.modules.set(spec, { mod: injected })
      return injected
    }

    const hit = this.modules.get(spec)
    if (hit?.mod) return hit.mod
    if (hit?.failedAt && Date.now() - hit.failedAt < MODULE_RETRY_MS) return null

    try {
      const mod = await import(spec)
      this.modules.set(spec, { mod })
      return mod
    } catch (err) {
      // 并行开发期间 core/*.mjs 可能还不存在，甚至正在被另一个代理写一半。
      // 这里只记下来，2 秒后允许重试；调用方按"能力缺失"降级。
      this.modules.set(spec, { failedAt: Date.now(), error: err?.message || String(err) })
      return null
    }
  }

  #injected(spec) {
    if (spec === REGISTRY_MODULE) return this.core.registry || null
    if (spec === CONFIG_MODULE) return this.core.config || null
    if (spec === RUNTIME_MODULE) return this.core.runtime || null
    if (spec === LEDGER_MODULE) return this.core.ledger || null
    if (spec === SCHEDULER_MODULE) return this.core.scheduler || null
    return null
  }

  /**
   * 缓存"读数据"的结果。缓存的是 Promise，并发请求不会同时读十遍盘。
   * loader 失败时把缓存删掉，下次立刻重试（不会把一次失败记 2 秒）。
   */
  async #cached(key, ttlMs, loader) {
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise
    const promise = Promise.resolve().then(loader)
    this.cache.set(key, { at: Date.now(), promise })
    promise.catch(() => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key)
    })
    return promise
  }

  registryModule() {
    return this.#module(REGISTRY_MODULE)
  }

  configModule() {
    return this.#module(CONFIG_MODULE)
  }

  runtimeModule() {
    return this.#module(RUNTIME_MODULE)
  }

  ledgerModule() {
    return this.#module(LEDGER_MODULE)
  }

  schedulerModule() {
    return this.#module(SCHEDULER_MODULE)
  }

  async listModels() {
    return this.#cached('models', CACHE_TTL.models, async () => {
      const mod = await this.registryModule()
      const fn = pickFunction(mod, ['listModels'])
      if (!fn) return []
      return normalizeModels(await fn())
    })
  }

  async loadModel(id) {
    const mod = await this.registryModule()
    const fn = pickFunction(mod, ['loadModel'])
    if (fn) {
      try {
        return normalizeModel(await fn(id))
      } catch {
        return null
      }
    }
    const models = await this.listModels().catch(() => [])
    return models.find((model) => model.id === id) || null
  }

  async listEngines() {
    return this.#cached('engines', CACHE_TTL.engines, async () => {
      const mod = await this.registryModule()
      const fn = pickFunction(mod, ['listEngines'])
      if (!fn) return []
      return normalizeEngines(await fn())
    })
  }

  async loadEngine(id) {
    const mod = await this.registryModule()
    const fn = pickFunction(mod, ['loadEngine'])
    if (fn) {
      try {
        return normalizeEngine(await fn(id))
      } catch {
        return null
      }
    }
    const engines = await this.listEngines().catch(() => [])
    return engines.find((engine) => engine.id === id) || null
  }

  async listInstances() {
    return this.#cached('instances', CACHE_TTL.instances, async () => {
      // 优先问 M2 的运行时单例：它是实时的，不受 instances.json 落盘（约 200ms）
      // 的延迟影响；M6 的 /api 用的也是这个单例，看到的实例集合一致。
      const runtime = await this.runtimeModule()
      for (const holder of moduleCandidates(runtime)) {
        const getManager = pickFunction(holder, ['getRuntimeManager'])
        if (!getManager) continue
        try {
          const manager = await getManager()
          const list = pickFunction(manager, ['list'])
          if (list) {
            const runtimes = await list()
            const snapshots = runtimes.map((rt) =>
              typeof rt?.status === 'function' ? rt.status() : rt
            )
            const normalized = normalizeInstances(snapshots)
            // 运行时一个实例都没有时，仍回退读 instances.json：
            // M2 还没 restore 完的旧实例也能被网关看到（认回后自动切到实时数据）。
            if (normalized.length > 0) return normalized
          }
        } catch {
          // 运行时拿不到就退回 M1，别因为 M2 的异常把路由搞挂
        }
        break
      }

      const mod = await this.registryModule()
      const fn = pickFunction(mod, ['loadInstances'])
      if (!fn) return []
      return normalizeInstances(await fn())
    })
  }

  async loadSecrets() {
    const mod = await this.configModule()
    const fn = pickFunction(mod, ['loadSecrets'])
    if (!fn) return {}
    try {
      const secrets = await fn()
      return isPlainObject(secrets) ? secrets : {}
    } catch {
      return {}
    }
  }

  async loadConfig() {
    return this.#cached('config', CACHE_TTL.config, async () => {
      const mod = await this.configModule()
      const fn = pickFunction(mod, ['loadConfig'])
      if (!fn) return {}
      const config = await fn()
      return isPlainObject(config) ? config : {}
    })
  }

  /** /health 用：模块到底是"没实现"还是"没有这个函数"。 */
  moduleState(spec, apiNames = []) {
    const hit = this.modules.get(spec)
    if (!hit) return 'not-probed'
    if (!hit.mod) return `missing: ${hit.error || 'unknown'}`
    const missing = apiNames.filter((name) => typeof hit.mod[name] !== 'function')
    return missing.length > 0 ? `missing api: ${missing.join(', ')}` : 'ok'
  }
}

// ---------------------------------------------------------------------------
// 网关
// ---------------------------------------------------------------------------

export class Gateway {
  constructor(options = {}) {
    this.options = options
    this.deps = isPlainObject(options.deps) ? options.deps : {}
    this.logger = options.logger === undefined ? console : options.logger
    this.data = new DataLayer({ core: isPlainObject(options.core) ? options.core : {} })

    this.server = null
    this.host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1'
    this.port = 0
    this.url = null
    this.lastError = null
    this.startedAt = Date.now()
    // M6 直接把 config 传进来时先收下，start() 就不用再读一遍 M1；没传就读 M1。
    this.config = isPlainObject(options.config)
      ? options.config
      : looksLikeConfig(options)
        ? options
        : {}

    this.engineHost = '127.0.0.1'
    this.idleTimeoutMs = positiveNumber(options.idleTimeoutMs, IDLE_TIMEOUT_MS)
    this.totalTimeoutMs = positiveNumber(options.totalTimeoutMs, TOTAL_TIMEOUT_MS)
    this.maxBodyBytes = positiveNumber(options.maxBodyBytes, MAX_BODY_BYTES)
    this.selfHealAfterFailures = SELF_HEAL_CONSECUTIVE
    this.selfHealDebounceMs = SELF_HEAL_DEBOUNCE_MS

    // 在飞请求：Set 用于超时/关闭；按实例再索引一份，自愈重启时能精准掐断。
    this.contexts = new Set()
    this.inflightByInstance = new Map()

    // 自愈状态
    this.failures = new Map() // instanceId → 连续 429/503 次数
    this.healing = new Set() // 正在自愈的 instanceId
    this.lastHealAt = new Map() // instanceId → 上次重启时间
    this.localHealLock = null // M4 没有锁接口时的进程内兜底

    this.metrics = {
      timeouts: { count: 0, last: null },
      selfHeal: {
        count: 0,
        lastAt: null,
        skipped: 0,
        errors: 0,
        lastError: null,
        lastStatus: null,
        killed: 0,
      },
    }

    this.lastModelId = null
    this.lastRequestAt = 0
    this.logOnceAt = new Map()
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  #applyConfig() {
    const config = this.config || {}
    const gatewayConfig = isPlainObject(config.gateway) ? config.gateway : {}

    this.idleTimeoutMs = positiveNumber(
      this.options.idleTimeoutMs ?? gatewayConfig.idleTimeoutMs ?? config.requestIdleTimeoutMs,
      IDLE_TIMEOUT_MS
    )
    this.totalTimeoutMs = positiveNumber(
      this.options.totalTimeoutMs ?? gatewayConfig.totalTimeoutMs ?? config.requestTimeoutMs,
      TOTAL_TIMEOUT_MS
    )
    this.maxBodyBytes = positiveNumber(
      this.options.maxBodyBytes ?? gatewayConfig.maxBodyBytes ?? config.maxBodyBytes,
      MAX_BODY_BYTES
    )

    // 自愈参数跟 config.json 走（DEFAULT_CONFIG: selfHeal.afterFailures / debounceMs）。
    const selfHealConfig = isPlainObject(config.selfHeal) ? config.selfHeal : {}
    this.selfHealAfterFailures = Math.max(
      1,
      Math.floor(positiveNumber(selfHealConfig.afterFailures, SELF_HEAL_CONSECUTIVE))
    )
    this.selfHealDebounceMs = positiveNumber(selfHealConfig.debounceMs, SELF_HEAL_DEBOUNCE_MS)

    // 端口/绑定地址也可以从 config.json 读；显式传参优先。
    if (!this.options.host) this.host = config.gatewayHost || config.host || this.host
    if (!this.options.engineHost) this.engineHost = config.engineHost || this.engineHost
  }

  #resolvePort() {
    const envPort = process.env.LACI_GATEWAY_PORT
    const config = this.config || {}
    const raw =
      this.options.port ??
      (envPort !== undefined && envPort !== '' ? Number(envPort) : undefined) ??
      config.gatewayPort ??
      config.routerPort ??
      GATEWAY_PORT
    const port = Number.parseInt(raw, 10)
    return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : GATEWAY_PORT
  }

  /**
   * 启动监听。失败不抛，返回 `{ ok:false, error }`，让 M6 能在控制台里显示
   * 「8095 被占用」而不是整个进程崩掉。
   */
  async start() {
    if (this.server) return { ok: true, url: this.url, port: this.port }

    if (!isPlainObject(this.config) || Object.keys(this.config).length === 0) {
      try {
        this.config = await this.data.loadConfig()
      } catch {
        this.config = {}
      }
    }
    this.#applyConfig()

    const requestedPort = this.#resolvePort()
    this.port = requestedPort

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.#logError('handle', err)
        this.#fail(req, res, 503, `网关内部错误：${err?.message || err}`, 'gateway_internal', {
          path: req.url || '/',
        })
      })
    })

    // Node 默认 requestTimeout=300s 会在 5 分钟时掐掉"还在上传"的请求，跟我们的
    // 900 秒总时长冲突。这里对齐到总时长：它只约束"接收完请求体"，不会掐长响应，
    // 同时兜住"JSON body 读一半卡住"（那条路还没进 #proxy，没有网关自己的看门狗）。
    server.requestTimeout = this.totalTimeoutMs
    server.headersTimeout = 60_000
    server.timeout = 0
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      this.#logError('clientError', err)
    })

    const listenResult = await new Promise((resolve) => {
      const onError = (err) => {
        const message =
          err?.code === 'EADDRINUSE'
            ? `端口 ${requestedPort} 被占用（是不是旧的 LACI/网关还在跑？）`
            : err?.message || String(err)
        resolve({ ok: false, error: message })
      }
      server.once('error', onError)
      server.listen(requestedPort, this.host, () => {
        server.off('error', onError)
        resolve({ ok: true })
      })
    })

    if (!listenResult.ok) {
      this.lastError = listenResult.error
      this.server = null
      this.url = null
      return { ok: false, error: listenResult.error, port: requestedPort }
    }

    this.server = server
    const address = server.address()
    if (address && typeof address === 'object') this.port = address.port
    this.url = `http://${formatHost(this.host)}:${this.port}`
    this.lastError = null

    server.on('error', (err) => {
      this.lastError = err?.message || String(err)
      this.#logError('server', err)
    })
    server.on('close', () => {
      if (this.server === server) this.server = null
    })

    this.#log(`监听 ${this.url}（只转发，不启停引擎）`)
    return { ok: true, url: this.url, port: this.port }
  }

  async close() {
    for (const ctx of [...this.contexts]) {
      try {
        ctx.destroy()
      } catch {
        /* 关闭过程里忽略 */
      }
    }
    this.contexts.clear()
    this.inflightByInstance.clear()

    const server = this.server
    this.server = null
    if (!server) return

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        // 3 秒还没关干净（keep-alive 连接），强制断。
        try {
          server.closeAllConnections?.()
        } catch {
          /* ignore */
        }
        resolve()
      }, 3_000)
      if (typeof timer.unref === 'function') timer.unref()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  async handle(req, res) {
    const startedAt = Date.now()
    res.once('finish', () => {
      this.#log(
        `${res.statusCode} ${req.method} ${safeUrlForLog(req.url)} ${Date.now() - startedAt}ms`
      )
    })

    let url
    try {
      url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    } catch {
      this.#fail(req, res, 400, '非法的请求 URL', 'bad_request', { path: req.url || '/' })
      return
    }
    const pathname = url.pathname

    try {
      // /health 是给自己看的，格式随便改；/v1/* 是契约，不能变。
      if (pathname === '/health' || pathname === '/health/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          this.#fail(req, res, 405, '/health 只接受 GET', 'method_not_allowed', { path: pathname })
          return
        }
        await this.#health(req, res)
        return
      }

      if (!pathname.startsWith('/v1/') && pathname !== '/v1') {
        this.#fail(req, res, 404, `未知路径 ${pathname}：网关只暴露 /v1/* 和 /health`, 'not_found', {
          path: pathname,
        })
        return
      }

      if (pathname === '/v1/models' || pathname === '/v1/models/') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          this.#fail(req, res, 405, '/v1/models 只接受 GET', 'method_not_allowed', { path: pathname })
          return
        }
        await this.#models(req, res)
        return
      }

      if (pathname === '/v1' || pathname === '/v1/') {
        this.#fail(req, res, 404, '要模型列表请用 /v1/models', 'not_found', { path: pathname })
        return
      }

      // multipart 必须直接 pipe（§5.13）：不能先读 body 再重发。
      if (isMultipart(req.headers['content-type'])) {
        await this.#proxyMultipart(req, res, url)
        return
      }

      if (NO_BODY_METHODS.has(req.method)) {
        await this.#proxyWithoutBody(req, res, url)
        return
      }

      await this.#proxyJson(req, res, url)
    } catch (err) {
      // 业务错误已经在各分支里回过了；能到这里的是意外（模块抛异常之类）。
      this.#logError(`${req.method} ${pathname}`, err)
      this.#fail(req, res, 503, `网关处理失败：${err?.message || err}`, 'gateway_error', {
        path: pathname,
      })
    }
  }

  // -------------------------------------------------------------------------
  // GET /v1/models
  // -------------------------------------------------------------------------

  /**
   * 模型列表以「模型档案」为准，不看引擎在不在——DSH 不读这个接口（§5.11），
   * 但其他 OpenAI 客户端会读；列出来比列不出来有用。
   * 附加 kind / status 两个 LACI 扩展字段，OpenAI 客户端会忽略。
   */
  async #models(req, res) {
    let models = []
    let degraded = null

    const registry = await this.data.registryModule()
    if (!registry) {
      degraded = 'core/registry.mjs 还没就绪'
      this.#logOnce('registry-missing', `[gateway] 数据层不可用：${degraded}（/v1/models 返回空列表）`)
    }

    try {
      models = await this.#allModels()
    } catch (err) {
      degraded = err?.message || String(err)
      this.#logError('listModels', err)
    }

    const instances = await this.data.listInstances().catch(() => [])
    const readyByModel = new Map()
    for (const instance of instances) {
      if (!isReadyInstance(instance)) continue
      for (const modelId of instanceModelIds(instance)) readyByModel.set(modelId, instance)
    }

    const data = models.map((model) => {
      const instance = readyByModel.get(model.id) || null
      return {
        id: model.id,
        object: 'model',
        created: Number(model.created) || 0,
        owned_by: model.remote ? model.engineId || 'cloud' : 'laci',
        // LACI 扩展字段
        kind: model.kind || 'chat',
        status: model.remote ? 'remote' : instance ? 'ready' : 'idle',
        laci: {
          engineId: model.engineId ?? null,
          instanceId: instance?.id ?? null,
          contextWindow: model.contextWindow ?? model.params?.maxContext ?? null,
          maxTokens: model.maxTokens ?? null,
          remote: Boolean(model.remote),
        },
      }
    })

    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (degraded) headers['x-laci-degraded'] = '1'
    try {
      res.writeHead(200, headers)
      res.end(JSON.stringify({ object: 'list', data }))
    } catch (err) {
      this.#logError('models-response', err)
    }
  }

  // -------------------------------------------------------------------------
  // JSON body 请求（chat / messages / responses / audio speech / images / ...）
  // -------------------------------------------------------------------------

  async #proxyJson(req, res, url) {
    const registry = await this.data.registryModule()
    if (!registry) {
      this.#fail(
        req,
        res,
        503,
        '数据层不可用：core/registry.mjs 还没就绪，读不到模型和实例定义',
        'registry_unavailable',
        { path: url.pathname, retryAfter: 5 }
      )
      return
    }

    const bodyResult = await this.#readBody(req)
    if (bodyResult.error) {
      this.#fail(req, res, bodyResult.error.status, bodyResult.error.message, bodyResult.error.code, {
        path: url.pathname,
      })
      return
    }

    let body
    try {
      body = JSON.parse(bodyResult.text)
    } catch {
      this.#fail(req, res, 400, '请求体不是合法 JSON', 'invalid_json', { path: url.pathname })
      return
    }
    if (!isPlainObject(body)) {
      this.#fail(req, res, 400, '请求体必须是 JSON 对象', 'invalid_json', { path: url.pathname })
      return
    }

    const modelId = requestModelHint(req, url, body)
    if (!modelId) {
      this.#fail(req, res, 400, '请求里缺少 model 字段（网关只按 model 路由）', 'model_required', {
        path: url.pathname,
      })
      return
    }

    const model = await this.#findModel(modelId)
    if (!model) {
      this.#fail(req, res, 404, `未知模型：${modelId}（模型档案里没有这个 id）`, 'model_not_found', {
        path: url.pathname,
      })
      return
    }

    const target = await this.#resolveTarget(model)
    if (target.status) {
      this.#fail(req, res, target.status, target.message, target.code, {
        path: url.pathname,
        retryAfter: target.retryAfter,
      })
      return
    }

    // D3 + D4：只在需要时重新序列化，未改动的 body 原样转发（字节级不变）。
    const changedByModelId = rewriteModelId(body, model, target)
    const changedByThinking = stripThinkingOverrides(body, model, url.pathname)
    const payload =
      changedByModelId || changedByThinking
        ? Buffer.from(JSON.stringify(body), 'utf8')
        : bodyResult.buffer

    return this.#proxy(req, res, target, model, payload)
  }

  // -------------------------------------------------------------------------
  // multipart 请求（/v1/audio/transcriptions 等）
  // -------------------------------------------------------------------------

  /**
   * 这里绝不读 body：`#proxy` 里直接 `req.pipe(upstream)`。
   * 但路由必须在建连之前决定，而 multipart 的 model 字段在 body 里，读它就要
   * 先缓冲/解析——所以按以下顺序找 model：
   *   1. `?model=`（最可靠，客户端愿意配合就用这个）
   *   2. `x-laci-model` / `x-model` 头
   *   3. 路径 kind 下「唯一在跑」的模型；多个则 400，要求显式指定
   * 这是"绝不破坏 multipart"的代价，写在文件头和 /health 的注释里。
   */
  async #proxyMultipart(req, res, url) {
    const registry = await this.data.registryModule()
    if (!registry) {
      this.#fail(
        req,
        res,
        503,
        '数据层不可用：core/registry.mjs 还没就绪，读不到模型和实例定义',
        'registry_unavailable',
        { path: url.pathname, retryAfter: 5 }
      )
      return
    }

    const explicit = requestModelHint(req, url, null)
    let model = null
    let target = null

    if (explicit) {
      model = await this.#findModel(explicit)
      if (!model) {
        this.#fail(req, res, 404, `未知模型：${explicit}（模型档案里没有这个 id）`, 'model_not_found', {
          path: url.pathname,
        })
        return
      }
      target = await this.#resolveTarget(model)
    } else {
      const kind = kindForPath(url.pathname)
      const picked = await this.#pickSingleReady(kind)
      if (picked.status) {
        this.#fail(req, res, picked.status, picked.message, picked.code, {
          path: url.pathname,
          retryAfter: picked.retryAfter,
        })
        return
      }
      model = picked.model
      target = picked.target
    }

    if (target.status) {
      this.#fail(req, res, target.status, target.message, target.code, {
        path: url.pathname,
        retryAfter: target.retryAfter,
      })
      return
    }

    // body 传 undefined ⇒ #proxy 走 `req.pipe(upstream)`，一个字节都不碰。
    return this.#proxy(req, res, target, model, undefined)
  }

  /** multipart 读不到 model 时，按 kind 找唯一在跑的模型。 */
  async #pickSingleReady(kind) {
    const [models, instances] = await Promise.all([
      this.#allModels(),
      this.data.listInstances(),
    ])
    const byId = new Map(models.map((model) => [model.id, model]))
    const found = []

    for (const instance of instances) {
      if (!isReadyInstance(instance)) continue
      const port = Number(instance.port)
      for (const modelId of instanceModelIds(instance)) {
        const model = byId.get(modelId)
        if (!model || !modelMatchesKind(model, kind)) continue
        found.push({
          model,
          target: { kind: 'local', model, instance, host: this.engineHost, port },
        })
      }
    }

    if (found.length === 0) {
      return {
        status: 503,
        code: 'model_not_loaded',
        message: `没有正在跑的${kindLabel(kind)}模型：去 LACI 控制台加载一个，或者用 ?model=<id> 指定（网关不会自动加载）`,
        retryAfter: 5,
      }
    }
    if (found.length > 1) {
      const ids = found.map((item) => item.model.id).join('、')
      return {
        status: 400,
        code: 'model_required',
        message: `有多个${kindLabel(kind)}模型在跑（${ids}）。multipart 请求读不到 body 里的 model，请用 ?model=<id> 或 x-laci-model 头指定`,
      }
    }
    return found[0]
  }

  // -------------------------------------------------------------------------
  // 无 body 请求（GET / DELETE / OPTIONS 的兜底透传）
  // -------------------------------------------------------------------------

  async #proxyWithoutBody(req, res, url) {
    const registry = await this.data.registryModule()
    if (!registry) {
      this.#fail(
        req,
        res,
        503,
        '数据层不可用：core/registry.mjs 还没就绪，读不到模型和实例定义',
        'registry_unavailable',
        { path: url.pathname, retryAfter: 5 }
      )
      return
    }

    const modelId = requestModelHint(req, url, null)
    if (!modelId) {
      this.#fail(
        req,
        res,
        404,
        `${req.method} ${url.pathname} 需要指定模型：用 ?model= 或 x-laci-model 头（/v1/models 不需要）`,
        'model_required',
        { path: url.pathname }
      )
      return
    }

    const model = await this.#findModel(modelId)
    if (!model) {
      this.#fail(req, res, 404, `未知模型：${modelId}（模型档案里没有这个 id）`, 'model_not_found', {
        path: url.pathname,
      })
      return
    }

    const target = await this.#resolveTarget(model)
    if (target.status) {
      this.#fail(req, res, target.status, target.message, target.code, {
        path: url.pathname,
        retryAfter: target.retryAfter,
      })
      return
    }

    return this.#proxy(req, res, target, model, undefined)
  }

  // -------------------------------------------------------------------------
  // 模型 / 目标解析
  // -------------------------------------------------------------------------

  /**
   * 模型档案 + 云端引擎里声明的 models 合并成一个列表。
   * 本地档案优先（同一 id 重名在保存时就会被 M1 拒绝，这里只是兜底）。
   */
  async #allModels() {
    const [models, engines] = await Promise.all([this.data.listModels(), this.data.listEngines()])
    const byId = new Map()
    for (const model of models) byId.set(model.id, model)

    for (const engine of engines) {
      if (!engine || engine.mode !== 'remote' || !Array.isArray(engine.models)) continue
      for (const remote of engine.models) {
        if (!isPlainObject(remote)) continue
        const id = normalizeModelId(remote.id)
        if (!id || byId.has(id)) continue
        byId.set(id, {
          id,
          label: remote.label || id,
          kind: remote.kind || 'chat',
          engineId: engine.id,
          remote: true,
          contextWindow: remote.contextWindow,
          maxTokens: remote.maxTokens,
        })
      }
    }
    return [...byId.values()]
  }

  async #findModel(modelId) {
    const models = await this.#allModels()
    return models.find((model) => model.id === modelId) || null
  }

  /**
   * model → 转发目标。
   * 返回 `{ status, message, code, retryAfter }` 表示失败（调用方直接回错误）；
   * 返回 `{ kind:'local' | 'remote', ... }` 表示可以转发。
   */
  async #resolveTarget(model) {
    let engine = null
    if (model.engineId) {
      try {
        engine = await this.data.loadEngine(model.engineId)
      } catch {
        engine = null
      }
    }

    // ---- 云端 ----
    if (model.remote || engine?.mode === 'remote') {
      if (!engine) {
        return {
          status: 503,
          code: 'engine_missing',
          message: `模型 ${model.id} 指向的云端引擎 ${model.engineId || '(未配置)'} 不存在`,
        }
      }
      if (typeof engine.baseURL !== 'string' || engine.baseURL.trim() === '') {
        return {
          status: 503,
          code: 'remote_misconfigured',
          message: `云端引擎 ${engine.id} 没有 baseURL，去控制台补上`,
        }
      }
      let url
      try {
        url = new URL(engine.baseURL)
      } catch {
        return {
          status: 503,
          code: 'remote_misconfigured',
          message: `云端引擎 ${engine.id} 的 baseURL 不是合法 URL：${engine.baseURL}`,
        }
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return {
          status: 503,
          code: 'remote_misconfigured',
          message: `云端引擎 ${engine.id} 的 baseURL 只能是 http/https：${engine.baseURL}`,
        }
      }
      const credential = await this.#remoteKey(engine)
      if (!credential.key && credential.source !== 'none') {
        return { status: 503, code: 'remote_key_missing', message: credential.message }
      }
      // 云端不参与显存/端口/起停/对账，只做纯转发（§5.12）。
      return {
        kind: 'remote',
        model,
        engine,
        url,
        key: credential.key,
        keySource: credential.source,
      }
    }

    // ---- 本地 ----
    let instance = null
    try {
      if (typeof this.deps.findInstance === 'function') {
        // M4 将来可以直接给 `model.id → instance`（契约 §5.9）；现在没有就用实例表。
        instance = await this.deps.findInstance(model.id)
      }
      if (!instance) {
        const instances = await this.data.listInstances()
        // 同一个模型理论上只在一个实例里；先找可路由的 ready，找不到再拿任意包含它的
        // 实例出来，好把 starting / stopping / error 说得更具体。
        const containing = instances.filter(
          (item) => item.ephemeral !== true && instanceModelIds(item).includes(model.id)
        )
        instance = containing.find(isReadyInstance) || containing[0] || null
      }
    } catch (err) {
      return {
        status: 503,
        code: 'instances_unavailable',
        message: `读不到实例表：${err?.message || err}`,
        retryAfter: 5,
      }
    }

    if (instance) {
      const phase = instancePhase(instance)
      if (this.healing.has(instance.id)) {
        return {
          status: 503,
          code: 'engine_restarting',
          message: `引擎正在自愈重启（实例 ${instance.id}），请稍后重试`,
          retryAfter: 5,
        }
      }
      if (phase === 'starting') {
        return {
          status: 503,
          code: 'engine_starting',
          message: `模型 ${model.id} 正在启动，请稍后重试`,
          retryAfter: 5,
        }
      }
      if (phase === 'stopping') {
        return {
          status: 503,
          code: 'engine_stopping',
          message: `模型 ${model.id} 正在关闭，请稍后重试`,
          retryAfter: 5,
        }
      }
      if (phase === 'error') {
        return {
          status: 503,
          code: 'engine_error',
          message: `模型 ${model.id} 的实例处于 error 状态：去控制台看一下日志，必要时重新加载`,
        }
      }
    }

    if (!instance) {
      /* 自动匹配：模型没被 LACI 加载，但引擎端口上已经有服务（外部起的），直接转过去 */
      const fallbackPort = Number(engine?.defaultPort)
      if (Number.isInteger(fallbackPort) && fallbackPort > 0) {
        try {
          const probe = await fetch(`http://127.0.0.1:${fallbackPort}/v1/models`, { signal: AbortSignal.timeout(700) })
          if (probe.ok) {
            const body = await probe.json().catch(() => null)
            const ids = Array.isArray(body?.data) ? body.data.map((m) => m && m.id).filter(Boolean) : []
            if (ids.length === 0) throw new Error('empty model list')
            return {
              kind: 'local',
              model,
              instance: { id: `ext-${engine.id}`, port: fallbackPort, reportedModelIds: ids },
              host: this.engineHost,
              port: fallbackPort,
            }
          }
        } catch {
          /* 端口没服务就继续走 503 */
        }
      }
    }

    const port = Number(instance?.port)
    if (!instance || instancePhase(instance) !== 'ready' || !Number.isInteger(port) || port <= 0) {
      // 关键：本地没加载就 503，**绝不**自动转云端（§5.12：静默花钱比静默错误更糟）。
      return {
        status: 503,
        code: 'model_not_loaded',
        message: `模型 ${model.id} 没有在跑：去 LACI 控制台点「载入」。网关不会自动加载，也不会偷偷转到云端同款模型`,
      }
    }

    // 按实例的真实端口转发，不按配置猜（§5.3）。
    return { kind: 'local', model, instance, host: this.engineHost, port }
  }

  /** 云端 key：apiKeyEnv 优先，其次 secrets[keyRef]（secrets 永不导出）。 */
  async #remoteKey(engine) {
    const envName = engine.apiKeyEnv || engine.auth?.apiKeyEnv || null
    if (envName) {
      const value = process.env[envName]
      if (typeof value === 'string' && value.trim() !== '') {
        return { key: value.trim(), source: `env:${envName}` }
      }
    }

    // auth.type === "none"：本机/内网的无鉴权云端（LM Studio 之类），不要硬要 key。
    if (engine.auth?.type === 'none') return { key: null, source: 'none' }

    const keyRef = engine.auth?.keyRef || engine.auth?.secretRef || engine.id
    let secrets = {}
    try {
      secrets = await this.data.loadSecrets()
    } catch {
      secrets = {}
    }
    const value = secrets?.[keyRef] ?? (keyRef !== engine.id ? secrets?.[engine.id] : undefined)
    if (typeof value === 'string' && value.trim() !== '') {
      return { key: value.trim(), source: `secrets:${keyRef}` }
    }

    return {
      message: `云端引擎 ${engine.id} 没有 API key：去控制台填入 secrets["${keyRef}"]${
        envName ? `，或设置环境变量 ${envName}` : ''
      }。网关不会在无 key 的情况下直连云端`,
    }
  }

  // -------------------------------------------------------------------------
  // 转发（唯一碰连接的地方）
  // -------------------------------------------------------------------------

  /**
   * 所有转发都走这里：本地实例 / 云端 baseURL 共用同一套超时、自愈、错误处理。
   * body 为 Buffer 时一次性写入；为 undefined 时直接 pipe（multipart / 无 body）。
   */
  #proxy(req, res, target, model, body) {
    const now = Date.now()
    const ctx = {
      req,
      res,
      target,
      modelId: model?.id || null,
      path: req.url || '/',
      startedAt: now,
      lastActivity: now,
      done: false,
      timeoutKind: null,
      aborted: false,
      upstream: null,
      ticker: null,
      instanceId: target.kind === 'local' ? target.instance?.id || null : null,
    }

    const finish = () => {
      if (ctx.done) return
      ctx.done = true
      if (ctx.ticker) clearInterval(ctx.ticker)
      this.contexts.delete(ctx)
      if (ctx.instanceId) {
        const set = this.inflightByInstance.get(ctx.instanceId)
        if (set) {
          set.delete(ctx)
          if (set.size === 0) this.inflightByInstance.delete(ctx.instanceId)
        }
      }
    }
    ctx.finish = finish

    ctx.destroy = () => {
      try {
        ctx.upstream?.destroy()
      } catch {
        /* ignore */
      }
      try {
        ctx.res.destroy()
      } catch {
        /* ignore */
      }
      finish()
    }

    /**
     * 自愈重启会杀掉进程，正在跑的请求不能假装成功：头还没发就回 502，
     * 已经发出去的 SSE 只能掐断（客户端会看到流提前结束）。
     */
    ctx.killForRestart = (message) => {
      if (ctx.done) return
      if (!ctx.res.headersSent) {
        this.#fail(ctx.req, ctx.res, 502, message, 'engine_restarted', {
          path: ctx.path,
          ctx,
        })
      } else {
        try {
          ctx.res.destroy()
        } catch {
          /* ignore */
        }
      }
      try {
        ctx.upstream?.destroy()
      } catch {
        /* ignore */
      }
      finish()
    }

    this.contexts.add(ctx)
    if (ctx.instanceId) {
      let set = this.inflightByInstance.get(ctx.instanceId)
      if (!set) {
        set = new Set()
        this.inflightByInstance.set(ctx.instanceId, set)
      }
      set.add(ctx)
    }
    this.lastRequestAt = now
    if (model?.id) this.lastModelId = model.id

    const headers = buildUpstreamHeaders(req, target, body)
    let transport
    let requestOptions

    if (target.kind === 'remote') {
      transport =
        target.url.protocol === 'https:'
          ? this.deps.httpsTransport || https
          : this.deps.httpTransport || http
      requestOptions = {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port:
          target.url.port ||
          (target.url.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: joinRemotePath(target.url.pathname, req.url || '/'),
        headers,
      }
    } else {
      // deps.httpTransport 只给单测用：注入一个假 transport 就能在进程内验证
      // 超时 504 / 429×2 自愈 / 重启掐断在飞请求，不用真起一个引擎。
      transport = this.deps.httpTransport || http
      requestOptions = {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url || '/',
        headers,
      }
    }

    let upstream
    try {
      upstream = transport.request(requestOptions, (upstreamRes) => {
        if (ctx.done) {
          upstreamRes.resume()
          return
        }

        const status = upstreamRes.statusCode || 502
        this.#noteStatus(ctx, status)

        const downstreamHeaders = buildDownstreamHeaders(upstreamRes.headers, target, model?.id)
        try {
          res.writeHead(status, downstreamHeaders)
          // 早点把头发出去：SSE 的首字节延迟才不会被 Node 攒到第一次 write 之后。
          res.flushHeaders?.()
        } catch (err) {
          this.#logError('writeHead', err)
          try {
            res.destroy()
          } catch {
            /* ignore */
          }
          try {
            upstreamRes.destroy()
          } catch {
            /* ignore */
          }
          finish()
          return
        }

        res.socket?.setNoDelay?.(true)
        upstreamRes.on('data', () => {
          ctx.lastActivity = Date.now()
        })
        upstreamRes.on('error', () => {
          try {
            res.destroy()
          } catch {
            /* ignore */
          }
        })
        upstreamRes.on('aborted', () => {
          try {
            res.destroy()
          } catch {
            /* ignore */
          }
        })
        // 原样 pipe：不缓冲、不聚合、不改 SSE 分帧。
        upstreamRes.pipe(res)
      })
    } catch (err) {
      this.#fail(req, res, 502, `无法连接引擎：${err?.message || err}`, 'upstream_unreachable', {
        path: ctx.path,
        ctx,
      })
      finish()
      return
    }

    ctx.upstream = upstream
    upstream.on('socket', (socket) => {
      socket.setNoDelay?.(true)
    })

    upstream.on('error', (err) => {
      if (ctx.done) return
      if (ctx.timeoutKind || ctx.aborted) {
        finish()
        return
      }
      this.#logError(`upstream ${ctx.modelId || ''} ${target.kind}`, err)
      const message = this.#upstreamErrorMessage(ctx, err)
      this.#fail(ctx.req, ctx.res, 502, message, 'engine_crashed', {
        path: ctx.path,
        ctx,
      })
      finish()
    })

    upstream.on('close', () => {
      // 正常情况下 res 的 finish 会负责收尾；这里只处理"还没收尾就关了"。
      if (!ctx.done && (res.writableEnded || ctx.timeoutKind)) finish()
    })

    res.on('finish', finish)
    res.on('close', () => {
      if (!res.writableFinished) this.#clientAborted(ctx)
    })
    req.on('aborted', () => this.#clientAborted(ctx))
    req.on('error', () => this.#clientAborted(ctx))

    // 1 秒一跳的看门狗，比每个 chunk 重设定时器便宜，180 秒的精度够用。
    ctx.ticker = setInterval(() => this.#checkTimeout(ctx), 1_000)

    if (body !== undefined) {
      upstream.end(body)
    } else if (req.readableEnded) {
      upstream.end()
    } else {
      // ★ multipart 走这里：直接 pipe，不读、不解析、不重发。
      req.pipe(upstream)
    }

    // 上传也是"活动"：长音频上传期间不能算空闲。
    // 放在 pipe 之后挂，确保不会因为提前切到 flowing 而抢在 pipe 之前吃掉数据。
    req.on('data', () => {
      ctx.lastActivity = Date.now()
    })
  }

  #checkTimeout(ctx) {
    if (ctx.done) return
    const now = Date.now()
    if (now - ctx.startedAt >= this.totalTimeoutMs) {
      this.#onTimeout(ctx, 'total')
      return
    }
    if (now - ctx.lastActivity >= this.idleTimeoutMs) {
      this.#onTimeout(ctx, 'idle')
    }
  }

  #onTimeout(ctx, kind) {
    if (ctx.done || ctx.timeoutKind) return
    ctx.timeoutKind = kind
    const seconds = Math.round(
      (kind === 'idle' ? this.idleTimeoutMs : this.totalTimeoutMs) / 1_000
    )
    const reason =
      kind === 'idle'
        ? `空闲 ${seconds} 秒没有数据往来`
        : `总时长超过 ${seconds} 秒`

    this.metrics.timeouts.count += 1
    this.metrics.timeouts.last = {
      at: Date.now(),
      reason,
      model: ctx.modelId,
      path: ctx.path,
      instanceId: ctx.instanceId,
    }
    this.#log(`超时（${reason}） model=${ctx.modelId || '-'} path=${ctx.path}`)

    if (!ctx.res.headersSent) {
      this.#fail(ctx.req, ctx.res, 504, `请求超时：${reason}。已断开，不会重放。`, 'laci_timeout', {
        path: ctx.path,
        ctx,
      })
    } else {
      // 已经流出去一半了，状态码改不了，只能掐断。
      try {
        ctx.res.destroy()
      } catch {
        /* ignore */
      }
    }

    try {
      ctx.upstream?.destroy()
    } catch {
      /* ignore */
    }
    ctx.finish()
  }

  #clientAborted(ctx) {
    if (ctx.done) return
    ctx.aborted = true
    try {
      ctx.upstream?.destroy()
    } catch {
      /* ignore */
    }
    ctx.finish()
  }

  #upstreamErrorMessage(ctx, err) {
    if (ctx.instanceId && this.healing.has(ctx.instanceId)) return ENGINE_RESTARTED_MESSAGE
    if (err?.code === 'ECONNREFUSED') {
      return `引擎端口没开（${ctx.target.host}:${ctx.target.port}）：实例可能已经退出。请回控制台确认后重发，网关不会自动重放（工具调用不幂等）。`
    }
    return ENGINE_CRASHED_MESSAGE
  }

  // -------------------------------------------------------------------------
  // 自愈（429 / 503 ×2，90 秒去抖）
  // -------------------------------------------------------------------------

  #noteStatus(ctx, status) {
    // 云端限流不归我们管：重启本地引擎毫无意义，也违反"不自作主张"。
    if (ctx.target.kind !== 'local' || !ctx.instanceId) return

    const instanceId = ctx.instanceId
    if (status < 400) {
      this.failures.delete(instanceId)
      return
    }
    if (status !== 429 && status !== 503) return

    const failures = (this.failures.get(instanceId) || 0) + 1
    this.failures.set(instanceId, failures)
    if (failures < this.selfHealAfterFailures) return

    // 去抖：同一个实例在 debounceMs 内只重启一次（默认 90 秒）。
    const lastHeal = this.lastHealAt.get(instanceId) || 0
    if (Date.now() - lastHeal < this.selfHealDebounceMs) return

    void this.#selfHeal(instanceId, status).catch((err) => this.#logError('self-heal', err))
  }

  async #selfHeal(instanceId, status) {
    if (this.healing.has(instanceId)) return
    this.failures.delete(instanceId)
    this.healing.add(instanceId)

    let lease = null
    try {
      // 规则 4：要动手的都抢账本；用户正在加载/切换时直接跳过这次。
      if (this.#userBusy()) {
        this.metrics.selfHeal.skipped += 1
        this.#log(`自愈跳过：用户正在加载/切换（实例 ${instanceId}）`)
        return
      }
      lease = await this.#acquireHealLease(instanceId)
      if (!lease) {
        this.metrics.selfHeal.skipped += 1
        this.#log(`自愈跳过：账本被占用（实例 ${instanceId}）`)
        return
      }

      const instances = await this.data.listInstances().catch(() => [])
      // 账本之外再加一道保险：别的实例正在 starting/stopping 就是用户正在加载/切换，
      // 这时候重启会跟 M2/M6 打架，跳过这次。
      const busy = instances.find(
        (item) => item.id !== instanceId && ['starting', 'stopping'].includes(instancePhase(item))
      )
      if (busy) {
        this.metrics.selfHeal.skipped += 1
        this.#log(`自愈跳过：实例 ${busy.id} 正在 ${instancePhase(busy)}（用户操作中）`)
        return
      }

      const restart = await this.#resolveRestart()
      if (!restart) {
        this.metrics.selfHeal.errors += 1
        this.metrics.selfHeal.lastError =
          '没有可用的重启接口：等 M2/M4 提供 restartInstance()，或通过构造参数 deps.restartInstance 注入'
        this.#log(`自愈失败：${this.metrics.selfHeal.lastError}（实例 ${instanceId}）`)
        return
      }

      const instance = instances.find((item) => item.id === instanceId) || { id: instanceId }

      this.lastHealAt.set(instanceId, Date.now())
      this.metrics.selfHeal.count += 1
      this.metrics.selfHeal.lastAt = Date.now()
      this.metrics.selfHeal.lastStatus = status
      this.#log(
        `实例 ${instanceId} 连续 ${status}，重启自愈（第 ${this.metrics.selfHeal.count} 次）`
      )

      // 先掐断在飞请求：重启会杀掉进程，这些请求必须回 502，而不是等超时或假装成功。
      this.#killInflight(instanceId, ENGINE_RESTARTED_MESSAGE)

      await restart(instance)

      // 规则 5：重启算"刚有活动"，重置空闲计时，别刚重启完就被判空闲卸载。
      this.lastRequestAt = Date.now()
      try {
        this.deps.resetIdle?.(instanceId)
      } catch {
        /* 可选钩子 */
      }
    } catch (err) {
      this.metrics.selfHeal.errors += 1
      this.metrics.selfHeal.lastError = err?.message || String(err)
      this.#logError('self-heal-restart', err)
    } finally {
      try {
        lease?.release?.()
      } catch (err) {
        this.#logError('release-heal-lease', err)
      }
      this.healing.delete(instanceId)
    }
  }

  #killInflight(instanceId, message) {
    const set = this.inflightByInstance.get(instanceId)
    if (!set || set.size === 0) return
    const contexts = [...set]
    this.metrics.selfHeal.killed += contexts.length
    for (const ctx of contexts) {
      try {
        ctx.killForRestart(message)
      } catch (err) {
        this.#logError('kill-inflight', err)
      }
    }
  }

  /**
   * 抢账本。优先用 M4 的锁接口；M4 还没实现时退化为进程内锁（单进程里网关是
   * 唯一会自愈的人，等价）。注意**不要**用 ledger.reserve()——那是显存预留，
   * 拿它当互斥锁会把账本搞乱。
   */
  async #acquireHealLease(instanceId) {
    const injected = this.deps.acquireLock || this.deps.acquireHealLock
    if (typeof injected === 'function') {
      const result = await injected({ reason: 'self-heal', instanceId })
      return toLease(result, () => {
        try {
          this.deps.releaseLock?.({ reason: 'self-heal', instanceId })
        } catch {
          /* ignore */
        }
      })
    }

    const ledger = await this.data.ledgerModule()
    for (const holder of moduleCandidates(ledger)) {
      // 只认"锁"语义的方法名；reserve / estimate 属于显存账，不能当锁用。
      const fn = pickFunction(holder, ['tryLock', 'lock', 'acquireLock', 'tryAcquire', 'acquire'])
      if (!fn) continue
      const result = await fn({ reason: 'self-heal', instanceId, ttlMs: 120_000 })
      const lease = toLease(result, () => {
        try {
          holder.release?.(instanceId)
        } catch {
          /* ignore */
        }
      })
      // 有锁接口但抢不到 → 跳过这次，不要再用本地锁兜底（会和 M4 打架）。
      return lease
    }

    if (this.localHealLock) return null
    this.localHealLock = instanceId
    return {
      release: () => {
        if (this.localHealLock === instanceId) this.localHealLock = null
      },
    }
  }

  #userBusy() {
    try {
      const info = this.deps.lockInfo?.()
      return Boolean(info?.held)
    } catch {
      return false
    }
  }

  /**
   * 找重启接口。候选顺序：
   *   1. 注入的 deps.restartInstance(instance)
   *   2. core/runtime.mjs 的 restartInstance / restart / restartEngine → 传 instance.id
   *   3. core/runtime.mjs 的 getRuntime(id) / getInstance(id) → 对象上的 .restart()
   *   4. core/runtime.mjs 的 getRuntimeManager().get(id) → InstanceRuntime：
   *      先试 .restart()，没有就 .stop() + .start()（M2 目前是后者）
   *   5. core/scheduler.mjs 的同名函数（M4/M6 的编排模块文件名还没定，宽容试）
   * 都没有就返回 null —— 网关不会自己 spawn 进程（边界：不启停进程）。
   */
  async #resolveRestart() {
    if (typeof this.deps.restartInstance === 'function') {
      return (instance) => this.deps.restartInstance(instance)
    }

    const runtime = await this.data.runtimeModule()
    for (const holder of moduleCandidates(runtime)) {
      const fn = pickFunction(holder, ['restartInstance', 'restart', 'restartEngine'])
      if (fn) return (instance) => fn(instance.id)
    }
    for (const holder of moduleCandidates(runtime)) {
      const getter = pickFunction(holder, ['getRuntime', 'getInstance', 'get'])
      if (!getter) continue
      return async (instance) => {
        const runtimeInstance = await getter(instance.id)
        if (!runtimeInstance || typeof runtimeInstance.restart !== 'function') {
          throw new Error(`取不到实例 ${instance.id} 的运行时，无法重启`)
        }
        await runtimeInstance.restart()
      }
    }

    // M2 的真实形态（core/runtime.mjs）：getRuntimeManager() → manager.get(id)。
    // 现在 InstanceRuntime 没有 restart()，所以 stop → start 就是重启：
    // 实例对象里的 engine/models/port 都还在，不是"新建一个实例"。
    for (const holder of moduleCandidates(runtime)) {
      const managerGetter = pickFunction(holder, ['getRuntimeManager', 'getManager'])
      if (!managerGetter) continue
      const manager = await managerGetter()
      const getter = pickFunction(manager, ['get'])
      if (!getter) continue
      return async (instance) => {
        const runtimeInstance = await getter(instance.id)
        if (!runtimeInstance) throw new Error(`没有实例 ${instance.id} 的运行时，无法重启`)
        if (typeof runtimeInstance.restart === 'function') {
          await runtimeInstance.restart()
          return
        }
        if (
          typeof runtimeInstance.stop === 'function' &&
          typeof runtimeInstance.start === 'function'
        ) {
          await runtimeInstance.stop({ force: true, graceMs: 2_000 })
          await runtimeInstance.start({ wait: true })
          return
        }
        throw new Error(`实例 ${instance.id} 的运行时没有 restart()，也不能 stop+start`)
      }
    }

    const scheduler = await this.data.schedulerModule()
    for (const holder of moduleCandidates(scheduler)) {
      const fn = pickFunction(holder, ['restartInstance', 'restart', 'restartEngine'])
      if (fn) return (instance) => fn(instance.id)
    }

    return null
  }

  // -------------------------------------------------------------------------
  // /health
  // -------------------------------------------------------------------------

  async #health(req, res) {
    const instances = await this.data.listInstances().catch(() => [])
    const phases = instances.map(instancePhase)

    let engine = 'idle'
    if (phases.includes('starting')) engine = 'starting'
    else if (phases.includes('ready')) engine = 'ready'
    else if (phases.includes('stopping')) engine = 'stopping'
    else if (phases.length > 0 && phases.every((phase) => phase === 'error')) engine = 'error'

    const runningInstances = instances.filter(
      (instance) =>
        ['ready', 'starting'].includes(instancePhase(instance)) && instance.ephemeral !== true
    )

    let active = this.lastModelId
    if (!active) {
      for (const instance of instances) {
        if (instancePhase(instance) !== 'ready') continue
        active = instanceModelIds(instance)[0] || null
        if (active) break
      }
    }

    let runtimeStats = null
    try {
      if (typeof this.deps.runtimeStats === 'function') runtimeStats = await this.deps.runtimeStats()
    } catch {
      runtimeStats = null
    }

    // 探测一下依赖模块到底在不在（import 有缓存，代价很小）。
    // 注意：这里**不调用** #resolveRestart()，否则每次 /health 都可能把 M2 的单例
    // RuntimeManager 提前创建出来，抢在 M6 用自己的配置初始化之前。
    await Promise.all([this.data.registryModule(), this.data.configModule()])
    const runtimeModule = await this.data.runtimeModule()
    const ledgerModule = await this.data.ledgerModule()

    // 账本锁：注入了算 injected；M4 模块真的导出锁方法算 module；都没有就是本地兜底。
    const hasLockApi = moduleCandidates(ledgerModule).some((holder) =>
      pickFunction(holder, ['tryLock', 'lock', 'acquireLock', 'tryAcquire', 'acquire'])
    )
    const restartState =
      typeof this.deps.restartInstance === 'function'
        ? 'injected'
        : runtimeModule
          ? 'module'
          : 'missing'

    const body = {
      ok: true,
      active: active ?? null,
      engine,
      instances: runningInstances.length,
      selfHeal: {
        // count = 已触发的自愈次数；重启本身成功与否看 errors / lastError。
        count: this.metrics.selfHeal.count,
        lastAt: this.metrics.selfHeal.lastAt,
        skipped: this.metrics.selfHeal.skipped,
        errors: this.metrics.selfHeal.errors,
        lastError: this.metrics.selfHeal.lastError,
        lastStatus: this.metrics.selfHeal.lastStatus,
        killed: this.metrics.selfHeal.killed,
        healing: [...this.healing],
      },
      timeouts: {
        count: this.metrics.timeouts.count,
        last: this.metrics.timeouts.last,
        idleMs: this.idleTimeoutMs,
        totalMs: this.totalTimeoutMs,
      },
      idle: {
        inflight: this.contexts.size,
        // 空闲卸载是 M2 的定时器，网关不做；M2 通过 deps.runtimeStats 报上来。
        unloads: Number(runtimeStats?.idleUnloads ?? runtimeStats?.unloads ?? 0) || 0,
        lastRequestAt: this.lastRequestAt || null,
      },
      uptimeMs: Date.now() - this.startedAt,
      port: this.port,
      deps: {
        registry: this.data.moduleState(REGISTRY_MODULE, ['listModels', 'loadInstances']),
        config: this.data.moduleState(CONFIG_MODULE, ['loadConfig', 'loadSecrets']),
        ledger: this.data.moduleState(LEDGER_MODULE),
        runtime: this.data.moduleState(RUNTIME_MODULE),
        restart: restartState,
        lock: this.deps.acquireLock || this.deps.acquireHealLock
          ? 'injected'
          : hasLockApi
            ? 'module'
            : 'local-fallback',
      },
      instancesDetail: instances.map((instance) => ({
        id: instance.id,
        engineId: instance.engineId ?? null,
        modelIds: instanceModelIds(instance),
        port: Number(instance.port) || null,
        phase: instancePhase(instance),
        ephemeral: instance.ephemeral === true,
      })),
      error: this.lastError,
    }

    try {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    } catch (err) {
      this.#logError('health-response', err)
    }
  }

  // -------------------------------------------------------------------------
  // 请求体 / 错误 / 日志
  // -------------------------------------------------------------------------

  /** 读 JSON body。有上限；超了回 413 并把剩余数据丢掉（别让 socket 卡死）。 */
  #readBody(req) {
    const cap = this.maxBodyBytes
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > cap) {
      try {
        req.resume()
      } catch {
        /* ignore */
      }
      return Promise.resolve({
        error: {
          status: 413,
          message: `请求体超过 ${Math.round(cap / 1024 / 1024)} MiB`,
          code: 'body_too_large',
        },
      })
    }

    return new Promise((resolve) => {
      const chunks = []
      let size = 0
      let settled = false

      const cleanup = () => {
        req.off?.('data', onData)
        req.off?.('end', onEnd)
        req.off?.('error', onError)
      }
      const finish = (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const onData = (chunk) => {
        size += chunk.length
        if (size > cap) {
          finish({
            error: {
              status: 413,
              message: `请求体超过 ${Math.round(cap / 1024 / 1024)} MiB`,
              code: 'body_too_large',
            },
          })
          try {
            req.resume()
          } catch {
            /* ignore */
          }
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        const buffer = Buffer.concat(chunks)
        if (buffer.length === 0) {
          finish({
            error: { status: 400, message: '请求体为空', code: 'empty_body' },
          })
          return
        }
        finish({ buffer, text: buffer.toString('utf8') })
      }
      const onError = (err) => {
        finish({
          error: {
            status: 400,
            message: `读取请求体失败：${err?.message || err}`,
            code: 'body_read_error',
          },
        })
      }

      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
    })
  }

  /**
   * 统一错误响应。`/v1/messages` 用 Anthropic 的错误形状，其余用 OpenAI 形状
   * （DSH 两种 provider 都会看这个字段决定怎么报错）。
   */
  #fail(req, res, status, message, code = null, options = {}) {
    const { path = req.url || '/', ctx = null, retryAfter = null } = options

    if (res.headersSent) {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
      ctx?.finish?.()
      return
    }

    const anthropic = String(path).startsWith('/v1/messages')
    const payload = anthropic
      ? {
          type: 'error',
          error: {
            type: status >= 500 ? 'api_error' : 'invalid_request_error',
            message,
          },
        }
      : {
          error: {
            message,
            type: status >= 500 ? 'server_error' : 'invalid_request_error',
            param: null,
            code,
          },
        }

    const headers = { 'content-type': 'application/json; charset=utf-8' }
    if (retryAfter !== null && retryAfter !== undefined) headers['retry-after'] = String(retryAfter)
    // 请求体还没读完就回错误：告诉客户端这条连接不用复用了（GET/HEAD 没有 body，别动 keep-alive）。
    if (!NO_BODY_METHODS.has(req.method) && !req.readableEnded) {
      headers.connection = 'close'
      try {
        req.resume()
      } catch {
        /* ignore */
      }
    }

    try {
      res.writeHead(status, headers)
      res.end(JSON.stringify(payload))
    } catch (err) {
      this.#logError('fail-response', err)
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    } finally {
      ctx?.finish?.()
    }
  }

  #log(message) {
    const logger = this.logger
    if (!logger) return
    const fn = logger.info || logger.log
    if (typeof fn !== 'function') return
    try {
      fn.call(logger, `[gateway] ${message}`)
    } catch {
      /* 日志失败不能影响请求 */
    }
  }

  #logError(where, err) {
    const logger = this.logger
    if (!logger) return
    const fn = logger.error || logger.warn || logger.log
    if (typeof fn !== 'function') return
    const message = err?.stack || err?.message || String(err)
    try {
      fn.call(logger, `[gateway] ${where}: ${message}`)
    } catch {
      /* ignore */
    }
  }

  #logOnce(key, message, intervalMs = 10_000) {
    const now = Date.now()
    if (now - (this.logOnceAt.get(key) || 0) < intervalMs) return
    this.logOnceAt.set(key, now)
    this.#log(message)
  }
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

export function createGateway(options = {}) {
  return new Gateway(options)
}

/**
 * 纯函数的小出口，只给单测用（验收清单里要 18 个单测，D3/D4/超时那些用例
 * 需要直接打这些函数）。业务代码不要依赖它。
 */
export const gatewayInternals = Object.freeze({
  thinkingOverrideLocked,
  stripThinkingOverrides,
  rewriteModelId,
  joinRemotePath,
  normalizeInstances,
  instanceModelIds,
  instancePhase,
  isReadyInstance,
  buildUpstreamHeaders,
  moduleCandidates,
  toLease,
})

/**
 * 启动并返回 `{ gateway, ok, url, port }`。
 *
 * 监听失败时**抛异常**（带 `.code = 'GATEWAY_LISTEN_FAILED'`）：M6 的根 server.mjs
 * 就是这么用的——`try { await startGateway(config) } catch (err) { gatewayError = ... }`，
 * 控制台继续跑，只在页面上标一句"网关没起来"。
 * 也接受直接传整份 config.json（根入口的写法），以及显式 `{ config }`。
 */
export async function startGateway(options = {}) {
  const gateway = new Gateway(options)
  const result = await gateway.start()
  if (!result.ok) {
    const error = new Error(result.error || '网关监听失败')
    error.code = 'GATEWAY_LISTEN_FAILED'
    error.gateway = gateway
    throw error
  }
  return { gateway, ...result }
}

export default { Gateway, createGateway, startGateway }

// 直接 `node gateway/server.mjs` 时独立跑；被 M6 import 时只导出、不监听。
const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
})()

if (isMain) {
  const envPort = process.env.LACI_GATEWAY_PORT
  try {
    const result = await startGateway({
      port: envPort ? Number(envPort) : undefined,
    })
    console.log(`[gateway] 已监听 ${result.url}（只做转发，不启停引擎）`)
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => {
        result.gateway.close().finally(() => process.exit(0))
      })
    }
  } catch (err) {
    console.error(`[gateway] 启动失败：${err.message}`)
    process.exitCode = 1
  }
}
