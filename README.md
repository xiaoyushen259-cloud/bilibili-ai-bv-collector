# Bilibili AI BV Collector

自动采集最近滚动 90 天内、播放量不少于 1 万且与指定 AI 关键词相关的 B站视频。结果以 BV号去重，保存在 SQLite，并导出为“BV汇总 + 视频明细”Excel。

## 功能

- 每 30 分钟发现新达标视频，每天深度复扫最近 90 天。
- 按播放量排序扫描，接口达到 1,000 条上限时自动拆分时间窗口。
- 支持 `agent`、`AI`、`Codex`、`Claude Code`、`ComfyUI`、`Midjourney` 等关键词及别名。
- 对 `AI`、`MJ`、`SD` 等歧义词使用单词边界和 AI 上下文过滤。
- SQLite 断点续扫、BV号去重、关键词合并、首次达标时间记录。
- 导出滚动主表和周报 Excel，包含可点击 B站直链。
- `412` 限流时延期当前单元，不登录、不保存 Cookie、不绕过验证码。

## 运行要求

- Windows 10/11。
- 已安装 Codex Desktop。项目使用其随附的 Node.js 和 `@oai/artifact-tool` 生成 Excel；该包目前不在公共 npm 仓库发布。
- 当前 Windows 用户保持登录，计划任务才能按配置运行。

## 快速开始

在 PowerShell 中运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-tasks.ps1 -RunInitialBackfill
```

安装脚本会自动定位当前用户目录下的 Codex Node.js 运行时，并创建三个任务：

- `BVCollector-Incremental`：每 30 分钟增量采集并续跑一批首次回溯。
- `BVCollector-Daily`：每天 03:30 深度复扫。
- `BVCollector-Weekly`：每周一 09:00 导出上周周报。

只安装任务、不立即回溯：

```powershell
.\scripts\install-tasks.ps1
```

移除任务：

```powershell
.\scripts\uninstall-tasks.ps1
```

## 手动运行

```powershell
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --no-warnings .\app.mjs doctor
& $node --no-warnings .\app.mjs cycle
& $node --no-warnings .\app.mjs scan --mode incremental
& $node --no-warnings .\app.mjs scan --mode full
& $node --no-warnings .\app.mjs export --scope master
& $node --no-warnings .\app.mjs export --scope weekly
& $node --no-warnings --test
```

任务以当前登录用户运行。电脑关闭、用户未登录或断网时不会采集；恢复后由任务计划补跑。重复任务会被单实例锁阻止。

B站返回 `412` 或 `v_voucher` 时，当前扫描会保留到“关键词 + 7 天时间片”的断点并延期当前单元，不阻塞其他关键词。热门时间片达到接口 1,000 条上限时仍会自动二分。半小时任务先执行增量扫描，再续跑一批尚未完成的首次回溯；每日 03:30 继续执行不限批次的深度复扫。

## 输出

- `output\BV号自动采集.xlsx`：最近滚动 90 天的主表。
- `output\周报\BV号_YYYY-MM-DD_至_YYYY-MM-DD.xlsx`：上一个完整自然周首次达标的视频。
- `data\collector.sqlite`：持久化状态和断点。
- `logs\YYYY-MM-DD.log`：运行日志，自动保留 30 天。

配置集中在 `config.json`，可调整关键词、播放量门槛、时间窗口、请求间隔和相关性上下文词。

## 数据与隐私

仓库不包含本机数据库、运行日志、Excel 结果或 Cookie。采集器仅访问 B站公开搜索接口，并遵守保守的单线程请求间隔；接口异常时保留本地断点。

## License

MIT
