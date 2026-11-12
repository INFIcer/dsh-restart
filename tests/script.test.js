// 重启脚本生成测试：只检查文本内容与 BOM，绝不执行脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  生成唤醒事件,
  生成重启脚本文本,
  写入重启脚本,
  PS字符串,
  解析家目录,
  解析EXE路径,
  解析脚本路径,
  插件根,
} from '../lib/script.js'
import { 默认唤醒文本, 唤醒延迟秒 } from '../lib/constants.js'

function 临时目录(t) {
  const 目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-script-'))
  t.after(() => {
    try { fs.rmSync(目录, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
  return 目录
}

test('生成唤醒事件：按会话去重', () => {
  const 事件 = 生成唤醒事件([
    { sessionId: 's1', wakeText: '甲' },
    { sessionId: 's1', wakeText: '乙' },
    { sessionId: 's2', wakeText: '丙' },
  ])
  assert.equal(事件.length, 2)
  assert.deepEqual(事件.map((项) => 项.sessionId), ['s1', 's2'])
  assert.equal(事件[0].prompt, '甲')
})

test('生成唤醒事件：没写唤醒文本用默认文本', () => {
  const [事件] = 生成唤醒事件([{ sessionId: 's1' }])
  assert.equal(事件.prompt, 默认唤醒文本)
  assert.equal(事件.afterSeconds, 唤醒延迟秒)
  assert.equal(事件.title, '重启完成唤醒')
})

test('生成唤醒事件：丢掉没有会话 id 的项', () => {
  assert.deepEqual(生成唤醒事件([{ wakeText: 'x' }, null, {}]), [])
})

test('生成唤醒事件：坏的 afterSeconds 回落到默认值', () => {
  const [事件] = 生成唤醒事件([{ sessionId: 's1', afterSeconds: -5 }])
  assert.equal(事件.afterSeconds, 唤醒延迟秒)
})

test('PS字符串：单引号翻倍', () => {
  assert.equal(PS字符串("a'b"), `'a''b'`)
  assert.equal(PS字符串(null), `''`)
})

test('解析家目录：环境变量优先', () => {
  assert.equal(解析家目录({ DSH_HOME: 'D:\\自定义' }), 'D:\\自定义')
  assert.match(解析家目录({}), /[\\/]\.dsh$/)
})

test('解析EXE路径：环境变量优先', () => {
  assert.equal(解析EXE路径({ DSH_RESTART_EXE: 'X:\\a b\\DSH.exe' }), 'X:\\a b\\DSH.exe')
})

test('解析脚本路径：默认落在插件目录与家目录', () => {
  const 路径 = 解析脚本路径({ DSH_HOME: 'C:\\Users\\x\\.dsh' })
  assert.equal(路径.家目录, 'C:\\Users\\x\\.dsh')
  assert.equal(path.dirname(路径.脚本文件), 插件根)
  assert.match(路径.标记文件, /restart-scheduler-marker\.json$/)
})

test('解析脚本路径：三个路径都能用环境变量覆盖', () => {
  const 路径 = 解析脚本路径({
    DSH_HOME: 'C:\\h',
    DSH_RESTART_SCRIPT: 'E:\\s.ps1',
    DSH_RESTART_LOG: 'E:\\l.log',
    DSH_RESTART_MARKER: 'E:\\m.json',
  })
  assert.equal(路径.脚本文件, 'E:\\s.ps1')
  assert.equal(路径.日志文件, 'E:\\l.log')
  assert.equal(路径.标记文件, 'E:\\m.json')
})

test('脚本文本：包含杀进程、清 cookie、写唤醒事件、WMI 拉起、TCP 探测', () => {
  const 文本 = 生成重启脚本文本({
    家目录: 'C:\\Users\\x\\.dsh',
    exe路径: 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe',
    日志文件: 'E:\\r.log',
    标记文件: 'C:\\Users\\x\\.dsh\\restart-scheduler-marker.json',
    唤醒事件: [{ sessionId: 'session-a', wakeText: '好了', afterSeconds: 15 }],
  })
  assert.match(文本, /Get-Process -Name 'DeepSeek Harness'/)
  assert.match(文本, /Stop-Process -Force/)
  assert.match(文本, /purge-dsh-auth-cookies\.ps1/)
  assert.match(文本, /storages\\schedule\.json/)
  assert.match(文本, /Invoke-CimMethod -ClassName Win32_Process -MethodName Create/)
  assert.match(文本, /TcpClient/)
  assert.match(文本, /schtasks\.exe \/Delete/)
  // 注释里会提醒"不能用 Start-Process"，这里断言的是没有任何一行真的调用它。
  assert.doesNotMatch(文本, /^\s*Start-Process/mi)
})

test('脚本文本：唤醒事件不由脚本做 JSON 往返覆盖', () => {
  const 文本 = 生成重启脚本文本({
    家目录: 'C:\\h',
    唤醒事件: [{ sessionId: 'session-a', wakeText: '继续', afterSeconds: 15 }],
  })
  assert.doesNotMatch(文本, /WriteAllText\(\$scheduleFile/)
  assert.doesNotMatch(文本, /\$doc\.tables\.tasks/)
  assert.doesNotMatch(文本, /Add-Member/)
  // 脚本只做「原文件未被宿主改写时，用 .pending 原子替换」。
  assert.match(文本, /\.pending/)
  assert.match(文本, /\.base/)
  assert.match(文本, /Move-Item -Force -LiteralPath \$pendingFile/)
})

test('脚本文本：先记录旧 PID，旧实例全死且只探新 PID 端口才算就绪', () => {
  const 文本 = 生成重启脚本文本({ 家目录: 'C:\\h' })
  assert.match(文本, /oldPids/)
  assert.match(文本, /stop-failed/)
  assert.match(文本, /\$result\.ProcessId/)
  assert.match(文本, /Get-Process -Id \$dshPid/)
  assert.match(文本, /-OwningProcess \$dshPid/)
  // 成功判定不能再按进程名取第一个。
  assert.doesNotMatch(文本, /Get-Process -Name 'DeepSeek Harness'[^\n]*-First 1/)
})

test('脚本文本：路径里的单引号被安全转义', () => {
  const 文本 = 生成重启脚本文本({ 家目录: "C:\\it's\\.dsh" })
  assert.match(文本, /\$dshHome = 'C:\\it''s\\\.dsh'/)
})

test('写入重启脚本：文件带 UTF-8 BOM 且内容完整', (t) => {
  const 目录 = 临时目录(t)
  const 文件 = path.join(目录, 'restart.ps1')
  const 结果 = 写入重启脚本({
    脚本文件: 文件,
    家目录: 'C:\\h',
    唤醒事件: [{ sessionId: 's1', wakeText: '好' }],
  })
  assert.equal(结果.ok, true)
  assert.equal(结果.事件数, 1)
  const 字节 = fs.readFileSync(文件)
  assert.deepEqual([...字节.slice(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(字节.toString('utf8'), /restart script begin/)
})
