// 唤醒文本规范化测试：只测跨模块共用的硬规则。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeWakeText } from '../lib/text.js'
import { 默认唤醒文本, wakeTextMaxLength } from '../lib/constants.js'

test('normalizeWakeText：空值回落到默认文本', () => {
  assert.equal(normalizeWakeText(''), 默认唤醒文本)
  assert.equal(normalizeWakeText('   '), 默认唤醒文本)
  assert.equal(normalizeWakeText(null), 默认唤醒文本)
  assert.equal(normalizeWakeText(undefined), 默认唤醒文本)
})

test('normalizeWakeText：去掉首尾空白，保留内部换行', () => {
  assert.equal(normalizeWakeText('  好了\n继续  '), '好了\n继续')
})

test('normalizeWakeText：超长截断到上限', () => {
  const 结果 = normalizeWakeText('x'.repeat(wakeTextMaxLength + 100))
  assert.equal(结果.length, wakeTextMaxLength)
})

test('normalizeWakeText：单引号与 here-string 终止符不改变长度规则', () => {
  const 原文 = "'@\n' + x".repeat(80)
  const 结果 = normalizeWakeText(原文)
  assert.ok(结果.length <= wakeTextMaxLength)
  assert.ok(结果.startsWith("'@"))
})
