// 生成并写入重启用的 PowerShell 脚本（UTF-8 BOM）。
//
// 脚本本身要能独立活下来：它是被 schtasks 一次性任务拉起的，不在 DSH 进程树里；
// 它负责：杀全部 DeepSeek Harness → 清 dsh-auth cookie → 往 schedule.json 写唤醒事件
// → WMI Win32_Process.Create 拉起 DSH（绝不能用 Start-Process）→ TCP 端口探测 → 写标记文件。

import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  wakeDelaySeconds,
  scheduledTaskName,
  markerFileName,
  profileManifestFileName,
  profilePatchFileName,
  pluginBackupKeepCount,
} from './constants.js'
import { writeText } from './fsutil.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

/** 本插件根目录（lib 的上一级）。 */
export const pluginRoot = path.resolve(scriptDir, '..')

/** 默认 DSH 可执行文件路径（取不到当前进程路径时的兜底，和成熟脚本一致）。 */
export const defaultExePath = 'D:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'

/** 取 DSH 家目录：优先环境变量，其次 ~/.dsh。 */
export function resolveHome(env = process.env) {
  const specified = String(env?.DSH_HOME || '').trim()
  if (specified) return specified
  try {
    return path.join(os.homedir(), '.dsh')
  } catch {
    return 'C:\\Users\\Administrator\\.dsh'
  }
}

/** 取当前 DSH 可执行文件路径：Electron 主进程里 process.execPath 就是它。 */
export function resolveExePath(env = process.env) {
  const specified = String(env?.DSH_RESTART_EXE || '').trim()
  if (specified) return specified
  try {
    const current = String(process.execPath || '')
    if (/DeepSeek Harness\.exe$/i.test(current)) return current
  } catch {
    /* 忽略 */
  }
  return defaultExePath
}

/** 解析所有会被写进脚本的路径。测试可以整包替换。 */
export function resolveScriptPaths(env = process.env) {
  const homeDir = resolveHome(env)
  return {
    homeDir,
    exePath: resolveExePath(env),
    scriptFile: String(env?.DSH_RESTART_SCRIPT || '').trim() || path.join(pluginRoot, 'restart.ps1'),
    logFile: String(env?.DSH_RESTART_LOG || '').trim() || path.join(pluginRoot, 'restart.log'),
    markerFile: String(env?.DSH_RESTART_MARKER || '').trim() || path.join(homeDir, markerFileName),
  }
}

/**
 * 生成唤醒消息正文：只报告重启完成这一事实，并带上可核查的运行记录 id。
 *
 * 会话重启后前文仍在，待办与备忘可以直接看历史，不需要在唤醒消息里复述；
 * 复述反而会把同一份备忘存两遍，并让第二次注入与原意错位。
 */
export function buildWakePrompt(runId) {
  const id = String(runId ?? '').trim()
  return id ? `DSH 已重启完成（运行记录 ${id}）。` : 'DSH 已重启完成。'
}

/**
 * 把任务列表整理成 schedule.json 里的唤醒事件（同一会话只留一条，避免重复唤醒）。
 * @returns {Array<{sessionId:string, prompt:string, afterSeconds:number, title:string}>}
 */
export function buildWakeEvents(taskList = [], options = {}) {
  const seen = new Set()
  const event = []
  const prompt = buildWakePrompt(options?.runId)
  for (const task of Array.isArray(taskList) ? taskList : []) {
    if (!task || typeof task !== 'object') continue
    const session = String(task.sessionId || '').trim()
    if (!session || seen.has(session)) continue
    seen.add(session)
    const seconds = Number(task.afterSeconds)
    event.push({
      sessionId: session,
      prompt,
      afterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : wakeDelaySeconds,
      title: '重启完成唤醒',
    })
  }
  return event
}

