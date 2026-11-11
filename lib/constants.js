// 插件里到处要用的常量。改这里一处就够，别在别处散落魔法数字。

export const 插件名 = 'dsh-restart-plugin'

/** 状态文件结构版本；结构大改时加一。 */
export const 状态版本 = 1

// —— 倒计时延迟（主人要求：10~3600 秒，默认 60）——
export const 默认延迟秒 = 60
export const 最小延迟秒 = 10
export const 最大延迟秒 = 3600

/** 打开对话框时，剩余不足这么多秒的任务会被抬回这么多秒（给主人留取消的时间）。 */
export const 弹框最小剩余秒 = 5

/** 鼠标移动时每个信号让倒计时暂停这么久；超过这么久没有新信号就自动恢复。 */
export const 鼠标暂停保持毫秒 = 1000

/** 宿主侧状态机心跳。 */
export const 调度心跳毫秒 = 250

/** 状态落盘节流（倒计时中每这么多毫秒写一次盘，防止重启丢掉进度）。 */
export const 状态落盘间隔毫秒 = 5000

/** 重启完成后，唤醒事件在 schedule.json 里排多少秒后触发。 */
export const 唤醒延迟秒 = 15

export const 默认唤醒文本 = '（大肥鱼）DSH 已重启完成，可以继续了。'

/** 取消任务时注入给会话的反馈文本前缀。 */
export const 取消反馈前缀 = '（重启调度）'

/** 计划任务名：用 schtasks 一次性任务脱离 DSH 进程树执行重启脚本。 */
export const 计划任务名 = 'DSH-Restart-Plugin-Once'

/** 状态文件 / 已重启标记文件名（放在 DSH 家目录）。 */
export const 状态文件名 = 'restart-scheduler.json'
export const 标记文件名 = 'restart-scheduler-marker.json'

/** HTTP 路由前缀，客户端和宿主共用。 */
export const 路由前缀 = '/dsh-restart'
