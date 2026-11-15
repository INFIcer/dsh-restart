# DSH 重启调度插件

给 DSH 排一个「过一会儿重启」的任务：多个会话可以各排各的，等所有会话都空闲才开始倒计时，倒计时期间只要有输入（鼠标、键盘、滚轮）就会暂停。零外部依赖，只用 DSH 插件 API 和 Node 内置模块。

| 功能 | 说明 |
| --- | --- |
| 排重启 | 说一句「20 秒后重启」，到点自动重启 DSH |
| 多会话排队 | 每个会话排自己的任务，互不覆盖 |
| 空闲才开始 | 还有会话在跑时显示「已暂停 · 等待会话空闲」，全部空闲才开始倒计时 |
| 暂停写法统一 | 会话在跑和有输入都写「已暂停」，只有原因说明不同 |
| 输入暂停 | 鼠标移动、按键、点击、滚轮都让全部倒计时暂停，停 1 秒后恢复 |
| 面板取消 | 弹框里可以取消任意任务，排任务的会话会收到一条反馈 |
| 重启后唤醒 | 重启完成时只通知排过任务的会话「重启已完成」，不复述重启前的备忘 |
| 开机自启动 | 登录 Windows 后自动启动 DSH，在插件页里开关 |
| 插件设置保护 | 重启前快照 profile 的 `package.json` / `cordis.patch.yml`，旧进程退出后写回，新实例起来再核对一次 |
| 自带提示 | 往系统提示里加一段：重启交给 `dsh_restart`，别自己杀进程 |

## 安装

需要 Windows、DSH 桌面版。

1. 把本目录放到任意位置（例如 `E:\dsh-restart-plugin`）。
2. 打开 `C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json`，在 `dependencies` 里加一行 `"dsh-restart-plugin": "link:E:/dsh-restart-plugin"`，在 `dsh.profile.bundles` 数组里加一项 `"dsh-restart-plugin"`。
3. 重启一次 DSH 生效。

目录里没有 `node_modules`，也不需要安装依赖。

## 使用

**排重启**：直接跟 AI 说「30 秒后重启」。AI 会调用 `dsh_restart` 工具（`action: "schedule"`）。任务排上后左下角只出现悬浮提示；等所有会话空闲、真正开始倒计时，界面才自动弹出倒计时卡片——还有会话在跑时不弹窗，不挡正在干活的人。想写明重启意图（比如「重启后继续装插件」），把它放进 `wakeText`：它只显示在卡片上，不会作为唤醒消息发回来。

**看任务**：问 AI「重启任务什么状态」，或者点左下角的悬浮提示展开面板。弹窗收起后，左下角会一直显示剩余时间最短的那个任务。卡片上会写谁排的、什么原因、还剩几秒，以及现在是倒计时中还是已暂停（并说明为什么停）。

**取消**：在弹框里点任务后面的「取消」。任务会立刻删掉，排任务的那个会话会收到一条消息说明它被取消了。

**暂停**：倒计时期间只要有输入就会暂停——鼠标移动、鼠标按键、滚轮、键盘按键都算——停下 1 秒自动继续。暂停是真的在插件里停住，不是界面动画。还有会话在跑时倒计时同样停着，界面一律写「已暂停」——悬浮条、面板徽标、说明文字三处口径一致，只把原因分开写明（有输入 / 等会话空闲）。

**立即重启**：卡片右下角的「立即重启」跳过剩余倒计时，连点两次才执行（3 秒内不点第二次自动复原）。还有会话在跑时这个按钮是禁用的：那样会掐掉正在跑的回合，等它们空闲后再点。

**重启之后**：DSH 起来后，排过任务的会话只收到一条「已重启完成（运行记录 …）」。重启前写下的备忘不会复述——会话的前文都还在，直接看得到。

**开机自启动**：打开侧栏的「插件」页，找到「重启」，点开后勾选「开机自启动」。以后登录 Windows 就会自动启动 DSH；取消勾选就关闭。开关只影响当前 Windows 用户，不需要管理员权限。DSH 升级或换目录后，插件会按当前程序位置自动校正启动项，不需要重新设置。

