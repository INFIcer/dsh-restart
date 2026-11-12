// 生成并写入重启用的 PowerShell 脚本（UTF-8 BOM）。
//
// 脚本本身要能独立活下来：它是被 schtasks 一次性任务拉起的，不在 DSH 进程树里；
// 它负责：杀全部 DeepSeek Harness → 清 dsh-auth cookie → 往 schedule.json 写唤醒事件
// → WMI Win32_Process.Create 拉起 DSH（绝不能用 Start-Process）→ TCP 端口探测 → 写标记文件。

import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { 唤醒延迟秒, 计划任务名, 标记文件名 } from './constants.js'
import { 写文本 } from './fsutil.js'
import { normalizeWakeText } from './text.js'

const 此处 = path.dirname(fileURLToPath(import.meta.url))

/** 本插件根目录（lib 的上一级）。 */
export const 插件根 = path.resolve(此处, '..')

/** 默认 DSH 可执行文件路径（取不到当前进程路径时的兜底，和成熟脚本一致）。 */
export const 默认EXE路径 = 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

/** 取 DSH 家目录：优先环境变量，其次 ~/.dsh。 */
export function 解析家目录(环境 = process.env) {
  const 指定 = String(环境?.DSH_HOME || '').trim()
  if (指定) return 指定
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return 'C:\\Users\\Administrator\\.dsh'
  }
}

/** 取当前 DSH 可执行文件路径：Electron 主进程里 process.execPath 就是它。 */
export function 解析EXE路径(环境 = process.env) {
  const 指定 = String(环境?.DSH_RESTART_EXE || '').trim()
  if (指定) return 指定
  try {
    const 当前 = String(process.execPath || '')
    if (/DeepSeek Harness\.exe$/i.test(当前)) return 当前
  } catch {
    /* 忽略 */
  }
  return 默认EXE路径
}

/** 解析所有会被写进脚本的路径。测试可以整包替换。 */
export function 解析脚本路径(环境 = process.env) {
  const 家目录 = 解析家目录(环境)
  return {
    家目录,
    exe路径: 解析EXE路径(环境),
    脚本文件: String(环境?.DSH_RESTART_SCRIPT || '').trim() || path.join(插件根, 'restart.ps1'),
    日志文件: String(环境?.DSH_RESTART_LOG || '').trim() || path.join(插件根, 'restart.log'),
    标记文件: String(环境?.DSH_RESTART_MARKER || '').trim() || path.join(家目录, 标记文件名),
  }
}

/**
 * 把任务列表整理成 schedule.json 里的唤醒事件（同一会话只留一条，避免重复唤醒）。
 * @returns {Array<{sessionId:string, prompt:string, afterSeconds:number, title:string}>}
 */
export function 生成唤醒事件(任务列表 = []) {
  const 见过 = new Set()
  const 事件 = []
  for (const 任务 of Array.isArray(任务列表) ? 任务列表 : []) {
    if (!任务 || typeof 任务 !== 'object') continue
    const 会话 = String(任务.sessionId || '').trim()
    if (!会话 || 见过.has(会话)) continue
    见过.add(会话)
    const 秒 = Number(任务.afterSeconds)
    事件.push({
      sessionId: 会话,
      prompt: normalizeWakeText(任务.wakeText),
      afterSeconds: Number.isFinite(秒) && 秒 > 0 ? Math.round(秒) : 唤醒延迟秒,
      title: '重启完成唤醒',
    })
  }
  return 事件
}

/** PowerShell 单引号字符串转义：内部单引号写两遍。 */
export function PS字符串(值) {
  return `'${String(值 ?? '').replace(/'/g, "''")}'`
}

/**
 * 生成重启脚本全文。
 * @param {object} 选项
 * @param {Array} 选项.唤醒事件
 * @param {string} 选项.家目录
 * @param {string} 选项.exe路径
 * @param {string} 选项.日志文件
 * @param {string} 选项.标记文件
 * @param {string} [选项.任务名]
 * @param {string} [选项.生成时间]
 */
