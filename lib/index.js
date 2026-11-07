import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import os from 'node:os'
import { closeSync, createWriteStream, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { registerToolGuard } from './tool-guard.js'
import { registerModelBridge } from './model-bridge.js'

/**
 * Host half of the LACI panel.
 *
 * The side panel lives in `lib/client.js`; this file owns the actual engine
 * process and exposes a tiny JSON API the renderer can reach through the
 * Desktop request bridge:
 *
 *   GET  /laci-engine/status   current phase (ready / starting / stopped)
 *   POST /laci-engine/load     spawn the engine and wait until /v1/models answers
 *   POST /laci-engine/close    terminate the engine and release VRAM
 *   GET  /laci-engine/log      last lines of the engine log
 */

export const name = 'laci-engine'

// `webServer` is the only Cordis service this half needs. Without this export
// `ctx.webServer` is unavailable and the plugin stays pending forever.
export const inject = ['webServer']

const ROUTE = '/laci-engine'

// 旧的“插件自己拉引擎”接口（/laci-engine/load|close）保留给兼容调用，
// 但默认不指向任何作者机器路径。正常使用走内置 LACI 控制台；
// 这里留空是为了发布包能被任何人直接安装，而不是一装就指着 D:\ninfer。
const DEFAULTS = {
  engine: '',
  model: '',
  log: '',
  port: 8095,
  modelId: '',
  startTimeoutMs: 240_000,
  autoClose: true,
  args: [],
  env: {},
  // 旧的模型选择桥 / 工具熔断默认关闭；需要时在 profile 配置里显式打开。
  toolLoopGuard: false,
}

// 控制台是插件自带的 LACI（插件根/laci），由宿主用 DSH 自己的 Node 直接拉起；
// 不再依赖 start-silent.vbs，也不写死任何用户机器上的 node 路径。
/** 插件自带的 LACI 目录：插件根/laci */
const LACI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'laci')

const CONSOLE_DEFAULTS = {
  root: LACI_DIR,
  entry: 'server.mjs',
  // 内置控制台的固定端口：3102 控制台 / 8096 网关（和独立 LACI 默认的 3101/8095 分开）
  port: 3102,
  gatewayPort: 8096,
  autoStart: true,
}

// 模型选择 → 控制台：选 strata 先加载极限模型，选 27B 先切回常规。
// 选择器本身没有事件，只能挂在真正发请求的那一刻（见 model-bridge.js）。
// 默认关闭：它按旧 LACI 的 /api/extreme/* 接口写，只适合旧控制台。
const BRIDGE_DEFAULTS = {
  enabled: false,
  consoleUrl: 'http://127.0.0.1:3102',
  graceMs: 5000,
  toolUniform: {
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
  },
}

/** The one engine this plugin currently owns. */
let active

/** Last failure kept after the process is gone, so the panel can explain it. */
let lastFailure = ''

/** In-flight operations: concurrent clicks share one spawn / one kill. */
let loadTask
let stopTask
let consoleTask

/** 本次进程拉起的控制台子进程（已在跑/外部启动时为 null）；测试和排错用。 */
let consoleChild = null

export function getConsoleChild() {
  return consoleChild
}

function normalize(raw) {
  const merged = { ...DEFAULTS, ...(raw ?? {}) }
  return {
    ...merged,
    port: Number(merged.port),
    startTimeoutMs: Number(merged.startTimeoutMs) > 0 ? Number(merged.startTimeoutMs) : DEFAULTS.startTimeoutMs,
    autoClose: merged.autoClose !== false,
    args: Array.isArray(merged.args) && merged.args.length > 0 ? merged.args : DEFAULTS.args,
    env: { ...DEFAULTS.env, ...(merged.env ?? {}) },
    console: { ...CONSOLE_DEFAULTS, ...(merged.console ?? {}) },
    modelBridge: {
      ...BRIDGE_DEFAULTS,
      ...(merged.modelBridge ?? {}),
      toolUniform: {
        ...BRIDGE_DEFAULTS.toolUniform,
        ...(merged.modelBridge?.toolUniform ?? {}),
      },
    },
  }
}

