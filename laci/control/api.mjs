/**
 * M6 · 控制面 API（3101）
 *
 * 前端只通过这里干活。它是 M1–M5 的编排层，不含业务判断。
 *
 * 端点（见 D:\edit\plan\06-M6-控制面.md）：
 *   GET    /api/state
 *   GET    /api/engines          POST /api/engines        DELETE /api/engines/:id
 *   POST   /api/engines/probe    （SSE：日志 / 端口 / stalled / done）
 *   GET    /api/models           POST /api/models         DELETE /api/models/:id
 *   GET    /api/instances        POST /api/instances      DELETE /api/instances/:id
 *   POST   /api/estimate
 *   GET    /api/dsh/provider
 *   GET    /api/health
 */
import http from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import fs, { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as registry from '../core/registry.mjs'
import { cleanPath, hasSecret, saveSecret } from '../core/config.mjs'
import { getRuntimeManager, buildCommand } from '../core/runtime.mjs'
import * as ledger from '../core/ledger.mjs'
import { allocPort } from '../core/ports.mjs'
import * as importer from './import.mjs'

const MAX_BODY = 4 * 1024 * 1024
const RESERVED_PORTS = new Set([3101, 8095])

/** 同一时刻只允许一个原生对话框（用户点到第二次时给它一个明确回复，而不是排队弹两个） */
let dialogPending = false
/** 当前那个对话框的 powershell 进程号：重复点击时用它把已有窗口抬到前台 */
let activeDialogPid = null

/** package 引擎的配置文件读得很频繁（state 每 2 秒一次），缓存 5 秒就够 */
const engineConfigCache = new Map()
async function cachedEngineConfig(engine) {
  if (!engine || !engine.id) return { ok: true, found: false }
  const hit = engineConfigCache.get(engine.id)
  if (hit && Date.now() - hit.at < 5000) return hit.value
  const value = await importer.findEngineConfig(engine).catch(() => ({ ok: true, found: false }))
  engineConfigCache.set(engine.id, { at: Date.now(), value })
  return value
}

/**
 * 抢前台用的 Win32 封装（对话框脚本和"抬前台"脚本共用同一份）。
 * 为什么需要：弹窗进程是后台 node 的子进程，Windows 前台锁会无视
 * SetForegroundWindow，必须先 AttachThreadInput 到前台线程。
 */
const FG_CSHARP = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LaciFg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr mon, ref MONITORINFO mi);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

  /* 把对话框摆到显示器工作区正中。
   * 为什么需要：宿主窗口被故意放到 (-2000,-2000)，ShowDialog(owner) 会按宿主位置
   * 算居中，Windows 再把窗口夹到最近的屏幕边 —— 实测会跑到屏幕右下角、只露个标题栏。 */
  public static void Center(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return;
    int w = r.Right - r.Left, hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return;
    MONITORINFO mi = new MONITORINFO();
    mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(MonitorFromWindow(h, 2 /*MONITOR_DEFAULTTONEAREST*/), ref mi)) return;
    int workW = mi.rcWork.Right - mi.rcWork.Left;
    int workH = mi.rcWork.Bottom - mi.rcWork.Top;
    int nw = Math.Min(w, Math.Max(320, workW - 40));
    int nh = Math.Min(hh, Math.Max(240, workH - 40));
    int x = mi.rcWork.Left + Math.Max(0, (workW - nw) / 2);
    int y = mi.rcWork.Top + Math.Max(0, (workH - nh) / 2);
    SetWindowPos(h, IntPtr.Zero, x, y, nw, nh, 0x0004 /*SWP_NOZORDER*/ | 0x0040 /*SWP_SHOWWINDOW*/);
  }
  public static IntPtr FindDialog(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Force(IntPtr h) {
    SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    IntPtr fg = GetForegroundWindow();
    uint p; uint t = GetWindowThreadProcessId(fg, out p);
    uint cur = GetCurrentThreadId();
    if (t != cur) {
      AttachThreadInput(cur, t, true);
      bool ok = SetForegroundWindow(h);
      AttachThreadInput(cur, t, false);
      return ok;
    }
    return SetForegroundWindow(h);
  }
}
`

/**
 * 加载互斥锁。
 *
 * 没有它，两个并发的「加载」会同时通过 checkStart、各自 reserve、各自起进程——
 * ledger 的 reserve 是「显存预留」，不是互斥锁，挡不住这个。
 */
let loadChain = Promise.resolve()
function withLoadLock(fn) {
  const run = loadChain.then(fn, fn)
  loadChain = run.then(
    () => {},
    () => {}
  )
  return run
}

/* ------------------------------------------------------------------ */
/* 小工具                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  if (res.headersSent) return
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function fail(res, code, error, extra = {}) {
  return sendJson(res, code, { ok: false, error, ...extra })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(new Error('invalid JSON: ' + err.message))
      }
    })
    req.on('error', reject)
  })
}

function firstIssue(validation) {
  if (validation?.ok) return null
  const list = validation?.errors ?? validation?.issues ?? []
  if (!Array.isArray(list) || list.length === 0) return '校验失败'
  return list.map((e) => (typeof e === 'string' ? e : e.message ?? JSON.stringify(e))).join('；')
}

/* ------------------------------------------------------------------ */
/* 端口租约：实例活着时占着，实例真停了才还                             */
/* ------------------------------------------------------------------ */

/** 还掉某个实例的端口租约（幂等；没记过就什么都不做） */
function releasePortLease(ctx, instanceId) {
  const lease = ctx.portLeases.get(instanceId)
  if (!lease) return false
  ctx.portLeases.delete(instanceId)
  try {
    lease.release?.()
  } catch {
    // 还端口失败不阻塞关闭：预留还有 TTL 兜底
  }
  return true
}

/**
 * 盯住实例状态，在「确实没有进程了」时把端口还回去。
 *
 * 只在 idle 时还，error 要再看 pid：
 *   - error + pid 为空 = 进程已经没了，端口真的空出来了 → 还
 *   - error + 还有 pid  = 进程可能卡着占显存（对账判死那条路径）→ 先留着，
 *     等用户停掉或 TTL 过期，免得两个实例被判成同一个端口
 */
function hookPortReaper(manager, ctx) {
  if (ctx.reaperHooked) return
  ctx.reaperHooked = true
  manager.on('phase', ({ instanceId, to }) => {
    if (!instanceId) return
    if (to === 'idle') {
      releasePortLease(ctx, instanceId)
      return
    }
    if (to === 'error') {
      const rt = manager.get(instanceId)
      if (!rt?.pid) releasePortLease(ctx, instanceId)
    }
  })
}

/* ------------------------------------------------------------------ */
/* 状态聚合                                                           */
/* ------------------------------------------------------------------ */

/**
 * 本地模型档案 + 云端引擎里声明的 models，合成一份。
 *
 * 为什么要在控制面也合并：云端模型不落 model 档案文件（网关是从 engine.models
 * 现算的），如果这里只读 listModels，界面就完全看不见云端模型 —— 配了也白配。
 * 本地档案优先（同一个 id 保存时就会被拒，这里只是兜底）。
 */
function allModelsFor(engines) {
  const byId = new Map()
  for (const model of registry.listModels()) byId.set(model.id, model)
  for (const engine of engines) {
    if (!engine || engine.mode !== 'remote' || !Array.isArray(engine.models)) continue
    for (const remote of engine.models) {
      const id = String(remote?.id ?? '').trim()
      if (!id || byId.has(id)) continue
      byId.set(id, {
        id,
        label: remote.label || id,
        kind: remote.kind || 'chat',
        engineId: engine.id,
        remote: true,
        contextWindow: remote.contextWindow,
        maxTokens: remote.maxTokens
      })
    }
  }
  return [...byId.values()]
}

/** 外部实例探测缓存：引擎 id → { at, ids }；每 4 秒最多探一次 */
const externalProbe = new Map()

async function probeModels(port) {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 700)
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ac.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    const body = await res.json().catch(() => null)
    const ids = Array.isArray(body?.data) ? body.data.map((m) => m && m.id).filter(Boolean) : []
    return ids
  } catch {
    return null
  }
}

/** 端口上监听的进程 pid（netstat 解析；拿不到返回 null） */
function pidListeningOn(port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    for (const line of String(out).split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  } catch {
    /* netstat 不在就算了 */
  }
  return null
}

/**
 * 加载前清理外部起的引擎：端口上真在服务（/v1/models 有模型）才杀，
 * 避免把占着同端口的无关程序误杀。
 */
async function closeExternalProcesses(engines, manager) {
  const closed = []
  for (const engine of engines) {
    if (engine.mode === 'remote') continue
    if (manager.list().some((rt) => rt.engineId === engine.id)) continue
    let port = Number(engine.defaultPort)
    try {
      const found = await cachedEngineConfig(engine)
      const cfgPort = Number(found && found.found && found.config ? found.config.port : NaN)
      if (Number.isInteger(cfgPort) && cfgPort > 0) port = cfgPort
    } catch {
      /* 读不到配置就用档案端口 */
    }
    if (!Number.isInteger(port) || port <= 0) continue
    /* 端口上返回 /v1/models（哪怕是空列表）就说明是引擎的 server，可以关；
       完全没响应才跳过，避免误杀别的程序 */
    const ids = await probeModels(port)
    if (!ids) continue
    const pid = pidListeningOn(port)
    if (!pid) continue
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      closed.push({ engineId: engine.id, port, pid })
      externalProbe.delete(engine.id)
    } catch (err) {
      /* 杀不掉就算了，下面加载会自己报端口冲突 */
    }
  }
  return closed
}

/**
 * 自动匹配：引擎没被 LACI 起，但它的端口上已经有服务（手动双击启动的 Strata 这种），
 * 就在状态里补一条 external 实例，界面能显示"运行中"，不用非得从 LACI 点加载。
 */
async function adoptExternal(engines, models, instances) {
  for (const engine of engines) {
    if (engine.mode === 'remote') continue
    if (instances.some((i) => i.engineId === engine.id)) continue
    const port = Number(engine.defaultPort)
    if (!Number.isInteger(port) || port <= 0) continue
    const hit = externalProbe.get(engine.id)
    let ids
    if (hit && Date.now() - hit.at < 4000) ids = hit.ids
    else {
      ids = await probeModels(port)
      externalProbe.set(engine.id, { at: Date.now(), ids, since: ids ? (hit?.since ?? Date.now()) : undefined })
    }
    /* 只有真的报了模型才算"在跑"：页面里点了卸载、服务还在但没模型，就别显示运行中 */
    if (!ids || ids.length === 0) continue
    const mine = models.filter((m) => m.engineId === engine.id)
    const matched = mine.filter((m) => ids.includes(m.id)).map((m) => m.id)
    const modelIds = matched.length ? matched : (mine.length === 1 ? [mine[0].id] : ids)
    instances.push({
      id: 'ext-' + engine.id,
      engineId: engine.id,
      modelIds,
      port,
      phase: 'ready',
      external: true,
      startedAt: hit?.since ?? Date.now(),
      logTail: `外部进程（不是 LACI 起的），匹配到 127.0.0.1:${port}`,
      error: null,
    })
  }
}

async function buildState(config) {
  const manager = await getRuntimeManager()
  const engines = registry.listEngines()
  const models = allModelsFor(engines)
  const instances = manager.list().map((rt) => rt.status())

  // 引擎状态：有没有实例在跑
  for (const engine of engines) {
    const mine = instances.filter((i) => i.engineId === engine.id)
    engine.runningInstances = mine.length
    engine.loadedModels = mine.flatMap((i) => i.modelIds ?? [])
    // 云端引擎：界面只显示"配没配 key"，key 本身永不出后端（§5.12）
    if (engine.mode === 'remote') engine.hasKey = hasSecret(engine.id)
    /* package 引擎：告诉界面"启动脚本实际加载的是哪个模型文件"，用来区分同引擎下的多个模型 */
    if (engine.mode === 'package') {
      const found = await cachedEngineConfig(engine)
      engine.scriptModelFile = found && found.found && found.config ? (found.config.modelFile || null) : null
      /* 端口以配置文件为准：引擎档案里常常还是导入时的默认 18095 */
      const cfgPort = Number(found && found.found && found.config ? found.config.port : NaN)
      if (Number.isInteger(cfgPort) && cfgPort > 0 && engine.defaultPort !== cfgPort) {
        engine.defaultPort = cfgPort
        const clean = { ...engine }
        delete clean.runningInstances
        delete clean.loadedModels
        delete clean.scriptModelFile
        delete clean.missing
        delete clean.error
        delete clean.orphan
        try { registry.saveEngine(clean) } catch (err) { /* 存不进去就只在内存里用 */ }
      }
    }
  }

  await adoptExternal(engines, models, instances)

  /* 外部实例是在上面循环之后才补的，引擎的"在跑"计数要重算一遍 */
  for (const engine of engines) {
    const mine = instances.filter((i) => i.engineId === engine.id)
    engine.runningInstances = mine.length
    engine.loadedModels = mine.flatMap((i) => i.modelIds ?? [])
  }

  const snap = ledger.snapshot()

  return {
    ok: true,
    now: Date.now(),
    gpu: snap?.gpu ?? null,
    ledger: snap?.ledger ?? null,
    slots: {
      total: snap?.ledger?.negative ? 0 : Math.max(0, 1) // 仅用于 UI 展示，真正判断看 estimate
    },
    engines,
    models,
    instances,
    gateway: { port: config?.gatewayPort ?? 8095 },
    control: { port: config?.consolePort ?? 3101 }
  }
}

/* ------------------------------------------------------------------ */
/* DSH provider 片段                                                  */
/* ------------------------------------------------------------------ */

function buildDshYaml(config, overrides) {
  const base = `http://127.0.0.1:${config?.gatewayPort ?? 8095}/v1`
  const chat = allModelsFor(registry.listEngines()).filter((m) => (m.kind ?? 'chat') === 'chat')
  // §5.11：caps.tools === false 的模型不能放进 DSH 的 models —— DSH 的 provider
  // 没有"不支持工具"的开关，放进去只会静默降级（看着像 agent，其实只会聊天）。
  const models = chat.filter((m) => m.caps?.tools !== false)
  const skipped = chat.filter((m) => m.caps?.tools === false)

  const lines = [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      kvmem-local:',
    '        displayName: LACI',
    '        api: openai-completions',
    `        baseURL: ${base}`,
    '        apiKeyEnv: LACI_LOCAL_API_KEY',
    '        models:'
  ]

  if (skipped.length > 0) {
    lines.push(`          # 已跳过 ${skipped.map((m) => m.id).join('、')}：caps.tools=false（放进选择器只会静默降级）`)
  }

  if (models.length === 0) {
    lines.push('          []')
  } else {
    for (const m of models) {
      /* package 引擎的上下文写在配置文件里；档案里可能还是导入时的默认值，以配置为准 */
      const o = overrides && overrides.get ? overrides.get(m.id) : null
      const ctx = o?.maxContext ?? m.params?.maxContext ?? m.contextWindow ?? 131072
      const maxTokens = o?.maxTokens ?? m.params?.maxTokens ?? m.maxTokens ?? 8192
      const vision = Boolean(m.caps?.vision || m.params?.vision)
      lines.push(`          - id: ${m.id}`)
      lines.push(`            name: ${m.label ?? m.id}`)
      lines.push(`            contextWindow: ${ctx}`)
      lines.push(`            maxTokens: ${maxTokens}`)
      lines.push('            input:')
      lines.push('              - text')
      if (vision) lines.push('              - image')
      lines.push('            compat:')
      lines.push('              supportsReasoningEffort: false')
    }
  }

  return {
    yaml: lines.join('\n'),
    models: models.map((m) => m.id),
    skipped: skipped.map((m) => m.id),
  }}