export function 生成重启脚本文本(选项 = {}) {
  const 家目录 = 选项.家目录 || 解析家目录()
  const exe路径 = 选项.exe路径 || 解析EXE路径()
  const 日志文件 = 选项.日志文件 || path.join(插件根, 'restart.log')
  const 标记文件 = 选项.标记文件 || path.join(家目录, 标记文件名)
  const 任务名 = 选项.任务名 || 计划任务名
  const 生成时间 = 选项.生成时间 || new Date().toISOString()

  return `# DSH 重启执行脚本（由 dsh-restart-plugin 自动生成，生成时间 ${生成时间}）
# 流程：删自己这条计划任务 → 记录旧 PID → 杀全部 DeepSeek Harness → 清 dsh-auth cookie
#       → 旧实例全死后安全替换唤醒事件 → WMI Win32_Process.Create 拉起 DSH
#       → 只探新 PID 的监听端口 → 写标记。
# 由 schtasks 一次性任务拉起，不在 DSH 进程树里，所以 DSH 被杀掉也不会打断它。
$ErrorActionPreference = 'Continue'
$dshHome = ${PS字符串(家目录)}
$exe = ${PS字符串(exe路径)}
$logFile = ${PS字符串(日志文件)}
$markerFile = ${PS字符串(标记文件)}
$taskName = ${PS字符串(任务名)}
$scheduleFile = Join-Path $dshHome 'storages\\schedule.json'
$pendingFile = $scheduleFile + '.pending'
$baseFile = $scheduleFile + '.base'

# 先把自己这条一次性任务删掉，避免脚本中途失败时一分钟后再触发一次。
try { schtasks.exe /Delete /F /TN $taskName | Out-Null } catch { }

function Write-Log([string]$message) {
  try {
    $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $message + [Environment]::NewLine
    [System.IO.File]::AppendAllText($logFile, $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

function Write-Marker([string]$status, [bool]$ready, [int]$processId, [int[]]$ports) {
  try {
    $doc = [ordered]@{
      status = $status
      at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      ready = $ready
      pid = $processId
      ports = @($ports)
      oldPids = @($oldPids)
    }
    $json = $doc | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($markerFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# 记录重启前的进程与端口：只有这些 PID 全部消失，才可能算重启成功。
$oldPids = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
$oldPorts = @()
foreach ($oldPid in $oldPids) {
  try {
    $oldPorts += @(Get-NetTCPConnection -State Listen -OwningProcess $oldPid -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
  } catch { }
}
Write-Log ('restart script begin, old pids=' + ($oldPids -join ',') + ' ports=' + ($oldPorts -join ','))
Write-Marker 'started' $false 0 @()

# 给宿主一点时间把 HTTP 响应发完再动手。
Start-Sleep -Seconds 2

# 1) 停掉全部 DSH 进程；最多三轮，仍有存活就放弃拉起，避免留下双实例。
$stopped = $false
for ($i = 0; $i -lt 3; $i++) {
  $procs = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { $stopped = $true; break }
  try { $procs | Stop-Process -Force -ErrorAction SilentlyContinue } catch { Write-Log ('stop failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 3
  $alive = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($alive.Count -eq 0) { $stopped = $true; break }
  Write-Log ('still running: ' + $alive.Count + ', retry ' + ($i + 1))
}
if (-not $stopped) {
  $left = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  Write-Log ('stop failed, left ' + $left.Count + '; abort launch')
  Write-Marker 'stop-failed' $false 0 @()
  exit 3
}
Write-Log 'all dsh processes stopped'

# 2) 清 dsh-auth cookie（防 Cookie 头过大导致 431 / 认证失败）。
$purge = Join-Path $dshHome '_maintenance\\purge-dsh-auth-cookies.ps1'
if (Test-Path $purge) {
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $purge -Force | Out-Null
    Write-Log 'cookies purged'
  } catch {
    Write-Log ('purge failed: ' + $_.Exception.Message)
  }
} else {
  Write-Log 'purge script missing, skip'
}

# 3) 唤醒事件已由宿主在触发时安全合并进 schedule.json。这里只在 DSH 全关后确认
#    宿主没有在关停期间改写它，再把 .pending 原子替换上去；改过就放弃唤醒，保住宿主状态。
if ((Test-Path $pendingFile) -and (Test-Path $baseFile)) {
  try {
    $baseBytes = [System.IO.File]::ReadAllBytes($baseFile)
    $currentBytes = $null
    if (Test-Path $scheduleFile) { $currentBytes = [System.IO.File]::ReadAllBytes($scheduleFile) }
    $same = $false
    if ($null -eq $currentBytes) {
      $same = $true
    } elseif ($currentBytes.Length -eq $baseBytes.Length) {
      $same = $true
      for ($i = 0; $i -lt $baseBytes.Length; $i++) {
        if ($baseBytes[$i] -ne $currentBytes[$i]) { $same = $false; break }
      }
    }
    if ($same) {
      Move-Item -Force -LiteralPath $pendingFile -Destination $scheduleFile
      $raw = [System.IO.File]::ReadAllText($scheduleFile, [System.Text.Encoding]::UTF8)
      $null = $raw | ConvertFrom-Json
      Write-Log 'wake schedule applied'
    } else {
      Write-Log 'schedule.json changed after host merge, skip wake apply'
    }
  } catch {
    Write-Log ('wake apply failed: ' + $_.Exception.Message)
  }
} else {
  Write-Log 'no pending wake schedule'
}

# 4) WMI 拉起 DSH。注意：绝不能用 Start-Process，WMI Create 才能真正脱离。
$launched = $false
$resultPid = 0
for ($i = 0; $i -lt 3; $i++) {
  try {
    $arguments = @{
      CommandLine = ('"' + $exe + '"')
      CurrentDirectory = (Split-Path $exe)
    }
    $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $arguments
    if ($result.ReturnValue -eq 0) {
      $launched = $true
      $resultPid = [int]$result.ProcessId
      Write-Log ('wmi create ok pid=' + $resultPid)
      break
    }
    Write-Log ('wmi create return ' + $result.ReturnValue)
  } catch {
    Write-Log ('wmi create failed: ' + $_.Exception.Message)
  }
  Start-Sleep -Seconds 2
}
if (-not $launched) {
  Write-Log 'launch failed'
  Write-Marker 'launch-failed' $false 0 @()
  exit 2
}

# 5) 只认 WMI 返回的新 PID：旧实例必须全部消失，且这个 PID 的监听端口可连。
#    绝不能按进程名取第一个——那可能拿到渲染进程，也可能还是旧实例。
$dshPid = $resultPid
Start-Sleep -Seconds 3
Write-Marker 'launched' $false $dshPid @()

$ready = $false
$ports = @()
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $oldAlive = @($oldPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($oldAlive.Count -gt 0) { continue }
  if ($dshPid -le 0) { continue }
  $proc = Get-Process -Id $dshPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) { continue }
  $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $dshPid -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
  foreach ($port in $ports) {
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', [int]$port)
      $client.Close()
      $ready = $true
      break
    } catch { }
  }
  if ($ready) { break }
}
if ($dshPid -le 0) { $ready = $false }
Write-Marker 'restarted' $ready $dshPid @($ports)
if ($ready) {
  Write-Log ('dsh ready pid=' + $dshPid + ' ports=' + ($ports -join ','))
} else {
  Write-Log 'dsh not ready after probe timeout'
}
Write-Log 'restart script done'
exit 0
`
}

/**
 * 生成并写入重启脚本（UTF-8 BOM）。
 * @returns {{ok:true, 路径:string, 字节数:number, 事件数:number}|{ok:false, 错误:string}}
 */
export function 写入重启脚本(选项 = {}) {
  try {
    const 路径 = 选项.脚本文件 || 解析脚本路径().脚本文件
    const 事件 = 生成唤醒事件(选项.唤醒事件 || 选项.任务 || [])
    const 文本 = 生成本次脚本文本(选项, 事件)
    const 结果 = 写文本(路径, 文本, { bom: true })
    if (!结果.ok) return { ok: false, 错误: 结果.错误 || '写脚本失败' }
    return { ok: true, 路径, 字节数: 结果.字节数, 事件数: 事件.length }
  } catch (错误) {
    return { ok: false, 错误: String(错误?.message || 错误) }
  }
}

function 生成本次脚本文本(选项, 事件) {
  return 生成重启脚本文本({
    ...选项,
    唤醒事件: 事件,
  })
}
