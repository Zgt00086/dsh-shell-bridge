# Shell 桥（dsh-go 本地插件 local-shizuku-bridge）

dsh-go 手机原生插件：借 Shizuku 给你一条 **uid=2000(shell)** 的 Android 命令通道，**只有你批准时这条通道才存在**。

不是 root：读不到别的 App 私有数据（`/data/data` 会 `Permission denied`），也改不了系统分区。

- 代码目录：`~/.dsh/dsh-go/plugins/local-shizuku-bridge/`
- 安装：`dsh plugin --profile web add ~/.dsh/dsh-go/plugins/local-shizuku-bridge`
- 装完重启一次引擎（插件代码在引擎启动时加载）

## 授权模型

通道本体是停在 `/sdcard/Download/DSH-Go/shq/` 的一个 `sh` 守护，由 Shizuku 的手机 shell 拉起。

| 状态 | 怎么来 | 能跑几条 |
|---|---|---|
| 未授权（默认） | 什么都没有 | 0 —— 守护不存在，工具直接返回 `no_grant` |
| 单次 | `sh daemon.sh once` | 1 条，跑完守护自杀 |
| 本次对话 | `sh daemon.sh ttl <秒>` | 时间窗内不限条数，到点或写 `status/stop` 自杀 |

拉起守护只能走 dsh-go 的「手机操控」（App 原生确认框：允许一次 / 本轮允许 / 取消）。
插件本身不碰手机桥，也调不动它，所以**"批准"这一步物理上落在用户手上**——插件只能写队列，写进队列也没人执行。

想在面板里批准时，点「申请一次 / 申请对话」，插件只往输入框塞一句话，不执行任何东西。

## 用法

**面板**：底部「插件」→ **Shell 桥**（半屏浮层）

- 顶部风险条：按当前授权状态给出风险等级
- 状态 / 授权范围 / 剩余 / 守护 PID / 排队 / 本次执行
- 「时间 / 命令」：最近 5 条审计
- 按钮：申请一次 · 申请对话 · 刷新 · 自检 · 关闭通道（1 秒内掐断）

**工具**：`adb_shell(command, description, timeout_ms)`

```
[ADB·uid2000 · exit 0]
设备 <型号> · Android 17 · SDK 37
```

调用行带风险等级：`ADB·[低] getprop ro.product.model`，结果另有一行迷你卡：
`ADB·uid2000 · [低·只读查询或常规命令] exit 0 · …`

## 风险分级

关键词匹配，用于提醒，不是沙箱。

| 等级 | 行为 | 例子 |
|---|---|---|
| 低 | 直接跑 | `id` `getprop` `ls` `df` `dumpsys battery` `pm list packages` `cmd wifi status` |
| 中 | 直接跑，但可能读到隐私 | `logcat` `dumpsys activity/window/package` 读/打包 `/sdcard/DCIM`、`Download`、`pm install`、`am start` |
| 高 | **「本次对话」授权下直接拒跑**，只能在「单次」授权下执行 | `rm` `pm uninstall/clear` `settings put` `am force-stop` `screencap` `input` `curl/wget/nc` `su` `chmod` `content`/`sqlite3` `kill`/`reboot`/`date -s` |

判断口径就三件事：能不能改（写）、能不能看到你的东西（读全盘 / 截屏 / 日志）、能不能拿出去（联网）。

## 审计

- `/sdcard/Download/DSH-Go/shq/log`：每条命令一行 `<时间戳> <请求 id> <退出码> <命令前 80 字节>`
- 被拒的命令不进日志（因为压根没发到设备）
- 面板「时间 / 命令」表显示最近 5 条，失败带 `✕`

## 目录结构

```
/sdcard/Download/DSH-Go/shq/
├── daemon.sh   守护脚本（引擎启动时自动重写成当前版本）
├── in/         待执行请求 *.sh
├── out/        输出，只保留最近 20 个
├── status/     alive 心跳 · mode 模式与到期 · pid · stop 停止标记 · busy
├── log         审计
└── ...
```

环境变量 `SHQ_DIR` 可以换这个根目录（测试用）。

## 已知限制

- 风险分级是关键词匹配：`$(echo cm'd wifi set-wifi-enabled 0)` 这种拼字符串就绕过，别当拦截器用
- 守护挂在 Shizuku 上：关掉 Shizuku 的 shell、重启手机，都要重新拉起（面板点「申请一次」即可）
- 每条命令约 1 秒延迟（守护 1 秒一轮询）
- 审计日志按 80 字节截断，中文可能被切成半个字
- 单条命令没有独立超时：一条挂住的命令会堵住队列，直到它自己结束

## 开发

```sh
node test/smoke.mjs      # 35 项离线检查：授权闸、风险分级、面板数据、守护脚本语法
node ~/.dsh/skills/dsh-go-plugin/kit/bin/check.mjs . --load   # 插件清单与视图检查
```

`bin/shq` 是给人和 Agent 用的命令行小工具：`shq 'id -u'`，没有授权时返回 126。
