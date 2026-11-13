// 文本规范化：只处理跨模块共用的硬规则（长度上限、空值）。
import { wakeTextMaxLength } from './constants.js'

/** 去掉首尾空白并按上限截断；空值保持为空，不造默认文案。 */
export function normalizeText(value, maxLength) {
  const text = String(value ?? '').trim()
  const limit = Number(maxLength)
  if (!Number.isFinite(limit) || limit <= 0) return text
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * 规范化重启意图文本：只限制长度与空白，空值保持为空。
 *
 * 这段文本只用于面板展示「为什么排这次重启」，不会进入唤醒消息；
 * 会话重启后本来就能看到前文，不需要插件再复述一遍。
 */
export function normalizeWakeText(value) {
  return normalizeText(value, wakeTextMaxLength)
}