## 工具返回值

`dsh_restart` 的返回只给结果，不回显刚传进来的参数，也不在 `hint` 里重复说明。

排任务：

```json
{
  "ok": true,
  "action": "schedule",
  "taskId": "restart-3f9c2a1b",
  "phase": "waiting",
  "busyCount": 1,
  "remainingSeconds": 30,
  "createdAt": "2026-11-13T13:00:00.000Z",
  "hint": "可用 status 查看进度，cancel 取消。"
}
```

查状态：

```json
{
  "ok": true,
  "action": "status",
  "phase": "countdown",
  "paused": false,
  "busyCount": 0,
  "taskCount": 1,
  "tasks": [
    {
      "id": "restart-3f9c2a1b",
      "session": "a1b2c3d4",
      "status": "countdown",
      "remainingSeconds": 12,
      "createdAt": "2026-11-13T13:00:00.000Z"
    }
  ],
  "lastRestart": null,
  "now": "2026-11-13T13:00:18.000Z"
}
```

取消任务：

```json
{
  "ok": true,
  "action": "cancel",
  "taskId": "restart-3f9c2a1b",
  "feedbackDelivered": true,
  "remainingTaskCount": 0,
  "phase": "idle"
}
```

`tasks` 只是当前排着的任务；`lastRestart` 只在有重启记录时出现，字段是 `id` / `status` / `firedAt`，确认完成后再加 `restartedAt`，失败时带 `error`。

## 插件启用设置保护

DSH 命令行 `dsh plugin` 对齐依赖时，会把已安装的 bundle 重新加回 profile 的 `dsh.profile.bundles`，表现为「重启后非官方插件又全被启用」。本插件不参与那套对齐逻辑，只在自己重启的链路里加一道保险：

1. 强杀旧进程之前，把 profile 目录里的 `package.json`（先确认能 `JSON.parse`）和 `cordis.patch.yml` 按字节快照到 `<DSH 家目录>/plugin-snapshots/<时间戳>/`，只留最近 5 份。
2. 旧进程全部退出、新实例拉起之前，把快照原子写回 profile；覆盖前把当前文件另存为 `.bak-restart-<时间戳>`，每个文件只留最近 3 份。
3. 新实例端口就绪后，再按字节比较一次；不一致就再写回一次并记 warn（附 bundles 增删、disabled 行变化摘要），结果记进重启状态文件的 `pluginStateRestored` 字段。

旧进程退出到新进程启动之间是配置唯一的「空窗期」，写回放在这里，新进程读到的就是重启前的设置。快照或恢复失败只记日志，不影响重启本身；找不到 profile 或文件时安全跳过，不改动 `cordis.patch.yml` 的内容。

profile 目录按固定顺序定位：显式传入 → `DSH_PROFILE_DIR` → `DSH_PROFILE` 拼家目录 → 扫描 `<DSH 家目录>/profiles`。扫描时优先选 `node_modules/dsh-restart-plugin` 能经 realpath 解析回本插件目录的候选（兼容 `link:` 安装），多个候选都命中时优先名为 `desktop` 的那个，都不命中时只接受唯一候选；每一步都要求目录里有 `package.json`。桌面端进程不设 `DSH_PROFILE_DIR`，靠这条顺序定位到托管当前实例的 profile。

## 重启成功如何判定

脚本从 WMI `Win32_Process.Create` 拿到的是 Electron 入口进程，真正监听 Web GUI 端口的是它派生出来的子进程。因此就绪判定不能只看入口 PID 自己的端口，也不能按进程名扫：同名进程里既有渲染进程，也可能有还没退干净的旧实例。判定顺序是：

