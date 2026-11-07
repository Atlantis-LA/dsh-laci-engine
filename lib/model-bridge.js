/**
 * 模型选择 → 调度中心的桥。
 *
 * 背景：DSH 的模型选择器没有对外暴露“选中了哪个模型”的事件或服务
 * （Client 侧只有 connection/locale/slots/theme；Host 侧也没有 model-selected）。
 * 唯一可靠的时机是“真的要发请求”的那一刻，所以这里挂在 `agent/request` 上：
 *
 *   - provider 是 strata（极限模型）      → 先让控制台把模型加载好，再放行请求；
 *   - provider 是 kvmem-local（27B 三件） → 极限模型正占着显存时，先切回常规；
 *   - 其它（云端）                        → 直接放行，一次 HTTP 都不发。
 *
 * 加载开始前留 `graceMs`（默认 5 秒）的取消窗口：这 5 秒内用户点“停止”，
 * 请求被中止，我们就不会真的去加载模型。
 */

const DEFAULTS = {
  enabled: true,
  consoleUrl: 'http://127.0.0.1:3101',
  graceMs: 5000,
  pollMs: 1000,
  readyTimeoutMs: 300_000,
  extremeProviders: ['strata'],
  extremeModels: ['qwen3.8-flash-next-iq2_xs'],
  localProviders: ['kvmem-local'],
  localModelPrefixes: ['qwen3.8-27b'],
}

// 本地模型（27B 与 Strata）统一工具面：只留读写文件、命令、提问、待办、交付。
// 理由：本地 27B / Strata 的上下文都小（32K），默认 70+ 个工具光 schema 就 15.6K token，
// 还会诱导模型反复"查看自己处境"。云端模型不动。
const UNIFORM_DEFAULTS = {
  enabled: true,
  providers: ['kvmem-local', 'strata'],
  allow: [
    'read',
    'read_image',
    'write',
    'edit',
    'glob',
    'grep',
    'pwsh',
    'ask_user_question',
    'todo_write',
    'present',
  ],
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.name === 'TimeoutError'
}

class Bridge {
  constructor(ctx, raw) {
    this.ctx = ctx
    this.settings = { ...DEFAULTS, ...(raw ?? {}) }
    this.uniform = { ...UNIFORM_DEFAULTS, ...(raw?.toolUniform ?? {}) }
    this.uniform.allow = new Set(this.uniform.allow ?? UNIFORM_DEFAULTS.allow)
    this.lastConfig = new WeakMap()
    this.masks = new WeakMap()
    this.logged = new Set()
    this.queue = Promise.resolve()
  }

