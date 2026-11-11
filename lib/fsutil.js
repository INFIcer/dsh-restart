// 文件小工具：只用 node:fs / node:path，没有任何第三方依赖。
// 状态文件要求原子写：先写 .tmp 再 rename，避免 DSH 被杀时留下半截 JSON。

import fs from 'node:fs'
import path from 'node:path'

/** 递归建目录；失败不抛，返回是否成功。 */
export function 确保目录(目录) {
  try {
    fs.mkdirSync(目录, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 读 JSON；文件不存在 / 空 / 坏 JSON / 读失败都返回兜底值，绝不抛。 */
export function 读JSON(文件, 兜底 = null) {
  try {
    if (!fs.existsSync(文件)) return 兜底
    const 文本 = fs.readFileSync(文件, 'utf8').replace(/^\uFEFF/, '')
    if (!文本.trim()) return 兜底
    return JSON.parse(文本)
  } catch {
    return 兜底
  }
}

/**
 * 原子写 JSON：写 `<文件>.<pid>.<时间>.tmp`，再 rename 覆盖。
 * rename 失败时退回直接写（至少别把状态丢掉）。
 */
export function 写JSON原子(文件, 值) {
  const 文本 = (() => {
    try {
      return JSON.stringify(值, null, 2)
    } catch (错误) {
      return null
    }
  })()
  if (文本 == null) return { ok: false, 错误: 'JSON 序列化失败' }
  try {
    确保目录(path.dirname(文件))
  } catch {
    /* 忽略 */
  }
  const 临时 = `${文件}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(临时, 文本, 'utf8')
    fs.renameSync(临时, 文件)
    return { ok: true, 路径: 文件, 字节数: Buffer.byteLength(文本, 'utf8') }
  } catch (错误) {
    try {
      fs.unlinkSync(临时)
    } catch {
      /* 临时文件可能没建出来 */
    }
    try {
      fs.writeFileSync(文件, 文本, 'utf8')
      return { ok: true, 路径: 文件, 回退: true, 字节数: Buffer.byteLength(文本, 'utf8') }
    } catch (错误2) {
      return { ok: false, 错误: String(错误2?.message || 错误2) }
    }
  }
}

/** 写文本；bom=true 时加 UTF-8 BOM（PowerShell 5.1 读中文脚本必须）。 */
export function 写文本(文件, 文本, 选项 = {}) {
  const bom = 选项.bom === true
  const 内容 = bom ? `\uFEFF${String(文本 ?? '')}` : String(文本 ?? '')
  try {
    确保目录(path.dirname(文件))
  } catch {
    /* 忽略 */
  }
  try {
    fs.writeFileSync(文件, 内容, 'utf8')
    return { ok: true, 路径: 文件, 字节数: Buffer.byteLength(内容, 'utf8'), bom }
  } catch (错误) {
    return { ok: false, 错误: String(错误?.message || 错误) }
  }
}

/** 追加一行日志；失败静默（日志不能反过来把插件弄崩）。 */
export function 追加日志(文件, 文本) {
  try {
    确保目录(path.dirname(文件))
    fs.appendFileSync(文件, `[${new Date().toISOString()}] ${String(文本 ?? '')}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 删文件；失败静默。 */
export function 删文件(文件) {
  try {
    fs.unlinkSync(文件)
    return true
  } catch {
    return false
  }
}

/** 文件是否存在。 */
export function 存在(文件) {
  try {
    return fs.existsSync(文件)
  } catch {
    return false
  }
}
