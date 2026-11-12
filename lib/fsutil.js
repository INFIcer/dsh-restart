// 文件小工具：只用 node:fs / node:path，没有任何第三方依赖。
// 状态文件要求原子写：先写 .tmp 再 rename，避免 DSH 被杀时留下半截 JSON。

import fs from 'node:fs'
import path from 'node:path'

/** 递归建目录；失败不抛，返回是否成功。 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** 读 JSON；文件不存在 / 空 / 坏 JSON / 读失败都返回兜底值，绝不抛。 */
export function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    if (!text.trim()) return fallback
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * 原子写 JSON：写 `${file}.${pid}.${Date.now()}.tmp`，再 rename 覆盖。
 * rename 失败时退回直接写（至少别把状态丢掉）。
 */
export function writeJsonAtomic(file, value) {
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2)
    } catch (error) {
      return null
    }
  })()
  if (text == null) return { ok: false, error: 'JSON 序列化失败' }
  try {
    ensureDir(path.dirname(file))
  } catch {
    /* 忽略 */
  }
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmpFile, text, 'utf8')
    fs.renameSync(tmpFile, file)
    return { ok: true, filePath: file, byteCount: Buffer.byteLength(text, 'utf8') }
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* 临时文件可能没建出来 */
    }
    try {
      fs.writeFileSync(file, text, 'utf8')
      return { ok: true, filePath: file, fallbackWrite: true, byteCount: Buffer.byteLength(text, 'utf8') }
    } catch (error2) {
      return { ok: false, error: String(error2?.message || error2) }
    }
  }
}

/** 写文本；bom=true 时加 UTF-8 BOM（PowerShell 5.1 读中文脚本必须）。 */
export function writeText(file, text, options = {}) {
  const bom = options.bom === true
  const content = bom ? `\uFEFF${String(text ?? '')}` : String(text ?? '')
  try {
    ensureDir(path.dirname(file))
  } catch {
    /* 忽略 */
  }
  try {
    fs.writeFileSync(file, content, 'utf8')
    return { ok: true, filePath: file, byteCount: Buffer.byteLength(content, 'utf8'), bom }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** 追加一行日志；失败静默（日志不能反过来把插件弄崩）。 */
export function appendLog(file, text) {
  try {
    ensureDir(path.dirname(file))
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(text ?? '')}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 删文件；失败静默。 */
export function removeFile(file) {
  try {
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/** 文件是否存在。 */
export function exists(file) {
  try {
    return fs.existsSync(file)
  } catch {
    return false
  }
}
