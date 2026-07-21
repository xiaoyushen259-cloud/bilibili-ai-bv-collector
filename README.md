# Bilibili AI BV Collector

自动采集最近滚动 90 天内、播放量不少于 1 万且与指定 AI 关键词相关的 B站视频。结果以 BV号去重，保存在 SQLite，并导出为“BV汇总 + 视频明细”Excel。

## 功能

- 每 1 小时发现新达标视频，每天深度复扫最近 90 天。
- 按播放量排序扫描，接口达到 1,000 条上限时自动拆分时间窗口。
- 支持 `agent`、`AI`、`Codex`、`ComfyUI`、`Midjourney`、`Seedance 2.0` 等关键词及别名。
- 对 `AI`、`MJ`、`discord` 等歧义词使用单词边界和 AI 上下文过滤。
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

- `BVCollector-Incremental`：每 1 小时增量采集并续跑一批首次回溯。
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

B站返回 `412` 或 `v_voucher` 时，当前扫描会保留到“关键词 + 7 天时间片”的断点并延期当前单元，不阻塞其他关键词。热门时间片达到接口 1,000 条上限时仍会自动二分。每小时任务先执行增量扫描，再续跑一批尚未完成的首次回溯；每日 03:30 继续执行不限批次的深度复扫。

## 运行消耗与电脑要求

- 采集器不调用 Codex 或 OpenAI API，每次计划任务消耗的 AI Token 为 `0`。
- 运行时只调用 B站公开接口和飞书开放平台接口，并读写本地 SQLite；仅消耗少量网络流量、CPU、内存和磁盘空间。
- 自动采集要求电脑开机、Windows 当前用户已登录、网络可用，并且电脑未处于睡眠或休眠状态。
- 关机、睡眠或断网期间不会采集；恢复运行条件后，任务计划会补跑一次，然后继续按每 1 小时间隔执行。
- 任务处于 `Disabled` 状态时不会执行。调整触发频率不会自动启用已暂停的任务，可通过 `Get-ScheduledTask -TaskName 'BVCollector-*'` 检查状态。

## 输出

- `output\BV号自动采集.xlsx`：最近滚动 90 天的主表。
- `output\周报\BV号_YYYY-MM-DD_至_YYYY-MM-DD.xlsx`：上一个完整自然周首次达标的视频。
- `data\collector.sqlite`：持久化状态和断点。
- `logs\YYYY-MM-DD.log`：运行日志，自动保留 30 天。

配置集中在 `config.json`，可调整关键词、播放量门槛、时间窗口、请求间隔和相关性上下文词。

## 自定义命中关键词与内容分区

`keywordGroups` 中每一项都可以独立设置搜索词和视频实际命中词：

```json
{
  "label": "seedance2.0",
  "queries": ["seedance2.0", "Seedance 2.0", "Seedance2.0"],
  "matchTerms": ["seedance2.0", "Seedance 2.0", "Seedance2.0"],
  "ambiguous": false,
  "partitionName": "Seedance2.0分区",
  "mergeInto": "AI视频分区"
}
```

- `queries`：用于调用 B站搜索接口，可以配置多个别名。
- `matchTerms`：标题、简介或标签中必须实际出现的词；不填写时默认使用 `queries`。
- `ambiguous`：设为 `true` 时，命中词还必须同时出现 AI 上下文，适合 `AI`、`MJ`、`discord` 等歧义词。
- `enabled`：设为 `false` 可暂停该关键词组；省略时默认启用。停用后，只命中该组的历史视频也不会继续出现在当前飞书结果中。
- `partitionName`：该关键词达到独立分区门槛时使用的工作表名称。
- `mergeInto`：不足门槛时并入的相关关键词组或相关分区名称。

`partitioning.minStandaloneVideos` 控制独立分区门槛，默认是 50 条：

```json
{
  "minStandaloneVideos": 50,
  "fallbackPartition": "其他AI"
}
```

达到 50 条的关键词自动使用自己的 `partitionName`；不足 50 条时自动并入 `mergeInto` 指定的相关分区。同一视频可以进入多个分区。修改规则后，历史视频会依据 SQLite 中已有的关键词记录立即重新分类，无需重新抓取。

## 同步到飞书电子表格

飞书同步直接从 SQLite 读取达标视频，再通过飞书开放平台 API 写入目标工作表，不读取或上传本地 Excel。它会按“首次收集时间”倒序覆盖主工作表，最新收集的视频始终位于表头下方，并按照动态分区规则自动创建、复用或清理分区工作表。字段包括 BV号、直链、标题、内容分区、播放量、发布时间、UP主、B站分区、关键词组、实际命中关键词、首次收集时间、最近检查时间和相关性依据。

1. 在飞书开放平台创建企业自建应用，开通“查看、评论、编辑和管理电子表格”权限。
2. 新建一个空白的普通飞书电子表格（链接必须包含 `/sheets/`，不是 `/base/` 多维表格），并把该应用添加为可编辑的文档应用或协作者。
3. 运行本地配置脚本；App Secret 会隐藏输入并只保存在被 Git 忽略的 `data\feishu-config.json`：

```powershell
.\scripts\configure-feishu.ps1
```

本地预览排序结果，不访问飞书：

```powershell
& $node --no-warnings .\app.mjs feishu preview
```

检查授权或手动同步：

```powershell
& $node --no-warnings .\app.mjs feishu doctor
& $node --no-warnings .\app.mjs feishu sync
```

当 `enabled` 为 `true` 时，每次 `cycle` 完成后会自动同步一次。飞书同步失败不会删除本地 SQLite 数据。`config.json` 中的 `excelExportAfterScan` 默认关闭，因此自动采集不会生成 Excel 中转文件；Excel 仅在手动执行 `export` 命令时生成。

## 数据与隐私

仓库不包含本机数据库、运行日志、Excel 结果、飞书密钥或 Cookie。采集器仅访问 B站公开搜索接口，并遵守保守的单线程请求间隔；接口异常时保留本地断点。

## License

MIT