/* ------------------------------------------------------------------ */
/* 主处理器                                                           */
/* ------------------------------------------------------------------ */

export function createApi(config) {
  const ctx = {
    config,
    // 实例 id → 端口租约。分配出来的端口必须跟着实例走完一生：
    // 只在 load 成功时记下来，实例停了/卸载了/自己没了才还回去，
    // 否则每次加载都会往上爬一位（18095 → 18096 → …），直到 10 分钟 TTL。
    portLeases: new Map(),
    reaperHooked: false,
  }

  return async function handle(req, res, url) {
    const path = url.pathname
    const method = req.method ?? 'GET'
    const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean)

    try {
      /* ---------- 状态 ---------- */
      if (method === 'GET' && seg[0] === 'state' && seg.length === 1) {
        return sendJson(res, 200, await buildState(config))
      }

      /* ---------- 引擎 ---------- */
      if (seg[0] === 'engines') {
        if (method === 'GET' && seg.length === 1) {
          const engines = registry.listEngines()
          return sendJson(res, 200, { ok: true, engines, models: allModelsFor(engines) })
        }

        if (method === 'POST' && seg[1] === 'probe') {
          return await handleProbe(req, res, ctx)
        }

        if (method === 'POST' && seg.length === 1) {
          const body = await readBody(req)
          /* 引擎保存保护：模型页切启动方式会 POST 整个引擎，别把已有的能力声明/预设清空 */
          if (body && typeof body === 'object' && body.id) {
            const before = registry.loadEngine(body.id)
            if (before) {
              const emptyCaps = !body.capabilityArgs || (typeof body.capabilityArgs === 'object' && Object.keys(body.capabilityArgs).length === 0)
              if (emptyCaps && before.capabilityArgs && Object.keys(before.capabilityArgs).length > 0) {
                body.capabilityArgs = before.capabilityArgs
              }
              if (body.presetParams == null && before.presetParams != null) body.presetParams = before.presetParams
            }
          }
          const result = registry.saveEngine(body)
          if (result?.ok === false) return fail(res, 400, firstIssue(result), { errors: result.errors })
          return sendJson(res, 200, { ok: true, engine: result?.engine ?? result ?? body })
        }

        if (method === 'DELETE' && seg.length === 2) {
          const id = decodeURIComponent(seg[1])
          const force = url.searchParams.get('force') === '1'
          const result = registry.deleteEngine(id, { force })
          if (result?.ok === false) {
            return fail(res, 409, firstIssue(result), { errors: result.errors, hint: '引擎下还有模型，加 ?force=1 连模型一起删' })
          }
          return sendJson(res, 200, { ok: true })
        }

        /* 把"脚本写死模型"的引擎转成"按参数运行"：之后点哪个模型起哪个 */
        if (method === 'POST' && seg.length === 3 && seg[2] === 'convert') {
          const engine = registry.loadEngine(decodeURIComponent(seg[1]))
          if (!engine) return fail(res, 404, '没有这个引擎')
          let target = null
          let warnings = []
          if (engine.mode === 'custom') {
            /* 已经是按参数运行：只把 argv/env 里的字面量换成模板变量（每个模型用自己的参数） */
            target = importer.templatizeEngine(engine)
            warnings = ['已把 argv/env 里的字面量换成模板变量']
          } else {
            const converted = await importer.convertScriptEngine(engine)
            if (!converted.ok) return fail(res, 400, converted.reason)
            target = converted.engine
            warnings = converted.warnings || []
          }
          const body = { ...target }
          delete body.runningInstances
          delete body.loadedModels
          delete body.raw
          delete body.missing
          delete body.orphan
          delete body.error
          const saved = registry.saveEngine(body)
          if (saved && saved.ok === false) return fail(res, 400, firstIssue(saved), { errors: saved.errors })
          engineConfigCache.delete(engine.id)
          return sendJson(res, 200, {
            ok: true,
            engine: saved?.engine ?? saved ?? body,
            warnings,
          })
        }

        /* 配置文件（package 引擎）：GET 读真实参数，PUT 把界面改的参数写回文件 */
        if (seg.length === 3 && seg[2] === 'config' && (method === 'GET' || method === 'PUT')) {
          const engine = registry.loadEngine(decodeURIComponent(seg[1]))
          if (!engine) return fail(res, 404, '没有这个引擎')
          const found = await importer.findEngineConfig(engine)

          if (method === 'GET') {
            if (found.found && found.file) {
              try { found.mtimeMs = statSync(found.file).mtimeMs } catch { /* 读不到就留空 */ }
            }
            return sendJson(res, 200, { ok: true, ...found })
          }

          if (!found.found) return fail(res, 400, '这个引擎没有可写的配置文件')
          if (found.config && found.config.source === 'script') {
            return fail(res, 400, '这个引擎的启动依据是启动脚本，不是配置文件；要改请手动编辑脚本')
          }
          const body = await readBody(req)
          if (!body || typeof body.values !== 'object' || !body.values) return fail(res, 400, '缺 values')
          const capability = found.reasoning || (found.config && found.config.reasoning) || null
          const effort = body.values.reasoningEffort
          if (effort != null && effort !== '') {
            if (!capability || capability.mode !== 'config') {
              return fail(res, 400, '这个引擎没有可写的思考等级（探测不到配置键）')
            }
            const levels = Array.isArray(capability.levels) && capability.levels.length ? capability.levels : ['none', 'low', 'medium', 'high']
            if (!levels.includes(String(effort))) {
              return fail(res, 400, `思考等级只能是 ${levels.join(' / ')}（引擎不认 ${effort}）`)
            }
          }
          let result
          try {
            result = await importer.writeEngineConfig(found.file, body.values, {
              expectedMtimeMs: body.expectedMtimeMs,
              reasoningKey: capability && capability.mode === 'config' ? capability.key : null,
              reasoningLevels: capability && capability.levels,
              budgetKey: capability && capability.budgetKey,
            })
          } catch (err) {
            return fail(res, err.code === 'ECONFLICT' ? 409 : 400, err.message)
          }

          /* 记历史：只记可编辑参数（按 引擎 + 模型）；有思考能力时多记一档等级 */
          let history = null;
          if (Array.isArray(result.changed) && result.changed.length && body.modelId) {
            const model = registry.loadModel(String(body.modelId))
            if (model) {
              const historyMod = await import('../core/history.mjs')
              const values = {
                maxContext: result.config.maxContext,
                kvDtype: result.config.kvDtype,
                kvResident: result.config.kvResident,
                draftTokens: result.config.draftTokens,
                mtp: result.config.mtp,
                vision: result.config.vision,
                reasoningBudget: result.config.reasoningBudget,
              }
              if (capability && capability.mode === 'config' && result.config.reasoningEffort) {
                values.reasoningEffort = result.config.reasoningEffort
              }
              const entry = historyMod.appendHistory({
                engineId: engine.id,
                modelId: model.id,
                source: 'config',
                values,
              })
              history = { appended: entry.appended, item: entry.item, items: entry.items }
            }
          }
          return sendJson(res, 200, {
            ok: true,
            ...result,
            /* 写回后的 summary 是纯 JSON 归纳，能力要重新挂上——不然界面存完就忘了怎么调 */
            config: result.config ? { ...result.config, reasoning: capability } : result.config,
            reasoning: capability,
            history,
          })
        }

        if (method === 'GET' && seg.length === 2) {
          const engine = registry.loadEngine(decodeURIComponent(seg[1]))
          if (!engine) return fail(res, 404, '没有这个引擎')
          return sendJson(res, 200, { ok: true, engine })
        }
      }

      /* ---------- 云端密钥（§5.12：只进不出） ----------
       *
       * secrets.json 存 `{ 引擎id: "sk-..." }`，和引擎档案分开：引擎档案要能导出、
       * 分享，绝不能带上 key。所以这两个端点**永远不回显 key**，只回"配没配"。
       */
      if (seg[0] === 'secrets' && seg.length === 2) {
        const engineId = decodeURIComponent(seg[1])
        const engine = registry.loadEngine(engineId)
        if (!engine) return fail(res, 404, `没有引擎 ${engineId}`)
        if (engine.mode !== 'remote') return fail(res, 400, `${engineId} 不是云端引擎，本地引擎不需要密钥`)

        if (method === 'GET') {
          return sendJson(res, 200, { ok: true, engineId, hasKey: hasSecret(engineId) })
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const key = typeof body.key === 'string' ? body.key.trim() : body.key
          if (key != null && typeof key !== 'string') return fail(res, 400, 'key 必须是字符串，留空就是删除')
          let result
          try {
            result = saveSecret(engineId, key == null || key === '' ? null : key)
          } catch (err) {
            return fail(res, 400, `写不了密钥：${err?.message ?? err}`)
          }
          return sendJson(res, 200, { ok: true, engineId, hasKey: result.hasKey })
        }
      }

      /* ---------- 模型 ---------- */
      if (seg[0] === 'models') {
        if (method === 'GET' && seg.length === 1) {
          const engineId = url.searchParams.get('engineId')
          const all = allModelsFor(registry.listEngines())
          const models = engineId ? all.filter((m) => m.engineId === engineId) : all
          return sendJson(res, 200, { ok: true, models })
        }

        if (method === 'POST' && seg.length === 1) {
          const body = await readBody(req)
          const engine = body.engineId ? registry.loadEngine(body.engineId) : null
          if (body.engineId && !engine) return fail(res, 400, `没有引擎 ${body.engineId}`)
          const result = registry.saveModel(body)
          if (result?.ok === false) return fail(res, 400, firstIssue(result), { errors: result.errors })
          return sendJson(res, 200, { ok: true, model: result?.model ?? result ?? body })
        }

        /* ---------- 只改模型档案里的思考设置（配置文件模式下用） ----------
           为什么单独一个端点：配置模式保存的是引擎的 JSON，思考等级在那边；
           但 allowRequestOverride 是网关字段（D4），只存在于模型档案里。
           窄更新避免拿整张表单去覆盖模型档案（配置模式下很多字段是"不适用"的空值）。 */
        if (method === 'POST' && seg.length === 3 && seg[2] === 'thinking') {
          const id = decodeURIComponent(seg[1])
          const model = registry.loadModel(id)
          if (!model) return fail(res, 404, `没有模型 ${id}`)
          const body = await readBody(req)
          if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, '缺参数')
          const thinking = { ...(model.thinking || {}) }
          if (body.effort !== undefined) thinking.effort = body.effort
          if (body.allowRequestOverride !== undefined) thinking.allowRequestOverride = body.allowRequestOverride === true
          const result = registry.saveModel({ ...model, thinking })
          if (result?.ok === false) return fail(res, 400, firstIssue(result), { errors: result.errors })
          return sendJson(res, 200, { ok: true, model: result?.model ?? result })
        }

        if (method === 'DELETE' && seg.length === 2) {
          const id = decodeURIComponent(seg[1])
          const result = registry.deleteModel(id)
          if (result?.ok === false) return fail(res, 409, firstIssue(result), { errors: result.errors })
          return sendJson(res, 200, { ok: true })
        }

        /* ---------- 参数历史（按 引擎 + 模型 区分，最多 10 条） ---------- */
        if (method === 'GET' && seg.length === 3 && seg[2] === 'history') {
          const modelId = decodeURIComponent(seg[1])
          const engineId = url.searchParams.get('engineId') || ''
          const history = await import('../core/history.mjs')
          return sendJson(res, 200, { ok: true, items: history.listHistory(engineId, modelId) })
        }

        if (method === 'POST' && seg.length === 4 && seg[2] === 'history' && seg[3] === 'rename') {
          const modelId = decodeURIComponent(seg[1])
          const body = await readBody(req)
          const history = await import('../core/history.mjs')
          const result = history.renameHistory({
            engineId: body.engineId,
            modelId,
            itemId: body.itemId,
            name: body.name,
          })
          return sendJson(res, result.ok ? 200 : 404, { ok: result.ok, items: result.items })
        }
      }

      /* ---------- 实例 ---------- */
      if (seg[0] === 'instances') {
        const manager = await getRuntimeManager()
        hookPortReaper(manager, ctx)

        if (method === 'GET' && seg.length === 1) {
          return sendJson(res, 200, { ok: true, instances: manager.list().map((rt) => rt.status()) })
        }

        // GET /api/instances/:id/log?tail=N —— 加载中 / 出错后看日志（前端 2 秒轮一次）
        if (method === 'GET' && seg.length === 3 && seg[2] === 'log') {
          const id = decodeURIComponent(seg[1])
          const rt = manager.get(id)
          if (!rt) return fail(res, 404, `没有实例 ${id}`)
          const want = Number(url.searchParams.get('tail'))
          const tail = Number.isFinite(want) ? Math.min(1000, Math.max(1, Math.trunc(want))) : 200
          return sendJson(res, 200, {
            ok: true,
            instanceId: id,
            phase: rt.phase,
            lines: rt.tail(tail),
            log: rt.status().log
          })
        }

        if (method === 'POST' && seg.length === 1) {
          return await withLoadLock(() => handleLoad(req, res, ctx, manager))
        }

        if (method === 'DELETE' && seg.length === 2) {
          const id = decodeURIComponent(seg[1])
          const force = url.searchParams.get('force') === '1'
          try {
            const status = await manager.unload(id, { force })
            releasePortLease(ctx, id)
            return sendJson(res, 200, { ok: true, instance: status })
          } catch (err) {
            return fail(res, 404, err.message)
          }
        }
      }

      /* ---------- 显存预估 ---------- */
      if (method === 'POST' && seg[0] === 'estimate' && seg.length === 1) {
        const body = await readBody(req)
        const ids = Array.isArray(body.modelIds) ? body.modelIds : (body.modelId ? [body.modelId] : [])
        if (ids.length === 0) return fail(res, 400, '缺 modelId')
        const models = ids.map((id) => registry.loadModel(id))
        const missing = ids.filter((id, i) => !models[i])
        if (missing.length > 0) return fail(res, 400, `没有这些模型：${missing.join(', ')}`)
        const manager = await getRuntimeManager()
        const instances = manager.list().map((rt) => rt.status())
        // 多模型实例是一份合计：ledger.estimate 收数组，自己会把每个模型的显存加起来
        const est = ledger.estimate(models, { instances })
        return sendJson(res, 200, { ok: true, estimate: est })
      }

      /* ---------- 导入（M3） ---------- */
      if (seg[0] === 'import') {
        if (method === 'POST' && seg[1] === 'scan') {
          const body = await readBody(req)
          if (!body.dir) return fail(res, 400, '缺 dir')
          // 粘贴进来的目录可能带引号（资源管理器「复制文件地址」）
          const scan = await importer.scanPackage(cleanPath(body.dir), body.opts ?? {})
          return sendJson(res, 200, { ok: true, ...scan })
        }

        if (method === 'POST' && seg[1] === 'parse-bat') {
          const body = await readBody(req)
          if (!body.file) return fail(res, 400, '缺 file')
          const parsed = await importer.parseBat(cleanPath(body.file))
          return sendJson(res, 200, { ok: true, parsed })
        }

        if (method === 'POST' && seg[1] === 'draft') {
          const body = await readBody(req)
          const scan = body.scan ?? (body.dir ? await importer.scanPackage(cleanPath(body.dir), body.opts ?? {}) : null)
          if (!scan) return fail(res, 400, '缺 scan 或 dir')
          const draft = await importer.buildDraft(scan, {
            mode: body.mode,
            script: body.script,
            engine: body.engine,
            model: body.model
          })
          return sendJson(res, 200, { ok: true, ...draft })
        }

        if (method === 'POST' && seg[1] === 'preview') {
          const body = await readBody(req)
          const engine = body.engine ?? (body.engineId ? registry.loadEngine(body.engineId) : null)
          const model = body.model ?? (body.modelId ? registry.loadModel(body.modelId) : null) ?? {}
          if (!engine) return fail(res, 400, '缺 engine')
          // 有真实模型档案时走 M2 的命令行生成器：它才认识 capabilityArgs / extraArgs / env，
          // 预览和真正启动必须是同一份逻辑，否则界面显示的和引擎收到的会不一样。
          let preview
          try {
            preview = model && typeof model === 'object' && (model.params || model.files)
              ? buildCommand(engine, [model], { port: engine.defaultPort })
              : importer.previewCommand(engine, model)
          } catch {
            preview = importer.previewCommand(engine, model)
          }
          return sendJson(res, 200, { ok: true, preview })
        }

        if (method === 'POST' && seg[1] === 'cleanup') {
          const purged = await importer.cleanupEphemeral()
          return sendJson(res, 200, { ok: true, purged })
        }

        if (method === 'POST' && seg[1] === 'apply') {
          const body = await readBody(req)
          const applied = importer.applyProbeResult(body.engine, body.model, body.result)
          return sendJson(res, 200, { ok: true, applied })
        }

        return fail(res, 404, `没有这个导入接口：${method} ${path}`)
      }

      /* ---------- DSH ---------- */
      if (method === 'GET' && seg[0] === 'dsh' && seg[1] === 'provider') {
        /* package 引擎的配置是真相：先把每个引擎配置里的上下文读出来，覆盖模型档案里的默认值 */
        const overrides = new Map()
        for (const engine of registry.listEngines()) {
          if (engine.mode !== 'package') continue
          const found = await cachedEngineConfig(engine).catch(() => null)
          const cfg = found && found.found ? found.config : null
          if (!cfg) continue
          for (const m of allModelsFor([engine])) {
            if (m.engineId !== engine.id) continue
            overrides.set(m.id, { maxContext: cfg.maxContext, maxTokens: cfg.maxTokens })
          }
        }
        return sendJson(res, 200, { ok: true, ...buildDshYaml(config, overrides) })
      }

      /* ---------- 网关健康 ---------- */
      if (method === 'GET' && seg[0] === 'health') {
        const gw = config?.gatewayPort ?? 8095
        const body = await httpGetJson(`http://127.0.0.1:${gw}/health`, 2000)
        return sendJson(res, 200, { ok: Boolean(body), gateway: body })
      }

      /* ---------- 目录浏览（页面内选择器，绕开 Windows 焦点问题） ---------- */
      if (method === 'GET' && seg[0] === 'fs' && seg.length === 1) {
        const dir = cleanPath(url.searchParams.get('dir') || '')
        const mode = url.searchParams.get('mode') === 'file' ? 'file' : 'dir'
        try {
          return sendJson(res, 200, { ok: true, mode, ...listDirectory(dir) })
        } catch (err) {
          return fail(res, 400, `读不了这个目录：${err.message}`)
        }
      }

      /* ---------- 原生对话框 / 打开资源管理器 ---------- */
      //
      // 浏览器拿不到真实本地路径（<input type=file> 只给假路径，File System Access
      // 只给句柄），所以由服务端在这台机器上调 Windows 原生对话框。
      // 前提：控制台跑在有桌面的用户会话里（本项目本来就是这样）。
      if (method === 'POST' && seg[0] === 'dialog' && seg.length === 1) {
        const body = await readBody(req)
        const mode = body.mode === 'dir' ? 'dir' : 'file'
        if (dialogPending) {
          // 已经有一个开着：不要再弹第二个，也不要报错 —— 把它抬到前台就行。
          // （以前这里回 409，用户连点几次就满屏红 toast，还以为坏了。）
          const focused = await forceDialogFront(activeDialogPid)
          return sendJson(res, 200, {
            ok: true,
            focused,
            path: null,
            cancelled: true,
            message: focused ? '已经有一个对话框，已把它切到前台' : '已经有一个对话框开着，请先处理它'
          })
        }
        dialogPending = true
        let picked
        try {
          picked = await openNativeDialog(mode, {
            defaultPath: cleanPath(body.defaultPath || ''),
            title: body.title,
            filter: body.filter
          })
        } finally {
          dialogPending = false
        }
        if (!picked.ok) return fail(res, 500, `打不开文件对话框：${picked.error}`)
        return sendJson(res, 200, { ok: true, path: picked.path || null, cancelled: !picked.path })
      }

      if (method === 'POST' && seg[0] === 'reveal' && seg.length === 1) {
        const body = await readBody(req)
        const target = cleanPath(body.path || '')
        if (!target) return fail(res, 400, '缺 path')
        revealInExplorer(target)
        return sendJson(res, 200, { ok: true })
      }

      return fail(res, 404, `没有这个接口：${method} ${path}`)
    } catch (err) {
      return fail(res, 500, err?.message ?? String(err))
    }
  }
}

