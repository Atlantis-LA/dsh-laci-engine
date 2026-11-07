/**
 * 工具调用循环的硬熔断 —— 内嵌版。
 *
 * 为什么在 laci-engine 里也放一份：独立的 `dsh-tool-loop-guard` 行在当前 profile 里
 * 挂不上（host 日志报 `patch: entry "tool-loop-guard" not found`，热加载也不收新插入），
 * 而 laci-engine 这一行是活的、可热重载。等那个插件能正常挂载后，把这里的
 * `toolLoopGuard` 关掉即可，两边规则一致：
 *
 *   - 坏格式调用（宿主记成 `malformed_tool_call`）直接拒绝，并告诉模型怎么改；
 *   - 同参数连续 3 次 / 同参数累计 4 次 / 同名累计 5 次 / 单轮 40 次 ⇒ 拒绝；
 *   - 拒绝 2 次后硬熔断，下一步结束回合。
 */
const DEFAULTS = {
  repeatLimit: 3,
  sameCallLimit: 4,
  nameLimit: 8,
  maxCallsPerTurn: 40,
  denialLimit: 2,
  // 只对本地模型生效：别的 provider / 模型一律放行（云端模型有它自己的护栏）。
  localProviders: ['kvmem-local'],
  localModelPrefixes: ['qwen3.8-27b'],
  // 本地模型不给联网：搜索/抓取会把它带偏（先搜一轮、抓不回正文、还占输出预算）。
  localDenyTools: [
    'web_search',
    'web_fetch',
    'mcp__web-search-safe__web_search',
    'mcp__web-search-safe__web_fetch',
  ],
}

