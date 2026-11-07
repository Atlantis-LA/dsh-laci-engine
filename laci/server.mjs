/**
 * LACI 新调度中心 · 入口
 *
 * 起两个 HTTP 服务：
 *   - 3101 控制台（静态页面 + /api/*）
 *   - 8095 网关（OpenAI 兼容，DSH 指向这里）
 *
 * 注意：启动后是**空的**，不自动加载任何模型。导入由用户手动做。
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, dataDir } from './core/config.mjs'
import { getRuntimeManager } from './core/runtime.mjs'
import { startGateway } from './gateway/server.mjs'
import { createApi } from './control/api.mjs'
import { embedPage } from './control/embed.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

async function main() {
  const config = loadConfig()

  // 网关（8095）：起不来不致命，控制台还能用
  let gatewayError = null
  try {
    await startGateway({ config })
  } catch (err) {
    gatewayError = err.message
    console.error(`[laci] 网关没起来：${gatewayError}`)
  }

  const api = createApi(config)

  // 顺序很重要（M3 提醒）：
  //   1. 先清"导入向导里引擎还没保存"的孤儿 —— 那些挂不到引擎上，restore 清不了
  //   2. 再认回已保存的实例
  //   3. 最后起对账
  try {
    const { cleanupEphemeral } = await import('./control/import.mjs')
    const purgedByImport = await cleanupEphemeral().catch(() => [])
    if (Array.isArray(purgedByImport) && purgedByImport.length > 0) {
      console.log(`[laci] 清掉 ${purgedByImport.length} 个导入向导遗留的临时进程`)
    }

    const manager = await getRuntimeManager()
    const restored = await manager.restore?.()
    manager.startReconciler?.()

    const purged = await manager.purgeEphemeral?.()
    if (Array.isArray(purged) && purged.length > 0) {
      console.log(`[laci] 清掉 ${purged.length} 个上次没关掉的试启动实例`)
    }
    if (Array.isArray(restored) && restored.length > 0) {
      console.log(`[laci] 认回 ${restored.length} 个实例`)
    }
  } catch (err) {
    console.warn(`[laci] 恢复实例失败：${err.message}`)
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${config.host}:${config.consolePort}`)

    // 控制面 API
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(req, res, url)
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: err?.message ?? String(err) }))
        }
        return
      }
    }

    // 静态文件
    let rel = url.pathname === '/' ? '/index.html' : url.pathname
    if (rel.includes('..')) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('bad path')
    }
    const embed = url.searchParams.get('embed') === '1'
    const file = join(ROOT, 'ui', normalize(rel))
    try {
      const buf = await readFile(file)
      const isHtml = extname(file) === '.html'
      const body = isHtml && embed ? embedPage(buf.toString('utf8')) : buf
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
      })
      return res.end(body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
  })

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[laci] 端口 ${config.consolePort} 被占用——先把旧的关掉`)
    } else {
      console.error(`[laci] 控制台起不来：${err.message}`)
    }
    process.exit(1)
  })

  server.listen(config.consolePort, config.host, () => {
    console.log('')
    console.log('  LACI 模型调度中心')
    console.log(`  控制台   http://${config.host}:${config.consolePort}`)
    console.log(`  网关     http://${config.host}:${config.gatewayPort}/v1 ${gatewayError ? '⚠ ' + gatewayError : ''}`)
    console.log(`  数据     ${dataDir()}`)
    console.log('')
  })

  // 退出时把本进程拉起的引擎一起收掉（防止孤儿占显存）
  const shutdown = async () => {
    try {
      const { stopAllInstances } = await import('./core/runtime.mjs')
      await stopAllInstances?.()
    } catch { /* 运行时可能还没写出来 */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[laci] 启动失败：', err)
  process.exit(1)
})
