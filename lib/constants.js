// 插件里到处要用的常量。改这里一处就够，别在别处散落魔法数字。

export const pluginName = 'dsh-restart-plugin'

/** 状态文件结构版本；结构大改时加一。 */
export const stateVersion = 1

// —— 倒计时延迟（主人要求：10~3600 秒，默认 60）——
export const defaultDelaySeconds = 60
export const minDelaySeconds = 10
export const maxDelaySeconds = 3600

/** 打开对话框时，剩余不足这么多秒的任务会被抬回这么多秒（给主人留取消的时间）。 */
export const dialogMinRemainingSeconds = 5

/** 鼠标移动时每个信号让倒计时暂停这么久；超过这么久没有新信号就自动恢复。 */
export const mousePauseHoldMs = 1000

/** 宿主侧状态机心跳。 */
export const schedulerHeartbeatMs = 250

/** 状态落盘节流（倒计时中每这么多毫秒写一次盘，防止重启丢掉进度）。 */
export const statePersistIntervalMs = 5000

/** 重启完成后，唤醒事件在 schedule.json 里排多少秒后触发。 */
export const wakeDelaySeconds = 15

export const defaultWakeText = '（大肥鱼）DSH 已重启完成，可以继续了。'

/** 取消任务时注入给会话的反馈文本前缀。 */
export const cancelFeedbackPrefix = '（重启调度）'

/** 计划任务名：用 schtasks 一次性任务脱离 DSH 进程树执行重启脚本。 */
export const scheduledTaskName = 'DSH-Restart-Plugin-Once'

/** 状态文件 / 已重启标记文件名（放在 DSH 家目录）。 */
export const stateFileName = 'restart-scheduler.json'
export const markerFileName = 'restart-scheduler-marker.json'


/** 唤醒文本上限：WakeText 会进入 schedule.json 并被注入会话，必须有硬上限。 */
export const wakeTextMaxLength = 500

/** 忙碌会话黑名单的超时：超过这么久仍报忙的会话按空闲处理，避免任务永远排不上。 */
export const busyTimeoutMs = 30 * 60 * 1000

/** 触发重启后等待新实例确认的上限；超过就复位 firing，避免永久卡死。 */
export const restartConfirmTimeoutMs = 180 * 1000

/** HTTP 路由前缀，客户端和宿主共用。 */
export const routePrefix = '/dsh-restart'
