// 重启脚本生成测试：只检查文本内容与 BOM，绝不执行脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildWakeEvents,
  buildRestartScript,
  writeRestartScript,
  psQuote,
  resolveHome,
  resolveExePath,
  resolveScriptPaths,
  pluginRoot,
} from '../lib/script.js'
import { defaultWakeText, wakeDelaySeconds } from '../lib/constants.js'

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-script-'))
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return dir
}

test('生成唤醒事件：按会话去重', () => {
  const event = buildWakeEvents([
    { sessionId: 's1', wakeText: '甲' },
    { sessionId: 's1', wakeText: '乙' },
    { sessionId: 's2', wakeText: '丙' },
  ])
  assert.equal(event.length, 2)
  assert.deepEqual(event.map((item) => item.sessionId), ['s1', 's2'])
  assert.equal(event[0].prompt, '甲')
})

test('生成唤醒事件：没写唤醒文本用默认文本', () => {
  const [event] = buildWakeEvents([{ sessionId: 's1' }])
  assert.equal(event.prompt, defaultWakeText)
  assert.equal(event.afterSeconds, wakeDelaySeconds)
  assert.equal(event.title, '重启完成唤醒')
})

test('生成唤醒事件：丢掉没有会话 id 的项', () => {
  assert.deepEqual(buildWakeEvents([{ wakeText: 'x' }, null, {}]), [])
})

test('生成唤醒事件：坏的 afterSeconds 回落到默认值', () => {
  const [event] = buildWakeEvents([{ sessionId: 's1', afterSeconds: -5 }])
  assert.equal(event.afterSeconds, wakeDelaySeconds)
})

test('PS字符串：单引号翻倍', () => {
  assert.equal(psQuote("a'b"), `'a''b'`)
  assert.equal(psQuote(null), `''`)
})

test('解析家目录：环境变量优先', () => {
  assert.equal(resolveHome({ DSH_HOME: 'D:\\自定义' }), 'D:\\自定义')
  assert.match(resolveHome({}), /[\\/]\.dsh$/)
})

test('解析EXE路径：环境变量优先', () => {
  assert.equal(resolveExePath({ DSH_RESTART_EXE: 'X:\\a b\\DSH.exe' }), 'X:\\a b\\DSH.exe')
})

test('解析脚本路径：默认落在插件目录与家目录', () => {
  const filePath = resolveScriptPaths({ DSH_HOME: 'C:\\Users\\x\\.dsh' })
  assert.equal(filePath.homeDir, 'C:\\Users\\x\\.dsh')
  assert.equal(path.dirname(filePath.scriptFile), pluginRoot)
  assert.match(filePath.markerFile, /restart-scheduler-marker\.json$/)
})

test('解析脚本路径：三个路径都能用环境变量覆盖', () => {
  const filePath = resolveScriptPaths({
    DSH_HOME: 'C:\\h',
    DSH_RESTART_SCRIPT: 'E:\\s.ps1',
    DSH_RESTART_LOG: 'E:\\l.log',
    DSH_RESTART_MARKER: 'E:\\m.json',
  })
  assert.equal(filePath.scriptFile, 'E:\\s.ps1')
  assert.equal(filePath.logFile, 'E:\\l.log')
  assert.equal(filePath.markerFile, 'E:\\m.json')
})

test('脚本文本：包含杀进程、清 cookie、写唤醒事件、WMI 拉起、TCP 探测', () => {
  const text = buildRestartScript({
    homeDir: 'C:\\Users\\x\\.dsh',
    exePath: 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    logFile: 'E:\\r.log',
    markerFile: 'C:\\Users\\x\\.dsh\\restart-scheduler-marker.json',
    wakeEvents: [{ sessionId: 'session-a', wakeText: '好了', afterSeconds: 15 }],
  })
  assert.match(text, /Get-Process -Name 'DeepSeek Harness'/)
  assert.match(text, /Stop-Process -Force/)
  assert.match(text, /purge-dsh-auth-cookies\.ps1/)
  assert.match(text, /storages\\schedule\.json/)
  assert.match(text, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.match(text, /TcpClient/)
  assert.match(text, /schtasks\.exe \/Delete/)
  // 注释里会提醒"不能用 Start-Process"，这里断言的是没有任何一行真的调用它。
  assert.doesNotMatch(text, /^\s*Start-Process/mi)
})

test('脚本文本：唤醒事件不由脚本做 JSON 往返覆盖', () => {
  const text = buildRestartScript({
    homeDir: 'C:\\h',
    wakeEvents: [{ sessionId: 'session-a', wakeText: '继续', afterSeconds: 15 }],
  })
  assert.doesNotMatch(text, /WriteAllText\(\$scheduleFile/)
  assert.doesNotMatch(text, /\$doc\.tables\.tasks/)
  assert.doesNotMatch(text, /Add-Member/)
  // 脚本只做「原文件未被宿主改写时，用 .pending 原子替换」。
  assert.match(text, /\.pending/)
  assert.match(text, /\.base/)
  assert.match(text, /Move-Item -Force -LiteralPath \$pendingFile/)
})

test('脚本文本：先记录旧 PID，旧实例全死且只探新 PID 端口才算就绪', () => {
  const text = buildRestartScript({ homeDir: 'C:\\h' })
  assert.match(text, /oldPids/)
  assert.match(text, /stop-failed/)
  assert.match(text, /\$result\.ProcessId/)
  assert.match(text, /Get-Process -Id \$dshPid/)
  assert.match(text, /-OwningProcess \$dshPid/)
  // 成功判定不能再按进程名取第一个。
  assert.doesNotMatch(text, /Get-Process -Name 'DeepSeek Harness'[^\n]*-First 1/)
})

test('脚本文本：路径里的单引号被安全转义', () => {
  const text = buildRestartScript({ homeDir: "C:\\it's\\.dsh" })
  assert.match(text, /\$dshHome = 'C:\\it''s\\\.dsh'/)
})

test('写入重启脚本：文件带 UTF-8 BOM 且内容完整', (t) => {
  const dir = tempDir(t)
  const file = path.join(dir, 'restart.ps1')
  const result = writeRestartScript({
    scriptFile: file,
    homeDir: 'C:\\h',
    wakeEvents: [{ sessionId: 's1', wakeText: '好' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.eventCount, 1)
  const bytes = fs.readFileSync(file)
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(bytes.toString('utf8'), /restart script begin/)
})
