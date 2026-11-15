// 插件里到处要用的常量。改这里一处就够，别在别处散落魔法数字。

export const pluginName = 'dsh-restart-plugin'

/** 状态文件结构版本；结构大改时加一。 */
export const stateVersion = 1

// —— 倒计时延迟（用户要求：10~3600 秒，默认 60）——
export const defaultDelaySeconds = 60
export const minDelaySeconds = 10
export const maxDelaySeconds = 3600

/** 打开对话框时，剩余不足这么多秒的任务会被抬回这么多秒（给用户留取消的时间）。 */
export const dialogMinRemainingSeconds = 5

/** 每个输入信号让倒计时暂停这么久；超过这么久没有新输入就自动恢复。 */
export const inputPauseHoldMs = 1000

/** 宿主侧状态机心跳。 */
export const schedulerHeartbeatMs = 250

/** 状态落盘节流（倒计时中每这么多毫秒写一次盘，防止重启丢掉进度）。 */
export const statePersistIntervalMs = 5000

/** 重启完成后，唤醒事件在 schedule.json 里排多少秒后触发。 */
export const wakeDelaySeconds = 15

/** 取消任务时注入给会话的反馈文本前缀。 */
export const cancelFeedbackPrefix = '（重启调度）'

/** 计划任务名：用 schtasks 一次性任务脱离 DSH 进程树执行重启脚本。 */
export const scheduledTaskName = 'DSH-Restart-Plugin-Once'

/** 状态文件 / 已重启标记文件名（放在 DSH 家目录）。 */
export const stateFileName = 'restart-scheduler.json'
export const markerFileName = 'restart-scheduler-marker.json'


/** 重启意图文本上限：只用于面板展示，落盘前必须有硬上限。 */
export const wakeTextMaxLength = 500

/** 忙碌会话黑名单的超时：超过这么久仍报忙的会话按空闲处理，避免任务永远排不上。 */
export const busyTimeoutMs = 30 * 60 * 1000

/** 触发重启后等待新实例确认的上限；超过就复位 firing，避免永久卡死。 */
export const restartConfirmTimeoutMs = 180 * 1000

/** 开机确认重启结果时重读标记文件的间隔。 */
export const bootMarkerPollIntervalMs = 500

/** HTTP 路由前缀，客户端和宿主共用。 */
export const routePrefix = '/dsh-restart'

// —— 开机自启动（当前用户登录启动项）——

/** HKCU 下的登录启动项键；不需要管理员权限，只影响当前用户。 */
export const autoStartRunKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/** 启动项值名；同一个用户只留一个 DSH 启动项，重装/升级时按它覆盖。 */
export const autoStartValueName = 'DeepSeekHarness'

/** 插件配置文件（放在 DSH 家目录）。 */
export const configFileName = 'restart-config.json'

// —— 插件启用设置保护（重启前快照 profile，重启后校验）——

/** 决定插件是否启用/加载的两个 profile 文件：清单与开关补丁。 */
export const profileManifestFileName = 'package.json'
export const profilePatchFileName = 'cordis.patch.yml'

/** 快照根目录名（放在 DSH 家目录，与状态文件同级）。 */
export const pluginSnapshotDirName = 'plugin-snapshots'

/** 快照保留份数；恢复前备份的后缀与保留份数。 */
export const pluginSnapshotKeepCount = 5
export const pluginBackupKeepCount = 3
export const pluginBackupSuffix = '.bak-restart-'
