// 宿主 HTTP 路由用的小工具：回 JSON、读 JSON 请求体。
// 全部 try/catch —— 插件任何环节出错都不能把 DSH 弄崩。

/** 读请求体的上限：面板请求都很小，64KB 足够。 */
const 默认上限 = 64 * 1024

/** 回一个 JSON 响应；res 已经结束/不可写时静默。 */
export function 回JSON(res, 状态码, 数据) {
  try {
    if (!res || typeof res.end !== 'function') return false
    let 文本
    try {
      文本 = JSON.stringify(数据 ?? { ok: false })
    } catch {
      文本 = '{"ok":false,"error":"响应序列化失败"}'
      状态码 = 500
    }
    res.statusCode = 状态码
    try {
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
    } catch {
      /* 假 res（测试）可能没有 setHeader */
    }
    res.end(文本)
    return true
  } catch {
    return false
  }
}

/**
 * 读并解析 JSON 请求体。
 * 返回 { ok:true, value } 或 { ok:false, code }，永远不 reject。
 */
export function 读请求体(req, 上限 = 默认上限) {
  return new Promise((resolve) => {
    let 已结束 = false
    const 收尾 = (结果) => {
      if (已结束) return
      已结束 = true
      resolve(结果)
    }
    try {
      if (!req || typeof req.on !== 'function') {
        收尾({ ok: true, value: {} })
        return
      }
      let 长度 = 0
      const 块 = []
      req.on('data', (片) => {
        if (已结束) return
        try {
          const 字节 = 片?.length ?? 0
          长度 += 字节
          if (长度 > 上限) {
            收尾({ ok: false, code: 'too_large' })
            try {
              req.destroy?.()
            } catch {
              /* 忽略 */
            }
            return
          }
          块.push(片)
        } catch (错误) {
          收尾({ ok: false, code: 'read_error', error: String(错误?.message || 错误) })
        }
      })
      req.on('end', () => {
        if (已结束) return
        try {
          const 文本 = Buffer.concat(块.map((b) => Buffer.from(b))).toString('utf8').trim()
          if (!文本) {
            收尾({ ok: true, value: {} })
            return
          }
          收尾({ ok: true, value: JSON.parse(文本) })
        } catch {
          收尾({ ok: false, code: 'bad_json' })
        }
      })
      req.on('error', (错误) => {
        收尾({ ok: false, code: 'read_error', error: String(错误?.message || 错误) })
      })
    } catch (错误) {
      收尾({ ok: false, code: 'read_error', error: String(错误?.message || 错误) })
    }
  })
}

/** 读一个请求头（大小写不敏感）；没有该头返回 undefined。 */
function headerValue(req, name) {
  const headers = req?.headers
  if (!headers || typeof headers !== 'object') return undefined
  const 目标 = String(name).toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== 目标) continue
    const value = headers[key]
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : ''
    return value == null ? '' : String(value)
  }
  return undefined
}

/** 解析 Host 头；IPv6 用方括号，端口可省略。 */
function parseHostHeader(value) {
  const 文本 = String(value || '').trim()
  if (!文本) return null
  if (文本.startsWith('[')) {
    const 结束 = 文本.indexOf(']')
    if (结束 < 0) return null
    const hostname = 文本.slice(1, 结束).toLowerCase()
    const 剩余 = 文本.slice(结束 + 1)
    if (剩余 === '') return { hostname, port: null }
    if (!剩余.startsWith(':')) return null
    const port = Number(剩余.slice(1))
    return Number.isInteger(port) ? { hostname, port } : null
  }
  const 冒号 = 文本.lastIndexOf(':')
  if (冒号 >= 0) {
    const 尾 = 文本.slice(冒号 + 1)
    if (/^\d{1,5}$/.test(尾)) return { hostname: 文本.slice(0, 冒号).toLowerCase(), port: Number(尾) }
  }
  return { hostname: 文本.toLowerCase(), port: null }
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
  const 主 = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const 客 = String(host.hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (主 !== 客) return false
  const 主端口 = url.port ? Number(url.port) : defaultPort(url.protocol)
  // Host 头没写端口时按「同协议的默认端口」推导；DSH Web 端口每次都变，
  // 所以绝不能写死端口，只能从请求头自身推。
  const 客端口 = host.port == null ? defaultPort(url.protocol) : host.port
  return 主端口 === 客端口
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
  const 结果 = checkRequestOrigin(req)
  if (结果.ok) return true
  回JSON(res, 403, {
    ok: false,
    code: 'forbidden_origin',
    error: `拒绝跨站请求（${结果.reason}）`,
    hint: '重启面板只接受同源请求；请从 DSH 界面操作。',
  })
  return false
}

/** 只允许指定 HTTP 方法；返回 true 表示可以继续。 */
export function 方法允许(req, res, 允许的方法) {
  const 方法 = String(req?.method || '').toUpperCase()
  const 允许 = (允许的方法 || []).map((m) => String(m).toUpperCase())
  if (允许.includes(方法)) return true
  try {
    res?.setHeader?.('allow', 允许.join(', '))
  } catch {
    /* 忽略 */
  }
  回JSON(res, 405, { ok: false, code: 'method_not_allowed', 允许: 允许 })
  return false
}