  log(level, message) {
    const logger = this.ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](`dsh-laci-engine: ${message}`)
  }

  target(config) {
    const provider = String(config?.provider ?? '')
    const model = String(config?.model ?? '')
    if (this.settings.extremeProviders.includes(provider)) return { kind: 'extreme' }
    if (this.settings.extremeModels.includes(model)) return { kind: 'extreme' }
    if (
      this.settings.localProviders.includes(provider) ||
      this.settings.localModelPrefixes.some((prefix) => model.startsWith(prefix))
    ) {
      return { kind: 'ninfer', model }
    }
    return null
  }

  async state() {
    const response = await fetch(`${this.settings.consoleUrl}/api/state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) throw new Error(`控制台返回 ${response.status}`)
    return response.json()
  }

  async post(path, body) {
    const response = await fetch(`${this.settings.consoleUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(15_000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const message = data?.error?.message ?? data?.error ?? `HTTP ${response.status}`
      const error = new Error(String(message))
      error.status = response.status
      error.code = data?.error?.code
      throw error
    }
    return data
  }

  extremePhase(state) {
    return String(state?.extreme?.phase ?? 'idle')
  }

  async waitFor(stateFn, signal, what) {
    const deadline = Date.now() + this.settings.readyTimeoutMs
    let last = ''
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('aborted')
      let state
      try {
        state = await this.state()
      } catch (error) {
        if (signal?.aborted) throw error
        state = null
      }
      if (state) {
        const done = stateFn(state)
        if (done === true) return state
        if (typeof done === 'string') throw new Error(done)
        last = `phase=${this.extremePhase(state)}`
      }
      await sleep(this.settings.pollMs, signal)
    }
    throw new Error(`${what}超时（${Math.round(this.settings.readyTimeoutMs / 1000)} 秒，${last}）`)
  }

  ensureExtreme(signal) {
    const task = async () => {
      let state = await this.state()
      if (this.extremePhase(state) === 'running') return
      if (this.extremePhase(state) === 'loading' || state?.lock?.held) {
        return this.waitExtreme(signal)
      }

      // 5 秒取消窗口：这期间中止请求就不会去停 27B、不会占显存。
      await sleep(this.settings.graceMs, signal)
      this.log('info', '极限模型加载中（由模型选择触发）')
      try {
        await this.post('/api/extreme/load')
      } catch (error) {
        if (error.status !== 409) throw error
      }
      return this.waitExtreme(signal)
    }
    return this.enqueue('extreme', task)
  }

  waitExtreme(signal) {
    return this.waitFor(
      (state) => {
        const phase = this.extremePhase(state)
        if (phase === 'running') return true
        if (phase === 'error') return `极限模型加载失败：${state?.extreme?.error ?? '未知错误'}`
        return false
      },
      signal,
      '极限模型加载',
    )
  }

  ensureNinfer(model, signal) {
    const task = async () => {
      let state = await this.state()
      const phase = this.extremePhase(state)
      if (phase === 'idle') return

      if (phase === 'loading' || state?.lock?.held) {
        state = await this.waitFor(
          (next) => (this.extremePhase(next) === 'idle' ? true : next?.extreme?.phase === 'error' ? true : false),
          signal,
          '极限模型停止',
        ).catch((error) => {
          if (isAbort(error)) throw error
          return null
        })
        if (!state || this.extremePhase(state) === 'idle') return
      }

      const routes = state?.config?.modelRoutes ?? {}
      const modelsDir = state?.config?.modelsDir
      const file = routes[model]
      const modelPath = file && modelsDir ? `${modelsDir.replace(/[\\/]+$/, '')}\\${file}` : undefined
      this.log('info', `切回常规：${model || '(默认)'}`)
      try {
        await this.post('/api/extreme/back', modelPath ? { modelPath } : {})
      } catch (error) {
        if (error.status !== 409) throw error
      }
      await this.waitFor(
        (next) => this.extremePhase(next) === 'idle' && !next?.lock?.held && next?.engine?.phase === 'running',
        signal,
        '切回常规',
      )
    }
    return this.enqueue(`ninfer:${model}`, task)
  }

  /** 同一目标只跑一份；后来的请求等同一份结果。 */
  enqueue(key, factory) {
    if (this.current?.key === key) return this.current.promise
    const entry = { key, promise: null }
    entry.promise = this.queue.then(factory).finally(() => {
      if (this.current === entry) this.current = undefined
    })
    this.current = entry
    this.queue = entry.promise.catch(() => {})
    return entry.promise
  }

  /** 当前会话是不是本地模型（27B 或 Strata）。 */
  isLocalAgent(agent) {
    const last = this.lastConfig.get(agent)
    if (last !== undefined) return this.uniform.providers.includes(String(last.provider ?? ''))
    try {
      const selection = this.ctx?.agentDefaultModel?.currentSelection?.()
      const provider = String(selection?.provider ?? '')
      return provider !== '' && this.uniform.providers.includes(provider)
    } catch {
      return false
    }
  }

  /** 拿到这个 agent 自己的 tools 服务（几种来源都试，宿主插件里 agent.ctx 不一定暴露）。 */
  toolsFor(agent) {
    const direct = agent?.ctx?.tools
    if (direct !== undefined && typeof direct.restrict === 'function') return direct
    try {
      const scoped = this.presets?.serviceFor?.(agent, 'tools')
      if (scoped !== undefined && typeof scoped.restrict === 'function') return scoped
    } catch {
      // serviceFor 不是所有版本都有。
    }
    return undefined
  }

  /** schemas() 在不同版本里可能是数组、{tools:[...]} 或 Map，统一摊平。 */
  schemaNames(scoped) {
    let raw
    try {
      raw = scoped.schemas()
    } catch (error) {
      this.log('warn', `schemas() 失败：${error?.message ?? error}`)
      return []
    }
    let list = []
    if (Array.isArray(raw)) list = raw
    else if (raw instanceof Map) list = [...raw.values()]
    else if (raw && typeof raw === 'object') list = raw.tools ?? raw.schemas ?? []
    if (!Array.isArray(list)) list = []
    const names = []
    for (const item of list) {
      if (typeof item === 'string') names.push(item)
      else if (typeof item?.name === 'string') names.push(item.name)
      else if (typeof item?.tool?.name === 'string') names.push(item.tool.name)
    }
    return names
  }

  /**
   * 本地会话：把不在白名单里的工具从 schema 里藏掉。
   * 每步重算一次，这样后续新注册的工具（MCP / 插件）也会被盖住；
   * restrict 对还没注册的名字会抛错，忽略即可，下一步再试。
   */
  applyMask(agent) {
    const scoped = this.toolsFor(agent)
    if (scoped === undefined) {
      this.logOnce('no-tools', 'warn', `本地工具面收窄跳过：这个 agent 拿不到 tools 服务（${String(agent?.id ?? '?')}）`)
      return
    }
    let entry = this.masks.get(agent)
    if (entry === undefined) {
      entry = { denied: new Set(), undo: [] }
      this.masks.set(agent, entry)
    }
    const names = this.schemaNames(scoped)
    let added = 0
    let firstError = ''
    for (const name of names) {
      if (this.uniform.allow.has(name) || entry.denied.has(name)) continue
      try {
        const undo = scoped.restrict({ deny: [name] })
        if (typeof undo === 'function') entry.undo.push(undo)
        entry.denied.add(name)
        added += 1
      } catch (error) {
        if (firstError === '') firstError = `${name}: ${error?.message ?? error}`
      }
    }
    if (added > 0) {
      this.log('info', `本地工具面收窄：藏 ${added} 个（共 ${entry.denied.size} 个，原 ${names.length} 个）`)
    } else if (firstError !== '' && entry.denied.size === 0) {
      this.logOnce('restrict-failed', 'warn', `本地工具面收窄失败：${firstError}`)
    }
  }

  /** 同一类提示只打一次，避免每步刷屏。 */
  logOnce(key, level, message) {
    if (this.logged.has(key)) return
    this.logged.add(key)
    this.log(level, message)
  }

  /** 换回云端模型：把之前藏掉的工具放回去。 */
  restoreMask(agent) {
    const entry = this.masks.get(agent)
    if (entry === undefined) return
    this.masks.delete(agent)
    for (const undo of entry.undo.reverse()) {
      try {
        undo()
      } catch {
        // 工具已经卸载：忽略。
      }
    }
    this.log('info', `工具面已恢复（${entry.denied.size} 个）`)
  }

  onPreStep(payload, next) {
    try {
      this.logOnce('pre-step', 'info', 'pre-step listener active')
      const agent = payload?.agent
      if (agent !== undefined) {
        if (this.uniform.enabled !== false && this.isLocalAgent(agent)) this.applyMask(agent)
        else this.restoreMask(agent)
      }
    } catch (error) {
      this.logOnce('pre-step-error', 'warn', `pre-step 收窄异常：${error?.message ?? error}`)
    }
    return next()
  }

  async onRequest(payload, next) {
    const config = await next()
    if (payload?.agent !== undefined) this.lastConfig.set(payload.agent, config)
    if (this.settings.enabled === false) return config
    const target = this.target(config)
    if (target === null) return config
    // 请求期的模型是最准的：顺手把这一步之后（下一步）的工具面也收掉。
    try {
      if (this.uniform.enabled !== false) this.applyMask(payload.agent)
    } catch {
      // 收窄失败不影响请求本身。
    }

    const signal = payload?.signal
    try {
      if (target.kind === 'extreme') {
        await this.ensureExtreme(signal)
      } else {
        await this.ensureNinfer(target.model, signal)
      }
    } catch (error) {
      if (isAbort(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      this.log('warn', `模型切换失败：${message}`)
      throw new Error(`模型调度没切成功：${message}`)
    }
    return config
  }
}

/** 把一个 ctx 接上“模型选择 → 控制台”的桥；返回卸载函数。 */
export function registerModelBridge(ctx, rawConfig = {}) {
  const bridge = new Bridge(ctx, rawConfig)
  // agentPresets 是可选服务：拿到的话就用它按会话取 tools（宿主插件里 agent.ctx 可能是壳）。
  try {
    ctx.inject?.(['agentPresets'], (scoped) => {
      bridge.presets = scoped.agentPresets
    })
  } catch {
    // 没有这个服务就只走 agent.ctx 那条路。
  }
  const offRequest = ctx.on('agent/request', (payload, next) => bridge.onRequest(payload, next))
  const offStep = ctx.on('agent/pre-step', (payload, next) => bridge.onPreStep(payload, next))
  // 会话刚建好就先收一次，别等第一步（第一步的工具清单已经拼好了）。
  const offCreated = ctx.on('agent/created', ({ agent }) => {
    try {
      if (bridge.uniform.enabled !== false && bridge.isLocalAgent(agent)) bridge.applyMask(agent)
    } catch {
      // 收窄失败不影响建会话。
    }
  })
  return () => {
    offRequest?.()
    offStep?.()
    offCreated?.()
  }
}