function isChildAlive(child) {
  return Boolean(child) && child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

function isManaged(state = active) {
  return Boolean(state) && state.spawnError === '' && !state.exited && isChildAlive(state.child)
}

async function probe(port, timeoutMs = 1500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null)
    return Array.isArray(body?.data) && body.data.length > 0
  } catch {
    return false
  }
}

/** True when the LACI console answers on its own HTTP port. */
async function probeConsole(port, timeoutMs = 1200) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (process.env.LACI_DEBUG) {
      console.error(`[laci] probeConsole ${port}: HTTP ${response.status}`)
    }
    return response.status < 500
  } catch (error) {
    if (process.env.LACI_DEBUG) {
      const cause = error?.cause?.code || error?.cause?.message || ''
      console.error(`[laci] probeConsole ${port}: ${error?.message ?? error}${cause ? ` (${cause})` : ''}`)
    }
    return false
  }
}

/**
 * 控制台数据目录：
 *   1. profile 里显式写 `console.home`
 *   2. 旧版插件旁边的 data/（保留已有模型，升级不丢）
 *   3. 默认 %USERPROFILE%\.dsh\laci-engine
 */
function consoleHome(settings, root) {
  if (typeof settings.home === 'string' && settings.home.trim() !== '') return settings.home.trim()
  const legacy = join(root, '..', 'data')
  if (existsSync(join(legacy, 'config.json'))) return legacy
  return join(os.homedir(), '.dsh', 'laci-engine')
}

/**
 * 确保数据目录里有一份 config.json，端口和控制台、插件反代保持一致。
 * 已有配置但端口不同 → 明确报错，而不是让控制台起在 3101、插件去 3102 空等。
 */