/* ------------------------------------------------------------------ */
/* 加载实例                                                           */
/* ------------------------------------------------------------------ */

async function handleLoad(req, res, ctx, manager) {
  const body = await readBody(req)
  const modelIds = Array.isArray(body.modelIds) ? body.modelIds : body.modelId ? [body.modelId] : []
  if (modelIds.length === 0) return fail(res, 400, '缺 modelId')

  const models = modelIds.map((id) => registry.loadModel(id)).filter(Boolean)
  if (models.length !== modelIds.length) {
    const missing = modelIds.filter((id, i) => !models[i])
    return fail(res, 400, `没有这些模型：${missing.join(', ')}`)
  }

  const engine = registry.loadEngine(models[0].engineId)
  if (!engine) return fail(res, 400, `引擎不存在：${models[0].engineId}`)

  if (engine.mode === 'remote') {
    return fail(res, 409, '云端模型不需要加载，它一直在')
  }

  /* package 引擎的启动脚本里写死了模型文件：选错模型就是"跑错模型"，先拦下来 */
  if (engine.mode === 'package') {
    const found = await cachedEngineConfig(engine)
    const scriptModel = found && found.found && found.config ? found.config.modelFile : null
    if (scriptModel) {
      const scriptBase = path.basename(String(scriptModel)).toLowerCase()
      const picked = models
        .map((m) => (m.files ? (m.files.model || Object.values(m.files)[0]) : null))
        .filter(Boolean)
        .map((f) => path.basename(String(f)).toLowerCase())
      if (!picked.includes(scriptBase)) {
        return fail(res, 409, `这个引擎的启动脚本实际加载的是 ${path.basename(String(scriptModel))}，和选择的模型不一致；要跑别的模型请把引擎改成「按参数运行」。`)
      }
    }
    /* 不弹网页：这类服务认 config 里的 open_browser:false（就算脚本带 --open 也压得住）。
       由 LACI 写一次，之后新加模型不会再弹，也不用动整合包。 */
    if (found && found.found && found.file && found.config && found.config.openBrowser !== false) {
      try {
        await importer.writeEngineConfig(found.file, { openBrowser: false })
      } catch (err) {
        /* 写不进去就算了，别因为一个网页把加载挡下 */
      }
    }
    /* 配置文件为主：把配置里的值同步回模型档案，别让面板/导出读到导入时的旧默认值。
       只在配置里明确有模型文件时才同步（多模型引擎不会互相串），写失败只忽略。 */
    const cfg = found && found.found ? found.config : null;
    if (cfg && cfg.modelFile) {
      const keys = ['maxContext', 'kvWindow', 'kvDtype', 'kvResident', 'hostKvMib', 'kvHeadroomMib', 'prefillChunk', 'mtp', 'draftTokens', 'vision'];
      for (const m of models) {
        /* 每个模型只同步一次（第一次加载）：之后用户在模型页怎么改都不覆盖 */
        if (m.params && m.params.configSynced) continue;
        const next = { ...(m.params || {}) };
        for (const key of keys) {
          if (cfg[key] != null) next[key] = cfg[key];
        }
        next.configSynced = true;
        try {
          registry.saveModel({ ...m, params: next });
        } catch (err) {
          /* 模型档案写不进去就算了，加载照常 */
        }
      }
    }
  }

  /* 加载前先关掉外部起的同名进程：否则端口/显存被占着，LACI 起不来 */
  const closedExternal = await closeExternalProcesses(registry.listEngines(), manager)

  const instances = manager.list().map((rt) => rt.status())
  const check = ledger.checkStart(engine, models, { instances })

  if (check && check.allowed === false) {
    const blocked = check.blocks?.[0]?.message ?? '不能启动'
    return fail(res, 409, blocked, { check })
  }

  // 显存/内存不够 -> 需要用户确认（软闸门）
  if (check?.requiresConfirm && !body.force) {
    return sendJson(res, 409, {
      ok: false,
      requiresConfirm: true,
      estimate: check.estimate,
      message: '显存或内存可能不够',
      detail: {
        neededVram: check.estimate?.neededVram,
        neededRam: check.estimate?.neededRam,
        freeVram: check.estimate?.freeVram,
        freeRam: check.estimate?.freeRam,
        shortVram: check.estimate?.shortVram,
        shortRam: check.estimate?.shortRam,
        source: check.estimate?.source
      }
    })
  }

  // 分配端口 + 预留显存
  let lease = null
  let portLease = null
  /* package 引擎的端口写在启动脚本/配置里（Strata 的 bat 固定 8080）。
     判活必须用那个端口，否则会在引擎基址（18095）上白等 300 秒。 */
  let scriptPort = null
  if (engine.mode === 'package') {
    try {
      const found = await importer.findEngineConfig(engine)
      const raw = found && found.found && found.config ? Number(found.config.port) : NaN
      if (Number.isInteger(raw) && raw > 0 && raw < 65536) scriptPort = raw
    } catch {
      /* 读不到就按引擎基址 */
    }
  }
  try {
    portLease = await allocPort({
      engine,
      model: models[0],
      base: scriptPort ?? undefined,
      reservedPorts: [...RESERVED_PORTS],
      instances
    })
    if (scriptPort && Number(portLease?.port) !== scriptPort) {
      try { portLease?.release?.() } catch {}
      return fail(res, 409, `启动脚本固定用端口 ${scriptPort}，但它被占用了（可能已经有一个引擎在跑）。先关掉占用 ${scriptPort} 的进程再加载。`)
    }
    lease = ledger.reserve(models, { instances })

    const rt = await manager.load({
      engine,
      models,
      port: portLease?.port ?? engine.defaultPort,
      lease,
      wait: body.wait !== false
    })

    // 端口租约跟着实例走：它活着就占着，idle / 卸载 / 进程消失时由 hookPortReaper 还
    const instanceId = rt.status().id
    if (portLease) ctx.portLeases.set(instanceId, portLease)

    return sendJson(res, 202, { ok: true, instance: rt.status(), closedExternal })
  } catch (err) {
    try { portLease?.release?.() } catch {}
    try { lease?.release?.('加载失败') } catch {}
    return fail(res, 500, err?.message ?? String(err))
  }
}

