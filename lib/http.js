// 宿主 HTTP 路由用的小工具：回 JSON、读 JSON 请求体。
// 全部 try/catch —— 插件任何环节出错都不能把 DSH 弄崩。

/** 读请求体的上限：面板请求都很小，64KB 足够。 */
const defaultLimit = 64 * 1024

/** 回一个 JSON 响应；res 已经结束/不可写时静默。 */
export function sendJson(res, statusCode, data) {
  try {
    if (!res || typeof res.end !== 'function') return false
    let text
    try {
      text = JSON.stringify(data ?? { ok: false })
    } catch {
      text = '{"ok":false,"error":"响应序列化失败"}'
      statusCode = 500
    }
    res.statusCode = statusCode
    try {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
    } catch {
      /* 假 res（测试）可能没有 setHeader */
    }
    res.end(text)
    return true
  } catch {
    return false
  }
}

/**
 * 读并解析 JSON 请求体。
 * 返回 { ok:true, value } 或 { ok:false, code }，永远不 reject。
 */
export function readRequestBody(req, limit = defaultLimit) {
  return new Promise((resolve) => {
    let ended = false
    const finish = (result) => {
      if (ended) return
      ended = true
      resolve(result)
    }
    try {
      if (!req || typeof req.on !== 'function') {
        finish({ ok: true, value: {} })
        return
      }
      let length = 0
      const chunk = []
      req.on('data', (piece) => {
        if (ended) return
        try {
          const bytes = piece?.length ?? 0
          length += bytes
          if (length > limit) {
            finish({ ok: false, code: 'too_large' })
            try {
              req.destroy?.()
            } catch {
              /* 忽略 */
            }
            return
          }
          chunk.push(piece)
        } catch (error) {
          finish({ ok: false, code: 'read_error', error: String(error?.message || error) })
        }
      })
      req.on('end', () => {
        if (ended) return
        try {
          const text = Buffer.concat(chunk.map((b) => Buffer.from(b))).toString('utf8').trim()
          if (!text) {
            finish({ ok: true, value: {} })
            return
          }
          finish({ ok: true, value: JSON.parse(text) })
        } catch {
          finish({ ok: false, code: 'bad_json' })
        }
      })
      req.on('error', (error) => {
        finish({ ok: false, code: 'read_error', error: String(error?.message || error) })
      })
    } catch (error) {
      finish({ ok: false, code: 'read_error', error: String(error?.message || error) })
    }
  })
}

/** 读一个请求头（大小写不敏感）；没有该头返回 undefined。 */
function headerValue(req, name) {
  const headers = req?.headers
  if (!headers || typeof headers !== 'object') return undefined
  const lowerName = String(name).toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== lowerName) continue
    const value = headers[key]
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : ''
    return value == null ? '' : String(value)
  }
  return undefined
}

/** 解析 Host 头；IPv6 用方括号，端口可省略。 */
function parseHostHeader(value) {
  const text = String(value || '').trim()
  if (!text) return null
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return null
    const hostname = text.slice(1, end).toLowerCase()
    const remaining = text.slice(end + 1)
    if (remaining === '') return { hostname, port: null }
    if (!remaining.startsWith(':')) return null
    const port = Number(remaining.slice(1))
    return Number.isInteger(port) ? { hostname, port } : null
  }
  const colonIndex = text.lastIndexOf(':')
  if (colonIndex >= 0) {
    const tail = text.slice(colonIndex + 1)
    if (/^\d{1,5}$/.test(tail)) return { hostname: text.slice(0, colonIndex).toLowerCase(), port: Number(tail) }
  }
  return { hostname: text.toLowerCase(), port: null }
}

function defaultPort(protocol) {
  if (protocol === 'https:') return 443
  if (protocol === 'http:') return 80
  return null
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url
  } catch {
    return null
  }
}

function sameHost(url, host) {
  if (!url || !host) return false
  const selfHost = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const peerHost = String(host.hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (selfHost !== peerHost) return false
  const selfPort = url.port ? Number(url.port) : defaultPort(url.protocol)
  // Host 头没写端口时按「同协议的默认端口」推导；DSH Web 端口每次都变，
  // 所以绝不能写死端口，只能从请求头自身推。
  const peerPort = host.port == null ? defaultPort(url.protocol) : host.port
  return selfPort === peerPort
}

/**
 * 判断请求是否来自同源页面。
 * 跨站请求必须拒绝；没有来源头的调用（工具、本机脚本）放行。
 * @returns {{ok:true,origin?:string,reason:string}|{ok:false,reason:string}}
 */
export function checkRequestOrigin(req) {
  const headers = req?.headers
  if (!headers || typeof headers !== 'object') return { ok: true, reason: 'no_headers' }
  const site = String(headerValue(req, 'sec-fetch-site') || '').trim().toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: `Sec-Fetch-Site=${site}` }
  }
  const origin = String(headerValue(req, 'origin') || '').trim()
  const referer = String(headerValue(req, 'referer') || '').trim()
  if (!origin && !referer) return { ok: true, reason: site ? 'fetch-metadata' : 'no-origin' }
  if (origin === 'null') return { ok: false, reason: 'origin=null' }
  const host = parseHostHeader(headerValue(req, 'host'))
  if (!host) return { ok: false, reason: '缺少可解析的 Host 头' }
  if (origin) {
    const url = parseHttpUrl(origin)
    if (!url || !sameHost(url, host)) return { ok: false, reason: `origin=${origin}` }
  }
  if (referer) {
    const url = parseHttpUrl(referer)
    if (!url || !sameHost(url, host)) return { ok: false, reason: `referer=${referer}` }
  }
  return { ok: true, origin: origin || referer, reason: 'same-origin' }
}

/** 同源校验；不通过直接回 403 并返回 false，调用方必须立刻 return，不能改任何状态。 */
export function requireSameOrigin(req, res) {
  const result = checkRequestOrigin(req)
  if (result.ok) return true
  sendJson(res, 403, {
    ok: false,
    code: 'forbidden_origin',
    error: `拒绝跨站请求（${result.reason}）`,
    hint: '重启面板只接受同源请求；请从 DSH 界面操作。',
  })
  return false
}

/** 只允许指定 HTTP 方法；返回 true 表示可以继续。 */
export function methodNotAllowed(req, res, allowedMethods) {
  const method = String(req?.method || '').toUpperCase()
  const allowed = (allowedMethods || []).map((m) => String(m).toUpperCase())
  if (allowed.includes(method)) return true
  try {
    res?.setHeader?.('allow', allowed.join(', '))
  } catch {
    /* 忽略 */
  }
  sendJson(res, 405, { ok: false, code: 'method_not_allowed', allowed: allowed })
  return false
}
