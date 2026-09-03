# Bilibili AI BV Collector

自动采集最近滚动 90 天内、播放量不少于 1 万且与指定 AI 关键词相关的 B站视频，并为五套课程维护近 90 天的补齐资料库。结果以 BV号去重，保存在 SQLite，并导出为“BV汇总 + 视频明细”Excel。

## 功能

- 每 12 小时由唯一的B站采集任务发现新达标视频，并续扫最多 3 个最近 90 天的历史时间片。
- 按播放量排序扫描，接口达到 1,000 条上限时自动拆分时间窗口。
- 支持 `agent`、`AI`、`Codex`、`Claude Code`、`ComfyUI`、`Midjourney`、`Seedance 2.0` 等关键词及别名。
- 对 `AI`、`MJ`、`discord` 等歧义词使用单词边界和 AI 上下文过滤。
- SQLite 断点续扫、BV号去重、关键词合并、首次达标时间记录。
- 每个时间片独立随机关键词组顺序，同一时间片不重复；组内别名连续扫描，断点恢复时保持原顺序。
- 导出滚动主表和周报 Excel，包含可点击 B站直链。
- 五套课程分表以 50 条为最低目标，低于目标时可用 `fill-courses` 定向补齐，超过 50 条的内容全部保留。
- 使用 WBI 搜索接口、完整浏览器请求头和稳定匿名会话；仅把 `buvid3`、`buvid4` 等非登录标识保存在本机 SQLite，不保存登录 Cookie。
- `412` 限流时延期当前单元并持久化暂停全部B站扫描至少 12 小时；48小时内再次触发则暂停 24 小时。不登录、不绕过验证码。

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

安装脚本会自动定位当前用户目录下的 Codex Node.js 运行时，并创建两个任务：

- `BVCollector-Incremental`：唯一的B站采集任务，每 12 小时增量采集并续跑最多 3 个首次回溯单元。
- `BVCollector-Weekly`：每周一 09:00 导出上周周报。

重新安装时会自动移除旧版的 `BVCollector-Daily`，避免两个任务同时访问B站。

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

B站返回 `412` 或 `v_voucher` 时，当前扫描会保留到“关键词 + 7 天时间片”的断点并立即停止本批B站请求。冷却状态保存在 SQLite，首次触发暂停 12 小时，48 小时内再次触发暂停 24 小时；冷却期间计划任务仍可同步飞书，但会跳过B站请求。热门时间片达到接口 1,000 条上限时仍会自动二分。唯一的B站采集任务每 12 小时先执行增量扫描，再续跑最多 3 个首次回溯单元；周报任务只读取本地数据，不访问B站。

默认请求节奏为所有B站网络请求之间随机等待 30～45 秒、切换关键词等待 90～150 秒、每连续 6 次请求额外冷却 10 分钟。请求计数和上次请求时间会跨进程保存在本机 SQLite，因此计划任务、手动扫描和进程重启不会重置限速。采集器首次运行时通过B站公开匿名指纹接口取得 `buvid3`、`buvid4`，后续复用同一匿名身份；WBI 密钥最多缓存 6 小时。每 12 小时的增量窗口回看 14 小时，保留 2 小时重叠以防边界遗漏。

## 运行消耗与电脑要求

- 采集器不调用 Codex 或 OpenAI API，每次计划任务消耗的 AI Token 为 `0`。
- 运行时只调用 B站公开接口和飞书开放平台接口，并读写本地 SQLite；仅消耗少量网络流量、CPU、内存和磁盘空间。
- 自动采集要求电脑开机、Windows 当前用户已登录、网络可用，并且电脑未处于睡眠或休眠状态。
- 关机、睡眠或断网期间不会采集；恢复运行条件后，任务计划会补跑一次，然后继续按每 12 小时间隔执行。
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
  "label": "ComfyUI-Flux",
  "queries": ["ComfyUI Flux"],
  "matchTerms": ["FLUX.1", "Flux"],
  "requiredContextTerms": ["ComfyUI"],
  "ambiguous": false
}
```

- `queries`：用于调用 B站搜索接口，可以配置多个别名。
- `matchTerms`：标题、简介或标签中必须实际出现的词；不填写时默认使用 `queries`。
- `requiredContextTerms`：配置后，标题、简介或标签还必须至少出现一个课程上下文词；适合过滤 `Flux`、`龙虾`、`Grok` 等容易产生歧义的细分词。
- `ambiguous`：设为 `true` 时，命中词还必须同时出现 AI 上下文，适合 `AI`、`MJ`、`discord` 等歧义词。
- `enabled`：设为 `false` 可暂停该关键词组；省略时默认启用。停用后，只命中该组的历史视频也不会继续出现在当前飞书结果中。
- `legacyLabels`：旧版本使用过的关键词组名称；重新命名后可把 SQLite 中的历史命中统一归入新名称。
- `contentPartitions`：把细分关键词组固定映射到对应课程工作表。
- `managedPartitionNames`：记录旧版创建过的分区名称；同步成功后会删除不再使用的旧工作表。

生产配置固定使用五个课程工作表，不再根据视频数量把细分关键词拆成额外分区：

```json
[
  { "name": "Midjourney", "keywordGroups": ["midjourney", "MJ", "niji"] },
  { "name": "ComfyUI", "keywordGroups": ["comfyui", "ComfyUI-Flux", "ComfyUI-LTX"] },
  { "name": "Agent", "keywordGroups": ["agent", "codex", "coze", "扣子", "Claude Code", "OpenClaw", "龙虾", "MCP"] },
  { "name": "AI视频", "keywordGroups": ["Seedance", "Kling", "Grok视频", "Sora", "Veo"] },
  { "name": "WebUI", "keywordGroups": ["Stable Diffusion WebUI", "AUTOMATIC1111", "Forge"] }
]
```

细分关键词仍保存在“关键词组”和“实际命中关键词”列中，因此可以继续区分课程内的具体课题。同一视频可以进入多个课程分区。修改规则后，已有关键词命中的历史视频会立即重新分类；新增加的细分关键词需要后续扫描才能补齐。

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
& $node --no-warnings .\app.mjs fill-courses
& $node --no-warnings .\scripts\import-binding-history.mjs --file .\绑定成功.csv
```

当 `enabled` 为 `true` 时，每次 `cycle` 完成后会自动同步一次。飞书同步失败不会删除本地 SQLite 数据。`config.json` 中的 `excelExportAfterScan` 默认关闭，因此自动采集不会生成 Excel 中转文件；Excel 仅在手动执行 `export` 命令时生成。

绑定成功名单可用 CSV、TXT 或 JSON 导入。脚本会提取所有合法 BV号并写入永久历史表；之后扫描、定向补齐和飞书当前分区都会自动跳过这些 BV号。CSV 推荐使用 `bvid,courseName,batchLabel` 三列。待绑定分区之间也会全局去重，高风险标题只保留在“历史归档”。

## 数据与隐私

仓库不包含本机数据库、运行日志、Excel 结果、飞书密钥或 Cookie。本机 SQLite 只保存采集数据、限速状态以及 `buvid3`、`buvid4` 等匿名标识，不保存 `SESSDATA` 等登录凭证；该数据库已被 Git 忽略。采集器仅访问B站公开首页、匿名指纹、导航和 WBI 搜索接口，并遵守跨进程单线程限速。接口异常时保留本地断点。

## License

MIT