/* ------------------------------------------------------------------ */
/* 试启动（SSE）                                                      */
/* ------------------------------------------------------------------ */

async function handleProbe(req, res, ctx) {
  const body = await readBody(req)
  const engine = body.engine ?? (body.engineId ? registry.loadEngine(body.engineId) : null)
  const model = body.model ?? (body.modelId ? registry.loadModel(body.modelId) : null) ?? {}

  if (!engine || !engine.file) return fail(res, 400, '缺 engine.file')

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })

  const send = (event, data) => {
    if (res.writableEnded) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  let closed = false
  // SSE 断开就取消试启动，别让探测进程在后台跑满 30 分钟
  const ac = new AbortController()
  req.on('close', () => {
    closed = true
    try { ac.abort() } catch {}
  })

  try {
    const result = await importer.probe(engine, model, {
      signal: ac.signal,
      onEvent: (evt) => {
        if (closed) return
        if (evt.type === 'log' || evt.type === 'stdout' || evt.type === 'stderr') {
          send('log', { line: evt.line ?? evt.text ?? '' })
        } else if (evt.type === 'port') {
          send('port', { port: evt.port, readyUrl: evt.readyUrl })
        } else if (evt.type === 'stalled') {
          send('stalled', { seconds: evt.seconds ?? 30 })
        } else if (evt.type === 'ready-path') {
          send('port', { port: evt.port, readyUrl: evt.readyUrl })
        }
      }
    })
    // 试启动里顺手做了工具探测（§5.5.1）；如果探的是**已保存**的模型，
    // 就把 caps.tools 写回去，别让这个结果白跑一次。
    if (body.modelId && result && result.caps && typeof result.caps.tools === 'boolean') {
      try {
        const saved = registry.loadModel(body.modelId)
        if (saved) {
          saved.caps = { ...(saved.caps || {}), tools: result.caps.tools }
          registry.saveModel(saved)
        }
      } catch {
        /* 回填失败不影响试启动结果 */
      }
    }
    send('done', { ok: Boolean(result?.ok), result })
  } catch (err) {
    send('done', { ok: false, error: err?.message ?? String(err) })
  } finally {
    if (!res.writableEnded) res.end()
  }
}

