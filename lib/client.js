window.__ModuleLoader__?.load({
  id: 'dsh-laci-engine',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const NS = 'laciEngine'
    const PANEL_ID = 'laci-engine'
    const ROUTE = '/laci-engine'
    const POLL_MS = 3000

    const zh = {
      panel: '模型调度',
      title: 'LACI 本地模型',
      subtitle: '按需加载本地推理引擎，关闭后立即释放显存。',
      load: '加载模型',
      loading: '正在加载…',
      close: '关闭模型',
      closing: '正在关闭…',
      confirmTitle: '关闭 LACI 模型？',
      confirmBody: '关闭会停止本地推理引擎并释放显存。正在使用该模型的对话将无法继续，直到再次加载。',
      cancel: '取消',
      confirm: '确认关闭',
      statusReady: '已就绪',
      statusStarting: '正在加载',
      statusStopped: '未加载',
      statusUnreachable: '插件未连接',
      hintReady: '本地引擎正在 8095 端口提供模型服务，可以开始对话。',
      hintStarting: '引擎进程已启动，正在加载权重，请稍候。',
      hintStopped: '点击“加载模型”启动本地推理引擎。冷启动通常需要 5–10 秒。',
      hintExternal: '端口上已有一个外部启动的 LACI 实例，可以直接使用。',
      model: '模型',
      process: '进程',
      uptime: '运行时长',
      engine: '引擎',
      managed: '由 DSH 启动',
      external: '外部实例',
      none: '—',
      refresh: '刷新',
      log: '引擎日志',
      logHint: '最近 80 行',
      logEmpty: '暂无日志',
      logFailed: '读取日志失败',
      statusFailed: '无法读取引擎状态',
      loadFailed: '加载失败',
      closeFailed: '关闭失败',
      footnote: '退出 DSH 时会自动关闭由本插件启动的引擎。',
    }

    const en = {
      panel: 'Model center',
      title: 'Local LACI model',
      subtitle: 'Load the local inference engine on demand and free its VRAM when you close it.',
      load: 'Load model',
      loading: 'Loading…',
      close: 'Close model',
      closing: 'Closing…',
      confirmTitle: 'Close the LACI model?',
      confirmBody: 'Closing stops the local inference engine and frees its VRAM. Conversations using it cannot continue until you load it again.',
      cancel: 'Cancel',
      confirm: 'Close model',
      statusReady: 'Ready',
      statusStarting: 'Starting',
      statusStopped: 'Not loaded',
      statusUnreachable: 'Plugin unavailable',
      hintReady: 'The local engine is serving the model on port 8095. You can start chatting.',
      hintStarting: 'The engine process is up and loading weights.',
      hintStopped: 'Choose “Load model” to start the local inference engine. A cold start usually takes 5–10 seconds.',
      hintExternal: 'Another LACI instance is already listening on the port and can be used as is.',
      model: 'Model',
      process: 'Process',
      uptime: 'Uptime',
      engine: 'Engine',
      managed: 'Started by DSH',
      external: 'External instance',
      none: '—',
      refresh: 'Refresh',
      log: 'Engine log',
      logHint: 'Last 80 lines',
      logEmpty: 'No log output yet',
      logFailed: 'Could not read the log',
      statusFailed: 'Could not read engine status',
      loadFailed: 'Load failed',
      closeFailed: 'Close failed',
      footnote: 'Closing DSH also closes the engine this plugin started.',
    }

    async function api(action, init = {}, timeoutMs = 8000) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`${ROUTE}/${action}`, { ...init, signal: controller.signal })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error ?? `HTTP ${response.status}`)
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    function formatUptime(startedAt, now) {
      const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ${seconds % 60}s`
      const hours = Math.floor(minutes / 60)
      return `${hours}h ${minutes % 60}m`
    }

    function fileName(path) {
      return String(path ?? '').split(/[\\/]/).pop() || '—'
    }

    function useEngine(t) {
      const text = react.useRef(t)
      text.current = t

      const [snapshot, setSnapshot] = react.useState({
        phase: 'loading',
        running: false,
        ready: false,
        managed: false,
        port: 8095,
        model: '',
        modelPath: '',
        engine: '',
        log: '',
        pid: null,
        startedAt: null,
        lastError: '',
      })
      const [busy, setBusy] = react.useState(undefined)
      const [error, setError] = react.useState('')
      const [statusError, setStatusError] = react.useState('')
      const [log, setLog] = react.useState([])
      const [now, setNow] = react.useState(Date.now())
      const mounted = react.useRef(true)

      react.useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
        }
      }, [])

      const readLog = react.useCallback(async () => {
        try {
          const payload = await api('log?lines=80', {}, 6000)
          if (mounted.current) setLog(Array.isArray(payload.lines) ? payload.lines : [])
        } catch (failure) {
          if (mounted.current) {
            setLog([`${text.current('logFailed')}：${failure?.message ?? String(failure)}`])
          }
        }
      }, [])

      const refresh = react.useCallback(async () => {
        try {
          const payload = await api('status', {}, 8000)
          if (!mounted.current) return
          setSnapshot((previous) => ({ ...previous, ...payload }))
          setStatusError('')
        } catch (failure) {
          if (!mounted.current) return
          setSnapshot((previous) => ({ ...previous, phase: 'unreachable' }))
          setStatusError(`${text.current('statusFailed')}：${failure?.message ?? String(failure)}`)
        }
      }, [])

      react.useEffect(() => {
        void refresh()
        const timer = setInterval(() => {
          void refresh()
        }, POLL_MS)
        return () => clearInterval(timer)
      }, [refresh])

      react.useEffect(() => {
        if (snapshot.startedAt === null) return
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [snapshot.startedAt])

      const run = react.useCallback(
        async (action) => {
          setBusy(action)
          setError('')
          try {
            const payload = await api(
              action,
              {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
              },
              action === 'load' ? 300000 : 90000,
            )
            if (!mounted.current) return
            setSnapshot((previous) => ({ ...previous, ...payload }))
            if (payload.lastError) setError(payload.lastError)
          } catch (failure) {
            if (mounted.current) {
              const label = action === 'load' ? text.current('loadFailed') : text.current('closeFailed')
              setError(`${label}：${failure?.message ?? String(failure)}`)
            }
            void readLog()
          } finally {
            if (mounted.current) setBusy(undefined)
            void refresh()
          }
        },
        [readLog, refresh],
      )

      return { snapshot, busy, error, statusError, log, now, refresh, readLog, run }
    }

    function LaciIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3.5, y: 4.5, width: 17, height: 6, rx: 2 }),
        h('rect', { x: 3.5, y: 13.5, width: 17, height: 6, rx: 2 }),
        h('path', { d: 'M7.5 7.5h.01M7.5 16.5h.01M11.5 7.5h4M11.5 16.5h4' }),
      )
    }

    function StatusDot({ state }) {
      return h('span', { className: 'laci-dot', 'data-state': state, 'aria-hidden': 'true' })
    }

    function LaciPanel({ t }) {
      const engine = useEngine(t)
      const [confirming, setConfirming] = react.useState(false)
      const snapshot = engine.snapshot

      const unavailable = snapshot.phase === 'unreachable'
      const running = snapshot.running === true
      const external = running && snapshot.ready === true && snapshot.managed !== true
      const state = unavailable ? 'error' : snapshot.phase === 'ready' ? 'ready' : snapshot.phase === 'starting' ? 'starting' : 'stopped'
      const label =
        engine.busy === 'load'
          ? t('loading')
          : engine.busy === 'close'
            ? t('closing')
            : running
              ? t('close')
              : t('load')
      const statusLabel = unavailable
        ? t('statusUnreachable')
        : state === 'ready'
          ? t('statusReady')
          : state === 'starting'
            ? t('statusStarting')
            : t('statusStopped')
      const hint = unavailable
        ? engine.statusError
        : external
          ? t('hintExternal')
          : state === 'ready'
            ? t('hintReady')
            : state === 'starting'
              ? t('hintStarting')
              : t('hintStopped')
      const message = engine.error || snapshot.lastError || engine.statusError

      return h(
        'section',
        { className: 'laci-page' },
        h(
          'div',
          { className: 'laci-shell' },
          h(
            'header',
            { className: 'laci-hero' },
            h('span', { className: 'laci-mark' }, h(LaciIcon, { size: 24 })),
            h(
              'div',
              { className: 'laci-hero-copy' },
              h('h1', null, t('title')),
              h('p', null, t('subtitle')),
            ),
          ),
          h(
            'div',
            { className: 'laci-card' },
            h(
              'div',
              { className: 'laci-status' },
              h(StatusDot, { state }),
              h(
                'div',
                { className: 'laci-status-copy' },
                h('strong', null, statusLabel),
                h('p', null, hint),
              ),
              h('span', { className: 'laci-endpoint' }, `127.0.0.1:${snapshot.port ?? 8095}`),
            ),
            h(
              'div',
              { className: 'laci-grid' },
              h(
                'div',
                null,
                h('span', { className: 'laci-key' }, t('model')),
                h('span', { className: 'laci-value', title: snapshot.modelPath || undefined }, snapshot.model || '—'),
              ),
              h(
                'div',
                null,
                h('span', { className: 'laci-key' }, t('process')),
                h(
                  'span',
                  { className: 'laci-value' },
                  snapshot.managed
                    ? `${t('managed')}${snapshot.pid === null ? '' : ` · PID ${snapshot.pid}`}`
                    : external
                      ? t('external')
                      : t('none'),
                ),
              ),
              h(
                'div',
                null,
                h('span', { className: 'laci-key' }, t('uptime')),
                h(
                  'span',
                  { className: 'laci-value' },
                  snapshot.startedAt === null ? t('none') : formatUptime(snapshot.startedAt, engine.now),
                ),
              ),
              h(
                'div',
                null,
                h('span', { className: 'laci-key' }, t('engine')),
                h('span', { className: 'laci-value', title: snapshot.engine || undefined }, fileName(snapshot.engine)),
              ),
            ),
            h(
              'div',
              { className: 'laci-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'laci-btn',
                  'data-variant': running ? 'danger' : 'primary',
                  disabled: engine.busy !== undefined || unavailable,
                  onClick: () => {
                    if (running) setConfirming(true)
                    else void engine.run('load')
                  },
                },
                engine.busy === 'load' || engine.busy === 'close' ? h('span', { className: 'laci-spinner' }) : null,
                label,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'laci-btn',
                  'data-variant': 'ghost',
                  disabled: engine.busy !== undefined,
                  onClick: () => {
                    void engine.refresh()
                  },
                },
                t('refresh'),
              ),
            ),
            message === '' ? null : h('p', { className: 'laci-error', role: 'alert' }, message),
            confirming
              ? h(
                  'div',
                  { className: 'laci-confirm', role: 'alertdialog' },
                  h('strong', null, t('confirmTitle')),
                  h('p', null, t('confirmBody')),
                  h(
                    'div',
                    { className: 'laci-actions' },
                    h(
                      'button',
                      { type: 'button', className: 'laci-btn', onClick: () => setConfirming(false) },
                      t('cancel'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'laci-btn',
                        'data-variant': 'danger',
                        onClick: () => {
                          setConfirming(false)
                          void engine.run('close')
                        },
                      },
                      t('confirm'),
                    ),
                  ),
                )
              : null,
          ),
          h(
            'details',
            {
              className: 'laci-log',
              onToggle: (event) => {
                if (event.currentTarget.open) void engine.readLog()
              },
            },
            h(
              'summary',
              null,
              h('span', null, t('log')),
              h('span', { className: 'laci-log-hint' }, t('logHint')),
            ),
            h('pre', null, engine.log.length === 0 ? t('logEmpty') : engine.log.join('\n')),
          ),
          h('p', { className: 'laci-footnote' }, t('footnote')),
        ),
      )
    }

    const EMBED_URL = '/laci/'

    // 面板不再自己画引擎控件：直接内嵌模型调度中心（D:\dshs\laci）。
    // 控制台是另一个进程，挂了就整块白 —— 所以先问宿主它在不在，
    // 不在就给一张能点的卡片（宿主能把它拉起来），别再给白板。
    function LaciEmbed() {
      const [nonce, setNonce] = react.useState(0)
      const [phase, setPhase] = react.useState('checking')
      const [detail, setDetail] = react.useState('')
      const [starting, setStarting] = react.useState(false)
      const alive = react.useRef(true)

      react.useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const probe = react.useCallback(async () => {
        try {
          const payload = await api('console', {}, 6000)
          if (!alive.current) return payload.ready === true
          setPhase(payload.ready ? 'up' : 'down')
          setDetail(payload.ready ? '' : '')
          return payload.ready === true
        } catch (failure) {
          const message = failure?.message ?? String(failure)
          if (!alive.current) return false
          // 老宿主没 /console 路由：别急着判死刑，让 iframe 自己试。
          if (/unknown route|HTTP 404/i.test(message)) {
            setPhase('up')
            setDetail('')
            return true
          }
          setPhase('down')
          setDetail(message)
          return false
        }
      }, [])

      const reload = react.useCallback(async () => {
        setPhase('checking')
        setDetail('')
        const ready = await probe()
        if (alive.current && ready) setNonce((n) => n + 1)
      }, [probe])

      const startConsole = react.useCallback(async () => {
        setStarting(true)
        setDetail('')
        try {
          const payload = await api(
            'console/start',
            { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
            40000,
          )
          if (!alive.current) return
          if (payload.ready === true) setPhase('up')
          else {
            setPhase('down')
            setDetail('控制台没起来')
          }
        } catch (failure) {
          if (!alive.current) return
          setPhase('down')
          setDetail(failure?.message ?? String(failure))
        } finally {
          if (alive.current) setStarting(false)
        }
      }, [])

      react.useEffect(() => {
        void probe()
      }, [probe])

      // 控制台晚一点起来也不用点：down 的时候每 5 秒再问一次。
      react.useEffect(() => {
        if (phase !== 'down') return undefined
        const timer = setInterval(() => {
          void probe()
        }, 5000)
        return () => clearInterval(timer)
      }, [phase, probe])

      react.useEffect(() => {
        const onMessage = (event) => {
          if (event?.data?.type === 'laci-ready') {
            setPhase('up')
            setDetail('')
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [])

      const body =
        phase === 'up'
          ? h('iframe', {
              key: nonce,
              className: 'laci-embed-frame',
              src: `${EMBED_URL}?embed=1&n=${nonce}`,
              title: 'LACI 模型调度中心',
            })
          : phase === 'checking'
            ? h(
                'div',
                { className: 'laci-embed-wait' },
                h('span', { className: 'laci-spinner' }),
                h('span', null, '正在连 /laci …'),
              )
            : h(
                'div',
                { className: 'laci-embed-card' },
                h('h2', null, '控制台没在跑'),
                h('p', null, 'LACI 没响应（/laci），所以这块是空的 —— 不是插件坏了。'),
                detail === '' ? null : h('p', { className: 'laci-embed-detail' }, detail),
                h(
                  'div',
                  { className: 'laci-embed-actions' },
                  h(
                    'button',
                    {
                      className: 'laci-embed-btn laci-embed-primary',
                      type: 'button',
                      disabled: starting,
                      onClick: () => {
                        void startConsole()
                      },
                    },
                    starting ? h('span', { className: 'laci-spinner' }) : null,
                    starting ? '正在启动…' : '启动控制台',
                  ),
                  h(
                    'button',
                    {
                      className: 'laci-embed-btn',
                      type: 'button',
                      onClick: () => {
                        void reload()
                      },
                    },
                    '重试',
                  ),
                  h('a', { className: 'laci-embed-btn', href: EMBED_URL, target: '_blank', rel: 'noreferrer' }, '在浏览器里打开'),
                ),
                h(
                  'p',
                  { className: 'laci-embed-tip' },
                  '还起不来就双击 D:\\dshs\\laci\\start-silent.vbs，或者看 logs\\console.out.log。',
                ),
              )

      return h(
        'section',
        { className: 'laci-embed' },
        h(
          'div',
          { className: 'laci-embed-bar' },
          h('span', { className: 'laci-embed-title' }, 'LACI 模型调度中心'),
          h('span', { className: 'laci-embed-url' }, '/laci'),
          h('span', { className: 'laci-embed-gap' }),
          h(
            'button',
            {
              className: 'laci-embed-btn',
              type: 'button',
              onClick: () => {
                void reload()
              },
            },
            '刷新',
          ),
          h(
            'a',
            { className: 'laci-embed-btn', href: EMBED_URL, target: '_blank', rel: 'noreferrer' },
            '新窗口打开',
          ),
        ),
        body,
      )
    }

    const CSS = `
.laci-page{box-sizing:border-box;min-height:100%;overflow:auto;padding:28px 32px 48px;padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55}
.laci-shell{display:flex;flex-direction:column;gap:18px;width:100%;max-width:780px;margin:0 auto}
.laci-hero{display:flex;align-items:flex-start;gap:14px}
.laci-mark{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:14px;background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.12));color:var(--dsw-alias-brand-primary,currentColor)}
.laci-hero-copy{min-width:0}
.laci-hero-copy h1{margin:0;font-size:22px;line-height:1.3;font-weight:600;letter-spacing:-.01em}
.laci-hero-copy p{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55}
.laci-card{display:flex;flex-direction:column;gap:16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,rgba(127,127,127,.2)));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1,transparent));border-radius:var(--dsw-radius-xl,16px);padding:18px 20px}
.laci-status{display:flex;align-items:flex-start;gap:10px}
.laci-status-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.laci-status-copy strong{font-size:15px;font-weight:600}
.laci-status-copy p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}
.laci-endpoint{flex:none;max-width:100%;font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:999px;padding:3px 8px;white-space:nowrap}
.laci-dot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-label-tertiary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-tertiary) 18%,transparent)}
.laci-dot[data-state="ready"]{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 18%,transparent)}
.laci-dot[data-state="starting"]{background:var(--dsw-alias-state-warning-primary,#f59e0b);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f59e0b) 18%,transparent);animation:laci-pulse 1.4s ease-in-out infinite}
.laci-dot[data-state="error"]{background:var(--dsw-alias-state-error-primary,#ef4444);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 18%,transparent)}
.laci-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.16));padding-top:14px}
.laci-grid>div{display:flex;flex-direction:column;gap:2px;min-width:0}
.laci-key{font-size:11px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}
.laci-value{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.laci-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.laci-btn{box-sizing:border-box;height:32px;display:inline-flex;align-items:center;justify-content:center;gap:7px;border-radius:var(--dsw-radius-sm,8px);border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:0 0;color:inherit;font:inherit;font-size:13px;line-height:1;padding:0 14px;cursor:pointer}
.laci-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.laci-btn:disabled{opacity:.45;cursor:default}
.laci-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill,#f9fafb);color:var(--dsw-alias-label-primary-foreground,#0f1115);border-color:transparent}
.laci-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.laci-btn[data-variant="ghost"]{color:var(--dsw-alias-label-secondary)}
.laci-spinner{width:12px;height:12px;border-radius:50%;border:1.5px solid currentColor;border-right-color:transparent;animation:laci-spin .8s linear infinite}
.laci-confirm{display:flex;flex-direction:column;gap:8px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,transparent);border-radius:var(--dsw-radius-md,10px);padding:12px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 6%,transparent)}
.laci-confirm strong{font-size:13px;font-weight:600}
.laci-confirm p{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.laci-error{margin:0;color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.laci-log{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.2));border-radius:var(--dsw-radius-md,10px);padding:10px 14px}
.laci-log summary{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);list-style:none}
.laci-log summary::-webkit-details-marker{display:none}
.laci-log summary::before{content:"▸";display:inline-block;margin-right:6px;color:var(--dsw-alias-label-tertiary);transition:transform .12s ease}
.laci-log[open] summary::before{transform:rotate(90deg)}
.laci-log-hint{color:var(--dsw-alias-label-tertiary);font-size:11px}
.laci-log pre{max-height:220px;overflow:auto;margin:10px 0 0;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.laci-footnote{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}
.laci-embed{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;height:calc(100vh - 64px);min-height:420px;padding:12px 16px 14px;padding-top:calc(12px + var(--dsh-frame-top-clearance,0px));color:var(--dsw-alias-label-primary)}
.laci-embed-bar{display:flex;align-items:center;gap:10px;font-size:12px}
.laci-embed-title{font-size:13px;font-weight:600}
.laci-embed-url{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace)}
.laci-embed-gap{flex:1}
.laci-embed-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px 10px;font:inherit;font-size:12px;line-height:1.4;cursor:pointer;text-decoration:none}
.laci-embed-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.laci-embed-frame{flex:1;width:100%;min-height:360px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:14px;background:transparent}
.laci-embed-card,.laci-embed-wait{flex:1;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:10px;min-height:360px;padding:24px 30px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:14px}
.laci-embed-wait{align-items:center;flex-direction:row;gap:10px;color:var(--dsw-alias-label-secondary);font-size:13px}
.laci-embed-card h2{margin:0;font-size:16px;font-weight:600}
.laci-embed-card p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.laci-embed-detail{font-family:var(--dsw-font-family-mono,ui-monospace,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.laci-embed-actions{display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
.laci-embed-primary{background:var(--dsw-alias-button-primary-fill,#f9fafb);color:var(--dsw-alias-label-primary-foreground,#0f1115);border-color:transparent;display:inline-flex;align-items:center;gap:7px}
.laci-embed-primary:disabled{opacity:.6;cursor:default}
.laci-embed-tip{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}
.laci-embed-card a{color:var(--dsw-alias-brand-primary,#4cc2ff);text-decoration:none}
@keyframes laci-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes laci-spin{to{transform:rotate(360deg)}}
@media (max-width:640px){.laci-page{padding:20px 16px 40px}.laci-grid{grid-template-columns:minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.laci-dot,.laci-spinner{animation:none}}
`

    const TAG = 'dsh-laci-engine/panel.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG)}]`) === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-laci-engine'
      tag.dataset.pluginCss = TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-laci-engine: dictionaries')

      // The page opened by the sidebar row. `key` is the id shared with
      // `sidebar.panellist`; the layout's root `main` slot dispatches by it.
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          LaciEmbed,
        ),
      )

      // The left sidebar entry itself.
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 10,
            label: () => t('panel'),
            locale: NS,
          },
          LaciIcon,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