function canonical(value, depth = 0) {
  if (depth > 20) return JSON.stringify(value) ?? 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`
}

function createState() {
  return { sig: '', streak: 0, calls: 0, counts: new Map(), nameCounts: new Map(), denials: 0, hardStop: false }
}

function resetTurn(state) {
  state.sig = ''
  state.streak = 0
  state.calls = 0
  state.counts.clear()
  state.nameCounts.clear()
  state.denials = 0
  state.hardStop = false
}

/** 把一个 ctx 接上熔断逻辑；返回卸载函数。 */
export function registerToolGuard(ctx, rawConfig = {}) {
  const settings = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const states = new WeakMap()
  // agent → 最近一次请求用的 provider / model；用来判断“这条会话是不是在用本地模型”。
  const modelOf = new WeakMap()

  const isLocal = (agent) => {
    const current = modelOf.get(agent)
    if (current === undefined) return false
    const provider = String(current.provider ?? '')
    const model = String(current.model ?? '')
    return (
      settings.localProviders.includes(provider) ||
      settings.localModelPrefixes.some((prefix) => model.startsWith(prefix))
    )
  }

  const offRequest = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      modelOf.set(payload.agent, { provider: config.provider, model: config.model })
      maskWeb(payload.agent)
    } catch {
      // 记不上就当作非本地，宁可少拦也不要拦错。
    }
    return config
  })

  // 本地模型的联网工具从工具表里摘掉（27B 会先搜一轮再干活，实测搜完还抓不回来）。
  // 云端不动；没注册上的名字留到 pre-step 再试。
  const masked = new WeakMap()
  function maskWeb(agent) {
    if (!isLocal(agent)) return
    const scoped = agent?.ctx?.tools
    if (scoped === undefined || typeof scoped.restrict !== 'function') return
    let done = masked.get(agent)
    if (done === undefined) {
      done = new Set()
      masked.set(agent, done)
    }
    for (const toolName of settings.localDenyTools) {
      if (done.has(toolName)) continue
      try {
        scoped.restrict({ deny: [toolName] })
        done.add(toolName)
      } catch {
        // 还没注册：下次 pre-step 再试。
      }
    }
  }

  const stateOf = (agent) => {
    let state = states.get(agent)
    if (state === undefined) {
      state = createState()
      states.set(agent, state)
    }
    return state
  }

  const offStep = ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const state = states.get(agent)
    if (state?.hardStop === true) {
      resetTurn(state)
      return { kind: 'reject' }
    }
    if (state !== undefined && Array.isArray(messages) && messages.some((m) => m?.source?.kind === 'user')) {
      resetTurn(state)
    }
    try {
      maskWeb(agent)
    } catch {
      // 摘联网工具失败不能影响这一步。
    }
    return next()
  })

  const offTool = ctx.on('tools/pre-execute', async (exec, next) => {
    const agent = exec.agent
    if (agent === undefined) return next()
    if (!isLocal(agent)) return next()
    const state = stateOf(agent)

    if (state.hardStop) {
      return {
        kind: 'deny',
        reason: `[tool-loop-guard] 本回合工具已锁定：${exec.name} 没有被执行。不要再调用任何工具，直接用文字回答用户。`,
        info: { name: 'laci-tool-guard', code: 'TOOL_LOOP_LOCKED' },
      }
    }

    if (exec.name === 'malformed_tool_call') {
      state.denials += 1
      if (state.denials >= settings.denialLimit) state.hardStop = true
      ctx.logger?.warn?.(`[laci-tool-guard] 拒绝 malformed_tool_call（第 ${state.denials} 次）`)
      return {
        kind: 'deny',
        reason:
          '[tool-loop-guard] 你上一条工具调用的格式是坏的（参数不是合法 JSON），宿主没能执行它。'
          + '不要重发同一个调用。要么把参数改成合法 JSON 再调一次，要么直接用文字回答用户。',
        info: { name: 'laci-tool-guard', code: 'TOOL_CALL_MALFORMED' },
      }
    }

    const sig = `${exec.name}\u0000${canonical(exec.arguments)}`
    if (sig === state.sig) state.streak += 1
    else {
      state.sig = sig
      state.streak = 1
    }
    state.calls += 1
    const seen = (state.counts.get(sig) ?? 0) + 1
    if (state.counts.size < 512 || state.counts.has(sig)) state.counts.set(sig, seen)
    const nameSeen = (state.nameCounts.get(exec.name) ?? 0) + 1
    if (state.nameCounts.size < 512 || state.nameCounts.has(exec.name)) state.nameCounts.set(exec.name, nameSeen)

    let reason
    if (state.streak >= settings.repeatLimit) {
      reason = `[tool-loop-guard] 已拒绝：${exec.name} 连续第 ${state.streak} 次使用完全相同的参数调用。`
        + '重复调用不会产生新信息，这是宿主熔断，不是用户指令。不要再次调用这个工具，直接用文字回答用户。'
    } else if (seen >= settings.sameCallLimit) {
      reason = `[tool-loop-guard] 已拒绝：${exec.name} 在本回合第 ${seen} 次使用相同参数调用。`
        + '换个参数或换个工具都不再必要，请直接用文字回答用户。'
    } else if (nameSeen >= settings.nameLimit) {
      reason = `[tool-loop-guard] 已拒绝：${exec.name} 在本回合已被调用 ${nameSeen} 次（参数不同也算）。`
        + '这条链路看起来在原地打转，请停下来，把已经拿到的结果直接写成回答。'
    } else if (state.calls > settings.maxCallsPerTurn) {
      reason = `[tool-loop-guard] 已拒绝：本回合工具调用已达上限（${settings.maxCallsPerTurn} 次）。停止调用工具，直接用文字回答用户。`
    }

    if (reason === undefined) return next()

    state.denials += 1
    if (state.denials >= settings.denialLimit) state.hardStop = true
    ctx.logger?.warn?.(`[laci-tool-guard] 拒绝 ${exec.name}（连续 ${state.streak} / 累计 ${seen} / 同名 ${nameSeen} / 本轮 ${state.calls}）`)
    return { kind: 'deny', reason, info: { name: 'laci-tool-guard', code: 'TOOL_LOOP_DENIED' } }
  })

  return () => {
    offStep?.()
    offTool?.()
    offRequest?.()
  }
}