/* ------------------------------------------------------------------ */
/* 原生对话框 / 打开资源管理器                                          */
/* ------------------------------------------------------------------ */

/**
 * 列一个目录（给页面内的路径选择器用）。
 * 只读、上限 500 条：这是个本机 127.0.0.1 的调度台，不需要做通用文件管理器。
 */
function listDirectory(dir) {
  if (!dir) {
    const drives = []
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const p = `${letter}:\\`
      try {
        if (fs.statSync(p).isDirectory()) drives.push({ name: p, path: p, kind: 'dir', size: null })
      } catch {
        /* 没有这个盘 */
      }
    }
    return { dir: '', parent: null, entries: drives }
  }

  const stat = fs.statSync(dir)
  if (!stat.isDirectory()) {
    // 传进来是个文件：列出它所在目录，并把该文件标出来
    const parent = path.dirname(dir)
    const listed = listDirectory(parent)
    return { ...listed, select: dir }
  }

  const entries = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue
    const full = path.join(dir, ent.name)
    const kind = ent.isDirectory() ? 'dir' : 'file'
    let size = null
    if (kind === 'file') {
      try { size = fs.statSync(full).size } catch { size = null }
    }
    entries.push({ name: ent.name, path: full, kind, size })
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  })

  const parent = path.dirname(dir)
  return {
    dir,
    parent: parent === dir ? '' : parent,
    entries: entries.slice(0, 500),
    truncated: entries.length > 500,
  }
}

