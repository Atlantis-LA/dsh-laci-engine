/**
 * M6 · `?embed=1` 的服务端精简
 * ============================================================================
 * 单独一个文件，只干一件事：把整页 HTML 变成"已声明内嵌"的页面。
 *
 * 为什么放服务端（而不是只靠前端加 class）：
 *   DSH 插件用 iframe 嵌 3101，外层导航、留白、滚动条都应该在**首字节**就是对的。
 *   靠前端脚本跑起来再隐藏，会先闪一下整页，而且脚本一失败就退回原样。
 *
 * 只做两处最小变换，不重写 HTML、不引模板引擎：
 *   1. `<body>` 加 `embed` 类（CSS 里 body.embed footer{display:none} 等规则生效）
 *   2. 注入 `window.__LACI_EMBED__ = true`（前端据此隐藏"接入 DSH"等入口）
 *
 * 这样 UI 怎么改都不用动这里 —— 页面结构变了也不会被解析器吃掉。
 */

const FLAG_SCRIPT = '<script>window.__LACI_EMBED__ = true;</script>'

/** class 属性合并：已经有 embed 就不再加一次（幂等） */
function withEmbedClass(className) {
  const list = String(className || '').split(/\s+/).filter(Boolean)
  if (!list.includes('embed')) list.push('embed')
  return list.join(' ')
}

/**
 * @param {string} html 原始 index.html
 * @returns {string} 内嵌版
 */
export function embedPage(html) {
  let out = String(html ?? '')

  out = out.replace(/<body(\s[^>]*)?>/i, (whole, attrs = '') => {
    const a = String(attrs || '')
    if (/class\s*=/i.test(a)) {
      const next = a
        .replace(/class\s*=\s*"([^"]*)"/i, (m, cls) => `class="${withEmbedClass(cls)}"`)
        .replace(/class\s*=\s*'([^']*)'/i, (m, cls) => `class="${withEmbedClass(cls)}"`)
      return `<body${next}>`
    }
    return `<body${a} class="embed">`
  })

  if (!out.includes('__LACI_EMBED__')) {
    out = out.includes('</head>')
      ? out.replace('</head>', `  ${FLAG_SCRIPT}\n</head>`)
      : `${FLAG_SCRIPT}\n${out}`
  }

  return out
}

export default { embedPage }