/** PowerShell 单引号字符串转义：内部单引号写两遍。 */
export function psQuote(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`
}

/**
 * 生成重启脚本全文。
 * @param {object} options
 * @param {Array} options.wakeEvents
 * @param {string} options.homeDir
 * @param {string} options.exePath
 * @param {string} options.logFile
 * @param {string} options.markerFile
 * @param {string} [options.taskName]
 * @param {string} [options.generatedAt]
 * @param {string} [options.profileDir] 要写回的 profile 目录；空则脚本跳过恢复
 * @param {string} [options.pluginSnapshotDir] 重启前拍下的插件设置快照目录
 */
export function buildRestartScript(options = {}) {
  const homeDir = options.homeDir || resolveHome()
  const exePath = options.exePath || resolveExePath()
  const logFile = options.logFile || path.join(pluginRoot, 'restart.log')
  const markerFile = options.markerFile || path.join(homeDir, markerFileName)
  const taskName = options.taskName || scheduledTaskName
  const generatedAt = options.generatedAt || new Date().toISOString()
  const profileDir = String(options.profileDir || '')
  const pluginSnapshotDir = String(options.pluginSnapshotDir || '')

  return `# DSH 重启执行脚本（由 dsh-restart-plugin 自动生成，生成时间 ${generatedAt}）
# 流程：删自己这条计划任务 → 记录旧 PID → 杀全部 DeepSeek Harness
#       → 旧实例全死后把插件启用设置快照写回 profile → 清 dsh-auth cookie
#       → 安全替换唤醒事件 → WMI Win32_Process.Create 拉起 DSH
#       → 旧 PID 全退后沿新进程树探监听端口 → 写标记。
# 由 schtasks 一次性任务拉起，不在 DSH 进程树里，所以 DSH 被杀掉也不会打断它。
$ErrorActionPreference = 'Continue'
$dshHome = ${psQuote(homeDir)}
$exe = ${psQuote(exePath)}
$logFile = ${psQuote(logFile)}
$markerFile = ${psQuote(markerFile)}
$taskName = ${psQuote(taskName)}
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

# readyAt 只在真探测到可连接口时写入；超时的 marker 保留 ready=false，不伪造就绪时间。
function Write-Marker([string]$status, [bool]$ready, [int]$processId, [int[]]$ports, [string]$readyAt = '') {
  try {
    $doc = [ordered]@{
      status = $status
      at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      ready = $ready
      pid = $processId
      ports = @($ports)
      oldPids = @($oldPids)
    }
    if ($readyAt) { $doc['readyAt'] = $readyAt }
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

# 2) 把重启前快照的插件启用设置写回 profile。
#    时机是硬要求：旧进程必须全部退出（否则它可能再写一遍配置），新实例还没拉起
#    （否则新进程读到的还是被改过的配置）。只按字节复制，不解析 YAML；
#    备份失败就不覆盖，任何异常都只记日志，绝不阻断重启。
$profileDir = ${psQuote(profileDir)}
$pluginSnapshotDir = ${psQuote(pluginSnapshotDir)}
$pluginBackupKeep = ${pluginBackupKeepCount}
function Restore-PluginFile([string]$fileName) {
  try {
    $source = Join-Path $pluginSnapshotDir $fileName
    if (-not (Test-Path -LiteralPath $source)) {
      Write-Log ('plugin snapshot missing ' + $fileName + ', skip')
      return
    }
    $target = Join-Path $profileDir $fileName
    $snapshotBytes = [System.IO.File]::ReadAllBytes($source)
    $same = $false
    if (Test-Path -LiteralPath $target) {
      $currentBytes = [System.IO.File]::ReadAllBytes($target)
      if ($currentBytes.Length -eq $snapshotBytes.Length) {
        $same = $true
        for ($i = 0; $i -lt $snapshotBytes.Length; $i++) {
          if ($snapshotBytes[$i] -ne $currentBytes[$i]) { $same = $false; break }
        }
      }
    }
    if ($same) {
      Write-Log ('plugin state unchanged ' + $fileName)
      return
    }
    if (Test-Path -LiteralPath $target) {
      $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
      $backup = $target + '.bak-restart-' + $stamp
      Copy-Item -LiteralPath $target -Destination $backup -Force
      $pattern = $fileName + '.bak-restart-*'
      $backups = @(Get-ChildItem -LiteralPath $profileDir -Filter $pattern -File | Sort-Object Name)
      if ($backups.Count -gt $pluginBackupKeep) {
        $backups | Select-Object -First ($backups.Count - $pluginBackupKeep) | Remove-Item -Force
      }
      Write-Log ('plugin state backup ' + $backup)
    }
    # 同目录临时文件 + Replace/Move：避免新进程读到半截文件。
    $tmp = $target + '.restart-tmp'
    [System.IO.File]::WriteAllBytes($tmp, $snapshotBytes)
    if (Test-Path -LiteralPath $target) {
      try { [System.IO.File]::Replace($tmp, $target, $null) }
      catch { Move-Item -Force -LiteralPath $tmp -Destination $target }
    } else {
      Move-Item -Force -LiteralPath $tmp -Destination $target
    }
    Write-Log ('plugin state restored ' + $fileName)
  } catch {
    Write-Log ('plugin state restore failed for ' + $fileName + ': ' + $_.Exception.Message)
  }
}
if ($profileDir -and $pluginSnapshotDir -and (Test-Path -LiteralPath $profileDir) -and (Test-Path -LiteralPath $pluginSnapshotDir)) {
  Restore-PluginFile '${profileManifestFileName}'
  Restore-PluginFile '${profilePatchFileName}'
} else {
  Write-Log 'no plugin snapshot for this restart, skip restore'
}

# 3) 清 dsh-auth cookie（防 Cookie 头过大导致 431 / 认证失败）。
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

# 4) 唤醒事件已由宿主在触发时合并进 schedule.json。脚本只在 DSH 全关后确认
#    宿主没有在关停前后再改写它，才用 .pending 冗余替换一次；不同就跳过，保住宿主后来写入的内容。
#    有唤醒事件时，合并结果本身就是宿主写进 schedule.json 的，必然与 .base（合并前原文件）
#    不同，所以正常重启也会走 'schedule.json changed after host merge, skip wake apply'。
#    那是保护分支而不是失败：唤醒事件在合并时就已就位，跳过替换不会丢唤醒，反而避免覆盖
#    宿主在关停期间写入的新状态。
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

# 5) WMI 拉起 DSH。注意：绝不能用 Start-Process，WMI Create 才能真正脱离。
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

# 6) 就绪判定必须从 WMI 返回的入口 PID 出发，沿进程树找监听端口：
#    Win32_Process.Create 拉起的是 Electron 入口进程，真正监听 Web GUI 端口的是它派生出来的
#    子进程；只看入口 PID 自己的 Listen 端口会一直为空，把已经起来的实例误判成超时。
#
#    边界：
#    - 旧实例 PID 必须全部消失后才开始收集，否则可能把旧实例的端口当成新实例的；
#    - 不按进程名扫描：同名进程里既有渲染进程，也可能有残留旧实例，只有父子关系能把范围
#      限定在这次新拉起的进程树上；
#    - 进程树是动态的，深度、节点数和单次扫描时长都设上限，避免异常父子环或进程爆炸拖死探测；
#      外层 45 次 × 2 秒仍是整体超时预算。
$dshPid = $resultPid
Start-Sleep -Seconds 3
Write-Marker 'launched' $false $dshPid @()

$processTreeMaxDepth = 6
$processTreeMaxNodes = 128
$processTreeScanBudgetMs = 5000

# 收集以 rootProcessId 为根的整棵进程树（含自身），返回 PID 数组。
# 用队列迭代代替递归，先一次性取进程表建 ParentProcessId -> 子 PID 索引，避免逐节点查 WMI。
function Get-ProcessTreeIds([int]$rootProcessId) {
  $result = New-Object System.Collections.ArrayList
  $pending = New-Object System.Collections.ArrayList
  [void]$pending.Add(@($rootProcessId, 0))
  $seen = @{}
  $childrenByParent = @{}
  $deadline = (Get-Date).AddMilliseconds($processTreeScanBudgetMs)
  try {
    $allProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
  } catch {
    return $result.ToArray()
  }
  foreach ($process in $allProcesses) {
    $parentKey = [int]$process.ParentProcessId
    if (-not $childrenByParent.ContainsKey($parentKey)) {
      $childrenByParent[$parentKey] = New-Object System.Collections.ArrayList
    }
    [void]$childrenByParent[$parentKey].Add([int]$process.ProcessId)
  }
  $index = 0
  while ($index -lt $pending.Count -and $result.Count -lt $processTreeMaxNodes -and (Get-Date) -lt $deadline) {
    $item = $pending[$index]
    $index++
    $procId = [int]$item[0]
    $depth = [int]$item[1]
    if ($seen.ContainsKey($procId)) { continue }
    $seen[$procId] = $true
    [void]$result.Add($procId)
    if ($depth -ge $processTreeMaxDepth) { continue }
    if ($childrenByParent.ContainsKey($procId)) {
      foreach ($childId in $childrenByParent[$procId]) {
        [void]$pending.Add(@([int]$childId, ($depth + 1)))
      }
    }
  }
  return $result.ToArray()
}

$ready = $false
$readyAt = ''
$ports = @()
for ($i = 0; $i -lt 45; $i++) {
  Start-Sleep -Seconds 2
  $oldAlive = @($oldPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  if ($oldAlive.Count -gt 0) { continue }
  if ($dshPid -le 0) { continue }
  $proc = Get-Process -Id $dshPid -ErrorAction SilentlyContinue
  if ($null -eq $proc) { continue }
  $treeIds = @(Get-ProcessTreeIds $dshPid)
  $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $treeIds -contains [int]$_.OwningProcess } |
    Select-Object -ExpandProperty LocalPort -Unique)
  foreach ($port in $ports) {
    $client = $null
    try {
      $client = New-Object System.Net.Sockets.TcpClient
      $client.Connect('127.0.0.1', [int]$port)
      $ready = $true
    } catch {
    } finally {
      if ($null -ne $client) { $client.Close() }
    }
    if ($ready) { break }
  }
  if ($ready) {
    $readyAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    break
  }
}
if ($dshPid -le 0) { $ready = $false; $readyAt = '' }
Write-Marker 'restarted' $ready $dshPid @($ports) $readyAt
if ($ready) {
  Write-Log ('dsh ready pid=' + $dshPid + ' ports=' + ($ports -join ',') + ' readyAt=' + $readyAt)
} else {
  Write-Log 'dsh not ready after probe timeout'
}
Write-Log 'restart script done'
exit 0
`
}

/**
 * 生成并写入重启脚本（UTF-8 BOM）。
 * @returns {{ok:true, filePath:string, byteCount:number, eventCount:number}|{ok:false, error:string}}
 */
export function writeRestartScript(options = {}) {
  try {
    const filePath = options.scriptFile || resolveScriptPaths().scriptFile
    const event = buildWakeEvents(options.wakeEvents || options.task || [])
    const text = buildCurrentScript(options, event)
    const result = writeText(filePath, text, { bom: true })
    if (!result.ok) return { ok: false, error: result.error || '写脚本失败' }
    return { ok: true, filePath, byteCount: result.byteCount, eventCount: event.length }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

function buildCurrentScript(options, event) {
  return buildRestartScript({
    ...options,
    wakeEvents: event,
  })
}