/**
 * 把"已经开着"的对话框抬到前台。给重复点击用：返回 true = 找到并抢到了前台。
 * 只编译 C# + 调 Win32，不创建任何窗口，所以可以安心 windowsHide。
 */
async function forceDialogFront(pid) {
  const target = Number(pid)
  if (!Number.isInteger(target) || target <= 0) return false
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$code = @'",
    FG_CSHARP,
    "'@",
    'Add-Type -TypeDefinition $code',
    `$h = [LaciFg]::FindDialog([uint32]${target})`,
    "if ($h -eq [IntPtr]::Zero) { 'none' } elseif ([LaciFg]::Force($h)) { 'ok' } else { 'fail' }"
  ].join('\n')

  const tmp = path.join(os.tmpdir(), `laci-focus-${process.pid}-${Date.now()}.ps1`)
  try {
    fs.writeFileSync(tmp, `\ufeff${script}`, 'utf8')
  } catch {
    return false
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { timeout: 20 * 1000, windowsHide: true },
      (err, stdout) => {
        try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }
        resolve(!err && String(stdout || '').trim() === 'ok')
      }
    )
  })
}

/**
 * 弹 Windows 原生对话框，返回选中的路径。
 *
 * 用 PowerShell + System.Windows.Forms，是这台机器上唯一"零依赖、能拿到真实路径"
 * 的办法（不用装 Electron / node-gui）。`-STA` 是 Windows.Forms 的硬要求。
 *
 * 取消（点了取消/关掉）返回 { ok:true, path:null }，不是错误。
 */
