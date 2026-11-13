// 插件配置：开机自启动的期望值持久化在 DSH 家目录的 JSON 文件里。
//
// 读取优先级：配置文件 > 宿主传入的插件配置 > 默认值。DSH 设置页的 schemastery
// 字段可能以 volatile 引用（只有 get()、没有静态值）传进来，所以合并前先解包；
// 否则写进配置文件的会是 [object Object] 或整个引用。

import os from 'node:os'
import path from 'node:path'
import { configFileName } from './constants.js'
import { ensureDir, readJson, writeJsonAtomic } from './fsutil.js'

export const configVersion = 1

/** 配置默认值；每次返回新对象，避免调用方改到共享状态。 */
export function defaultConfig() {
  return { version: configVersion, autoStart: false }
}

/** 解析配置文件路径：DSH_HOME 优先，否则 ~/.dsh。 */
export function resolveConfigPath(env = process.env) {
  const home = String(env?.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, configFileName)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** schemastery 的 volatile 字段是 cosmokit 的冻结引用，值要通过 get() 取。 */
export function unwrapConfigValue(value) {
  if (!isPlainObject(value)) return value
  const writeSymbol = Symbol.for('cosmokit.volatile.write')
  if (typeof value.get === 'function' && writeSymbol in value) {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 只保留已知字段并做类型钳制：autoStart 必须是布尔 true 才算开启。 */
export function normalizeConfig(raw = {}) {
  const unwrapped = unwrapConfigValue(raw)
  const source = isPlainObject(unwrapped) ? unwrapped : {}
  return {
    version: configVersion,
    autoStart: unwrapConfigValue(source.autoStart) === true,
  }
}

/**
 * 配置读写器。load 不抛（坏文件按空配置处理），save 失败会抛，由调用方决定怎么提示。
 */
export class ConfigStore {
  constructor(options = {}) {
    const explicitFile = String(options.filePath || '').trim()
    const homeDir = String(options.homeDir || '').trim()
    this.filePath = explicitFile || path.join(homeDir || path.dirname(resolveConfigPath(options.env)), options.fileName || configFileName)
    this.current = defaultConfig()
  }

  /** 文件优先于宿主传入的配置；文件不存在或损坏时不影响插件加载。 */
  load(pluginConfig = {}) {
    let fileValue = null
    try {
      fileValue = readJson(this.filePath, null)
    } catch {
      fileValue = null
    }
    const fromFile = isPlainObject(fileValue) ? fileValue : {}
    const unwrappedPlugin = unwrapConfigValue(pluginConfig)
    const fromPlugin = isPlainObject(unwrappedPlugin) ? unwrappedPlugin : {}
    this.current = normalizeConfig({ ...fromPlugin, ...fromFile })
    return this.get()
  }

  /** 保存补丁并与当前值合并；返回保存后的完整配置。 */
  save(patch = {}) {
    const unwrappedPatch = unwrapConfigValue(patch)
    const fromPatch = isPlainObject(unwrappedPatch) ? unwrappedPatch : {}
    const next = normalizeConfig({ ...this.current, ...fromPatch })
    ensureDir(path.dirname(this.filePath))
    const result = writeJsonAtomic(this.filePath, next)
    if (!result?.ok) {
      const error = new Error(result?.error || '写配置文件失败')
      error.code = 'config_write_failed'
      throw error
    }
    this.current = next
    return this.get()
  }

  get() {
    return { ...this.current }
  }
}

/** schemastery 配置 schema；拿不到 schemastery 时宿主侧不导出 Config，插件照常加载。 */
export function buildConfigSchema(z) {
  return z
    .object({
      autoStart: z
        .boolean()
        .default(false)
        .description('登录 Windows 后自动启动 DSH')
        .extra('label', '开机自启动')
        .extra('volatile', true),
    })
    .description('dsh-restart-plugin 配置')
}
