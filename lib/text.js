// 文本规范化：只处理跨模块共用的硬规则（长度上限、空值回落）。
import { 默认唤醒文本, wakeTextMaxLength } from './constants.js'

/**
 * 规范化唤醒文本：去首尾空白，空值回落到默认文本，超长截断。
 * 截断放在写入 schedule.json 之前，保证落盘和注入的文本都不会超限。
 */
export function normalizeWakeText(value) {
  const 文本 = String(value ?? '').trim()
  if (!文本) return 默认唤醒文本
  return 文本.length > wakeTextMaxLength ? 文本.slice(0, wakeTextMaxLength) : 文本
}