function ensureConsoleConfig(home, port, gatewayPort) {
  const file = join(home, 'config.json')
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({ consolePort: port, gatewayPort }, null, 2)}\n`, 'utf8')
    return file
  }

  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error(`控制台数据目录里的 config.json 不是合法 JSON：${file}`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`控制台数据目录里的 config.json 必须是对象：${file}`)
  }

  let changed = false
  if (raw.consolePort == null) { raw.consolePort = port; changed = true }
  if (raw.gatewayPort == null) { raw.gatewayPort = gatewayPort; changed = true }
  if (Number(raw.consolePort) !== port) {
    throw new Error(`控制台数据目录里的 config.json 端口是 ${raw.consolePort}，插件按 ${port} 启动；请把 consolePort 改成 ${port}，或删掉 ${file} 让插件重建`)
  }
  if (Number(raw.gatewayPort) !== gatewayPort) {
    throw new Error(`控制台数据目录里的 config.json 网关端口是 ${raw.gatewayPort}，插件按 ${gatewayPort} 反代；请把 gatewayPort 改成 ${gatewayPort}，或删掉 ${file} 让插件重建`)
  }
  if (changed) writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  return file
}

/**
 * Bring the console (127.0.0.1:<console.port>) up.
 * 已经在跑就复用；没跑就用当前 DSH 的 node（process.execPath）直接 spawn server.mjs。
 * detached + 输出重定向到 console.out.log：DSH 退出后控制台还活着，日志也真的存在。
 */
async function ensureConsole(ctx, config, timeoutMs = 25_000) {
  const settings = config.console
  const port = Number(settings.port) || CONSOLE_DEFAULTS.port
  const gatewayPort = Number(settings.gatewayPort) || CONSOLE_DEFAULTS.gatewayPort
  if (await probeConsole(port)) {
    return { ok: true, ready: true, started: false, port, gatewayPort }
  }
  if (settings.autoStart === false) {
    throw new Error(`控制台没在跑（127.0.0.1:${port}），autoStart 已关`)
  }

  const root = settings.root
  const entry = join(root, settings.entry)
  if (!existsSync(entry)) {
    throw new Error(`找不到控制台入口：${entry}（这个安装包缺少 laci/；请重新安装完整插件包）`)
  }

  const home = consoleHome(settings, root)
  await mkdir(home, { recursive: true })
  const configFile = ensureConsoleConfig(home, port, gatewayPort)
  const logFile = join(home, 'logs', 'console.out.log')
  await mkdir(dirname(logFile), { recursive: true })

  let child
  let fd
  try {
    fd = openSync(logFile, 'a')
    child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        // 如果宿主进程是 Electron 而不是 node.exe，这个变量让它以 Node 模式运行 server.mjs；
        // 如果 process.execPath 本来就是 node，这个变量会被忽略。
        ELECTRON_RUN_AS_NODE: '1',
        LACI_HOME: home,
      },
      windowsHide: true,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    consoleChild = child
  } catch (error) {
    throw new Error(`无法启动控制台：${error.message}（日志：${logFile}）`)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 子进程已经持有这份 fd */ }
    }
  }

  let exitCode = null
  child.once('exit', (code) => {
    exitCode = code
    if (consoleChild === child) consoleChild = null
  })
  child.once('error', (error) => logLine(ctx, 'warn', `console spawn failed: ${error.message}`))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeConsole(port, 900)) {
      return { ok: true, ready: true, started: true, port, gatewayPort, home, configFile }
    }
    if (exitCode !== null) {
      throw new Error(`控制台进程退出了（code ${exitCode}），日志：${logFile}`)
    }
    await sleep(500)
  }
  throw new Error(`控制台进程起了，但 ${Math.round(timeoutMs / 1000)} 秒内 ${port} 端口没起来（日志：${logFile}）`)
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await probe(port, 600))) return true
    await sleep(400)
  }
  return !(await probe(port, 600))
}

async function waitForExit(child, timeoutMs) {
  if (!isChildAlive(child)) return true
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      child.off('exit', onExit)
      resolve(value)
    }
    const onExit = () => finish(true)
    child.once('exit', onExit)
    // The exit can land between the liveness check above and `once` below.
    if (!isChildAlive(child)) finish(true)
    if (timeoutMs > 0) timer = setTimeout(() => finish(!isChildAlive(child)), timeoutMs)
  })
}

async function readTail(file, maxBytes = 96 * 1024) {
  let handle
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    const size = Math.min(info.size, maxBytes)
    if (size === 0) return []
    const buffer = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, info.size - size + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return buffer.subarray(0, offset).toString('utf8').split(/\r?\n/).filter((line) => line !== '')
  } catch {
    return []
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function closeLog(state) {
  if (state === undefined || state.logClosed) return
  state.logClosed = true
  const stream = state.logStream
  state.logStream = undefined
  if (stream === undefined) return
  await new Promise((resolve) => stream.end(resolve))
}

function runQuiet(command, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: 'ignore' })
    } catch {
      resolve(false)
      return
    }
    child.once('error', () => resolve(false))
    child.once('exit', (code) => resolve(code === 0))
  })
}

/** Synchronous last-resort kill for process exit, where promises cannot run. */
function killSync(state) {
  if (!state || state.child === undefined || state.child.pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(state.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      process.kill(state.child.pid, 'SIGKILL')
    }
  } catch {
    // The process may already be gone; nothing else to do on the exit path.
  }
}

function logLine(ctx, level, message) {
  const logger = ctx?.logger
  if (logger === undefined || typeof logger[level] !== 'function') return
  logger[level](`dsh-laci-engine: ${message}`)
}

async function engineStatus(config) {
  const state = active
  const managed = isManaged(state)
  const ready = await probe(config.port, 1200)
  const phase = ready ? 'ready' : managed ? 'starting' : 'stopped'
  return {
    ok: true,
    phase,
    running: ready || managed,
    ready,
    managed,
    port: config.port,
    model: config.modelId,
    modelPath: config.model,
    engine: config.engine,
    log: config.log,
    pid: managed ? state.child.pid ?? null : null,
    startedAt: managed ? state.startedAt : null,
    lastError: lastFailure || state?.lastError || '',
  }
}

async function startEngine(ctx, config) {
  if (isManaged()) return engineStatus(config)
  if (await probe(config.port, 1000)) return engineStatus(config)
  if (!existsSync(config.engine)) throw new Error(`找不到推理引擎：${config.engine}`)
  if (!existsSync(config.model)) throw new Error(`找不到模型文件：${config.model}`)

  await mkdir(dirname(config.log), { recursive: true })
  const stream = createWriteStream(config.log, { flags: 'a' })
  stream.on('error', (error) => {
    lastFailure = `日志写入失败：${error.message}`
  })

  const args = config.args.map((arg) =>
    String(arg).replaceAll('{port}', String(config.port)).replaceAll('{modelId}', config.modelId),
  )

  stream.write(
    [
      '',
      `===== dsh-laci-engine load ${new Date().toISOString()} =====`,
      `engine: ${config.engine}`,
      `model:  ${config.model}`,
      `args:   ${args.join(' ')}`,
      '',
    ].join('\n'),
  )

  let child
  try {
    child = spawn(config.engine, [config.model, ...args], {
      cwd: dirname(config.engine),
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    })
  } catch (error) {
    await closeLog({ logStream: stream, logClosed: false })
    throw new Error(`无法启动推理引擎：${error.message}`)
  }

  const state = {
    child,
    startedAt: Date.now(),
    logStream: stream,
    logClosed: false,
    lastError: '',
    spawnError: '',
    exited: false,
  }
  active = state

  child.stdout?.pipe(stream, { end: false })
  child.stderr?.pipe(stream, { end: false })

  child.once('error', (error) => {
    state.spawnError = error.message
    state.lastError = error.message
    lastFailure = `引擎启动失败：${error.message}`
    logLine(ctx, 'warn', `spawn failed: ${error.message}`)
  })

  child.once('exit', (code, signal) => {
    state.exited = true
    if (code !== null && code !== 0) {
      state.lastError ||= `引擎进程退出（code ${code}${signal === null ? '' : `, ${signal}`}）`
    }
    if (active === state) active = undefined
    void closeLog(state)
    logLine(ctx, 'info', `engine exited (code ${code ?? 'null'})`)
  })

  const ready = await waitForReady(config.port, config.startTimeoutMs, state)
  if (!ready) {
    const tail = (await readTail(config.log, 64 * 1024)).slice(-14).join('\n')
    const reason =
      state.spawnError || state.lastError || `等待 ${Math.round(config.startTimeoutMs / 1000)} 秒后仍未就绪`
    const failure = new Error(tail === '' ? reason : `${reason}\n最近日志：\n${tail}`)
    lastFailure = failure.message
    await stopEngine(ctx, config, { graceMs: 4000 }).catch(() => {})
    throw failure
  }

  lastFailure = ''
  logLine(ctx, 'info', `engine ready on 127.0.0.1:${config.port}`)
  return engineStatus(config)
}

async function waitForReady(port, timeoutMs, state) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (state.spawnError !== '' || state.exited) return false
    if (await probe(port, 1500)) return true
    await sleep(750)
  }
  return false
}

async function stopEngine(ctx, config, options = {}) {
  const state = active
  active = undefined

  if (state !== undefined) {
    if (isChildAlive(state.child)) {
      try {
        state.child.kill()
      } catch {
        // Fall through to taskkill / SIGKILL.
      }
      let exited = await waitForExit(state.child, options.graceMs ?? 5000)
      if (!exited && process.platform === 'win32' && state.child.pid !== undefined) {
        await runQuiet('taskkill', ['/PID', String(state.child.pid), '/T', '/F'])
        exited = await waitForExit(state.child, 5000)
      } else if (!exited) {
        try {
          state.child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
        await waitForExit(state.child, 2000)
      }
    }
    await closeLog(state)
  }

  if (options.includeExternal === true && (await probe(config.port, 800))) {
    // The engine may have been started outside DSH (or by an earlier Host).
    // Only an explicit Close click may terminate it; plugin reloads and Host
    // shutdown must never kill an instance this plugin did not spawn.
    if (process.platform !== 'win32') {
      throw new Error('引擎不是由 DSH 启动的，无法关闭该进程')
    }
    await runQuiet('taskkill', ['/IM', basename(config.engine), '/T', '/F'])
    if (!(await waitForPortClosed(config.port, 8000))) {
      throw new Error('关闭引擎后端口仍在响应')
    }
  }

  lastFailure = ''
  logLine(ctx, 'info', 'engine closed')
  return engineStatus(config)
}

function respond(response, status, body) {
  if (response.writableEnded) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

async function drain(request) {
  for await (const chunk of request) void chunk
}

export function apply(ctx, rawConfig) {
  // Cordis passes the entry's `config` block as the second argument. Reading it
  // from `ctx` would require a `config` injection and keep the plugin pending.
  const config = normalize(rawConfig)

  ctx.effect(() => {
    // 工具调用熔断：独立的 dsh-tool-loop-guard 在当前离线 profile 挂不上（entry not found），
    // 这里挂一份同规则的，能随本插件热重载。插件修好后把 toolLoopGuard 设 false 即可。
    const disposeToolGuard =
      config.toolLoopGuard === false ? () => {} : registerToolGuard(ctx, config.toolGuard ?? {})

    const disposeBridge =
      config.modelBridge.enabled === false ? () => {} : registerModelBridge(ctx, config.modelBridge)
    logLine(ctx, 'info', `model bridge ${config.modelBridge.enabled === false ? 'off' : 'on'} (grace ${config.modelBridge.graceMs}ms)`)
    logLine(
      ctx,
      'info',
      config.modelBridge.toolUniform?.enabled === false
        ? 'tool uniform off'
        : `tool uniform on (${(config.modelBridge.toolUniform?.providers ?? []).join(', ')})`,
    )

    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (request, response) => {
        const url = new URL(request.url ?? ROUTE, 'http://127.0.0.1')
        const action = url.pathname.slice(ROUTE.length) || '/'
        const method = (request.method ?? 'GET').toUpperCase()
        try {
          if (action === '/' && method === 'GET') {
            return respond(response, 200, await engineStatus(config))
          }
          if (action === '/status' && method === 'GET') {
            return respond(response, 200, await engineStatus(config))
          }
          if (action === '/log' && method === 'GET') {
            const requested = Number(url.searchParams.get('lines') ?? 60)
            const lines = Number.isFinite(requested) ? Math.max(5, Math.min(200, Math.trunc(requested))) : 60
            return respond(response, 200, { ok: true, lines: (await readTail(config.log)).slice(-lines) })
          }
          if (action === '/load' && method === 'POST') {
            await drain(request)
            loadTask ??= startEngine(ctx, config).finally(() => {
              loadTask = undefined
            })
            return respond(response, 200, await loadTask)
          }
          if (action === '/close' && method === 'POST') {
            await drain(request)
            stopTask ??= stopEngine(ctx, config, { includeExternal: true }).finally(() => {
              stopTask = undefined
            })
            return respond(response, 200, await stopTask)
          }
          if (action === '/console' && method === 'GET') {
            const port = Number(config.console.port) || CONSOLE_DEFAULTS.port
            const gatewayPort = Number(config.console.gatewayPort) || CONSOLE_DEFAULTS.gatewayPort
            return respond(response, 200, {
              ok: true,
              ready: await probeConsole(port),
              port,
              gatewayPort,
              root: config.console.root,
              home: config.console.home ?? null,
              autoStart: config.console.autoStart !== false,
            })
          }
          if (action === '/console/start' && method === 'POST') {
            await drain(request)
            consoleTask ??= ensureConsole(ctx, config).finally(() => {
              consoleTask = undefined
            })
            return respond(response, 200, await consoleTask)
          }
          return respond(response, 404, { ok: false, error: `unknown route ${method} ${action}` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logLine(ctx, 'warn', `${action} failed: ${message}`)
          return respond(response, 500, { ok: false, error: message })
        }
      },
    })

    // The panel is an iframe of the console page, and DSH's local provider uses
    // the console's 8095 router, so the console has to be up whenever the Host is.
    // It used to be a manual start.cmd and died with the old Host, leaving a white
    // panel; bringing it up here makes the plugin self-contained.
    if (config.console.autoStart !== false) {
      // 和 /console/start 共用同一个 in-flight promise：面板点“启动”不会和自动启动各起一份。
      consoleTask ??= ensureConsole(ctx, config).finally(() => {
        consoleTask = undefined
      })
      void consoleTask
        .then((result) => {
          if (result.started) logLine(ctx, 'info', `console started on 127.0.0.1:${result.port}`)
        })
        .catch((error) => logLine(ctx, 'warn', `console unavailable: ${error?.message ?? error}`))
    }

    /* 同源代理：/laci → 3102（控制台），/laci/v1 → 8096（网关）。
       DSH 里的 iframe 用 /laci/ 就行，地址栏不暴露 127.0.0.1:3102。 */
    const proxyTo = (port, rewrite) => (request, response) =>
      new Promise((resolve) => {
        let upstream
        try {
          upstream = http.request(
            {
              host: '127.0.0.1',
              port,
              method: request.method,
              path: rewrite(request.url ?? '/'),
              headers: { ...request.headers, host: `127.0.0.1:${port}` },
            },
            (res) => {
              response.writeHead(res.statusCode ?? 502, res.headers)
              res.pipe(response)
              res.on('end', resolve)
              res.on('error', resolve)
            },
          )
        } catch (error) {
          resolve()
          return
        }
        upstream.on('error', () => {
          try {
            response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            response.end(`LACI 没起来（127.0.0.1:${port}）`)
          } catch {
            /* 响应头已经发出去就算了 */
          }
          resolve()
        })
        request.pipe(upstream)
      })

    const consolePort = Number(config.console.port) || CONSOLE_DEFAULTS.port
    const gatewayPort = Number(config.console.gatewayPort) || CONSOLE_DEFAULTS.gatewayPort
    const disposeLaciV1 = ctx.webServer.register({
      kind: 'prefix',
      path: '/laci/v1',
      handler: proxyTo(gatewayPort, (u) => u.replace(/^\/laci\/v1/, '/v1')),
    })
    const disposeLaci = ctx.webServer.register({
      kind: 'prefix',
      path: '/laci',
      handler: proxyTo(consolePort, (u) => u.replace(/^\/laci/, '') || '/'),
    })

    // The Host normally disposes this effect during shutdown, but a hard exit
    // (window closed while the Host is killed) skips async cleanup. This
    // synchronous hook is the last line of defence for an owned engine.
    const onExit = () => killSync(active)
    process.once('exit', onExit)

    return () => {
      process.off('exit', onExit)
      disposeToolGuard()
      disposeBridge()
      disposeRoute()
      disposeLaciV1()
      disposeLaci()
      if (config.autoClose) {
        void stopEngine(ctx, config, { graceMs: 4000 }).catch((error) => {
          logLine(ctx, 'warn', `close on dispose failed: ${error?.message ?? error}`)
        })
      }
    }
  }, 'dsh-laci-engine: route and engine lifecycle')
}