function openNativeDialog(mode, { defaultPath = '', title = '', filter = '' } = {}) {
  // 传进来的 defaultPath 是已存在的目录、却要求"选文件" → 按目录处理。
  // 前端按钮的 data-mode 有可能和输入框里实际内容不一致，这里兜一层。
  let effective = mode === 'dir' ? 'dir' : 'file'
  try {
    if (effective === 'file' && defaultPath && statSync(defaultPath).isDirectory()) effective = 'dir'
  } catch {
    /* 路径不存在就按原样 */
  }

  const safeTitle = String(title || (effective === 'dir' ? '选择文件夹' : '选择文件')).replace(/'/g, "''")
  const safeDefault = String(defaultPath || '').replace(/'/g, "''")
  const safeFilter = String(filter || '所有文件 (*.*)|*.*').replace(/'/g, "''")

  /**
   * 抢前台。为什么需要一整套 Win32：
   *   - 弹窗进程是后台 node 的子进程，Windows 前台锁会无视 SetForegroundWindow；
   *   - 必须先 AttachThreadInput 到当前前台线程，才允许把焦点抢过来；
   *   - 再 SetWindowPos(HWND_TOPMOST) 保证它压在所有普通窗口（包括浏览器）上面。
   *
   * FindDialog 按"本进程 + class #32770"找对话框句柄，不用猜标题（标题是本地化的）。
   */
  const fgHelper = `$fgCode = @'
${FG_CSHARP}
'@
Add-Type -TypeDefinition $fgCode
`

  // 黑窗口藏掉（不影响对话框）
  const hideConsole = `
$cf = Add-Type -PassThru -Name ConsoleHide -Namespace Win32 -MemberDefinition '[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'
[Win32.ConsoleHide]::ShowWindow([Win32.ConsoleHide]::GetConsoleWindow(), 0) | Out-Null
`

  // 隐藏的 TopMost 宿主窗口：对话框的 owner（有些控件会继承它的层级）
  const owner = `
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'LACI'
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Location = New-Object System.Drawing.Point(-2000, -2000)
$owner.TopMost = $true
$owner.Show()
`

  /**
   * 定时把对话框顶到前台。
   * ShowDialog 会占用当前线程跑消息循环，所以只能用 WinForms Timer。
   * 只在"还没拿到前台"时抢，最多 20 次（约 4 秒），之后停手，避免和用户抢焦点。
   */
  const raiser = `
$script:ticks = 0
$script:centered = $false
$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 200
$script:timer.Add_Tick({
  try {
    $script:ticks++
    $h = [LaciFg]::FindDialog([uint32]$PID)
    if ($h -ne [IntPtr]::Zero) {
      if (-not $script:centered) { [LaciFg]::Center($h); $script:centered = $true }
      elseif ($script:ticks -eq 4) { [LaciFg]::Center($h) }
      if ([LaciFg]::GetForegroundWindow() -ne $h) { [LaciFg]::Force($h) }
      if ([LaciFg]::GetForegroundWindow() -eq $h) { $script:timer.Stop() }
    }
    if ($script:ticks -ge 20) { $script:timer.Stop() }
  } catch { }
})
$script:timer.Start()
`

  const dialog = effective === 'dir'
    ? `
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${safeTitle}'
$d.ShowNewFolderButton = $true
if ('${safeDefault}' -and (Test-Path -LiteralPath '${safeDefault}')) { $d.SelectedPath = '${safeDefault}' }
$r = $d.ShowDialog($owner)
if ($r -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
`
    : `
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Title = '${safeTitle}'
$d.Filter = '${safeFilter}'
if ('${safeDefault}') { $d.FileName = '${safeDefault}' }
$r = $d.ShowDialog($owner)
if ($r -eq 'OK') { [Console]::Out.Write($d.FileName) }
`

  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    fgHelper,
    hideConsole,
    owner,
    raiser,
    dialog,
    '$script:timer.Stop()',
    '$owner.Close()'
  ].join('\n')

  // 脚本比较长、还内嵌 C#，走 -Command 容易被引号/换行坑；写成临时 .ps1 用 -File。
  // 必须带 BOM：Windows PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码，中文会乱码。
  const tmpFile = path.join(os.tmpdir(), `laci-dialog-${process.pid}-${Date.now()}.ps1`)
  try {
    fs.writeFileSync(tmpFile, `\ufeff${script}`, 'utf8')
  } catch (err) {
    return Promise.resolve({ ok: false, error: `写临时脚本失败：${err.message}`, path: null })
  }

  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      // 不要用 windowsHide / -WindowStyle Hidden：实测那会把 WinForms 对话框
      // 一起隐藏（甚至让 ShowDialog 立刻返回 Cancel），表现就是"点了没反应"。
      // 黑窗口由脚本里的 ShowWindow(…, 0) 自己藏。
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmpFile],
      { timeout: 10 * 60 * 1000, windowsHide: false, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        activeDialogPid = null
        try { fs.unlinkSync(tmpFile) } catch { /* 删不掉就留给系统清理 */ }
        if (err) {
          const detail = String(stderr || '').trim() || err.message
          resolve({ ok: false, error: detail, path: null })
          return
        }
        const picked = String(stdout || '').trim() || null
        resolve({ ok: true, path: picked, error: null })
      }
    )
    // 记下这个对话框的进程号：重复点击时用它找到窗口、抬到前台
    activeDialogPid = child.pid ?? null
  })
}

/** 在资源管理器里显示这个路径（文件就选中它，目录就打开它）。explorer 永远返回 1，别当失败。 */
function revealInExplorer(target) {
  const arg = existsSync(target) && !target.endsWith('\\') ? `/select,${target}` : target
  try {
    execFile('explorer.exe', [arg], { windowsHide: false }, () => {})
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* 极简 HTTP GET（给 /api/health 用）                                 */
/* ------------------------------------------------------------------ */

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    try {
      const req = http.get(url, { timeout: timeoutMs }, (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { buf += c })
        res.on('end', () => {
          try { finish(JSON.parse(buf)) } catch { finish(null) }
        })
      })
      req.on('timeout', () => { req.destroy(); finish(null) })
      req.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })
}
