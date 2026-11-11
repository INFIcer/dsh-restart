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