1. 先确认重启前记下的旧 PID 全部消失，否则这一轮继续等——旧实例还在时，它的端口可能被误当成新实例的。
2. 从入口 PID 出发，按 `Win32_Process` 的 `ParentProcessId` 收集整棵进程树（含入口自身）；深度上限 6、节点上限 128、单次扫描 5 秒，避免异常父子环或进程爆炸把探测拖死。
3. 汇总树内所有进程的 Listen 端口，逐个 TCP connect `127.0.0.1`；任意一个连上就写 `status=restarted`、`ready=true`、`pid`、`ports`、`readyAt`。
4. 外层共 45 次 × 2 秒。超时仍写 `status=restarted`，但 `ready=false`、不写 `readyAt`，插件状态记为 `restarted-unconfirmed`，不会伪造成成功。

入口进程活着只说明「已拉起」，端口可连才说明「已就绪」；状态文件把这两种情况分开记录。

## 唤醒事件与 schedule.json

宿主触发重启时，先把唤醒事件合并进 `storages/schedule.json`，同时留下 `.base`（合并前原文件的字节）和 `.pending`（合并结果）。脚本只做一件事：旧实例全退后，如果当前 `schedule.json` 仍与 `.base` 一致，就用 `.pending` 原子替换；不一致就记 `schedule.json changed after host merge, skip wake apply` 并跳过。

有唤醒事件时，合并结果本身就是宿主写进 `schedule.json` 的，当前文件必然不等于 `.base`，所以正常重启也会出现这行日志。它是有意保护：宿主可能在关停窗口里又写入新状态，脚本不能用旧快照覆盖；唤醒事件在合并阶段已经就位，跳过替换不会丢唤醒。

唤醒事件的正文是固定的一句「DSH 已重启完成（运行记录 id）」：重启后的会话前文都在，能直接看到自己写下的备忘，所以不复述。任务的 `wakeText` 只用于面板展示重启意图，既不写进唤醒正文，也不进重启记录（`lastRestart.tasks` 里没有这个字段）；旧状态文件里残留的 `wakeText` 读取时忽略，不迁移、不报错。

## 系统提示

插件加载时往系统提示里注册一段静态文本（段名 `dsh-restart-guidance`）：要重启 DSH 时用 `dsh_restart` 排期，不要自己杀进程或拼 `schtasks`——手动重启会让会话失联。

这件事属于重启插件的职责，所以提示由本插件自己注入，不依赖其它插件。`systemPrompt` 服务是可选读取的：旧版 DSH 没有这个服务时只记一条日志，排重启等其余功能照常；插件卸载时这段提示一起撤掉。

## 代码约定

标识符、文件名、配置键、日志 key 一律用英文。注释、docstring 和本文档一律用中文，只写原理、不变量与边界，不写日期、讨论过程或个人备忘。面向用户的文案（面板文字、注入反馈、错误提示）不算代码，保持原样。

工具的参数与返回 schema 只用宿主支持的子集：`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`，外加 `description` / `title` / `default` / `examples`。宿主把 schema 直接投成系统提示里的 TypeScript 声明，出现子集外的关键字（`minimum`、`maximum` 之类）时整段参数类型会降级成 `unknown`，而调用照旧成功——退化只在系统提示里可见。所以数值范围写进 `description`，真正的限制由 `normalizeDelaySeconds` 在运行时夹取；`tests/host.test.js` 里有一条用例守住这个关键字集合。

## 已知缺陷

- 只支持 Windows；开机自启动也只在 Windows 生效。
- 不做看门狗：重启后 DSH 起不来就起不来，需要自己手动打开。
- 重启会关掉所有 DSH 窗口和正在跑的任务，没保存的对话请先处理。
- 排队等空闲按会话状态判断：某个会话持续非空闲超过 30 分钟会按空闲处理，避免永久等待，但可能误判。
- 暂停只统计 DSH 窗口内的输入；在别的窗口操作时倒计时照常走。
- 唤醒事件依赖宿主 `storages/schedule.json` 的格式；格式不符时只记日志、放弃唤醒，重启本身照常。
- 唤醒消息只报告重启完成，不携带重启原因或备忘；需要这些信息请回看重启前的会话记录。
