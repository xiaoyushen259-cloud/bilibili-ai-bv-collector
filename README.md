# Bilibili AI BV Collector

收集近滚动 90 天、播放量严格超过 1 万的 AI 相关 B站视频 BV号。默认顺序：**Firecrawl → B站移动端搜索（第二档）→ WBI（第三档）**。上一档服务不可用、结果不足或无法核验时才进入下一档；已经满额则停止。

五个当前分区：Midjourney、ComfyUI、Agent、AI视频、Stable Diffusion。每天每区默认新增 50 条，排除本机历史、已绑定和跨分区重复。MJ、SD 不足时以有趣、恶搞类 AI 成片补位，不用教程冒充趣味成片；补位不代表视频确实使用了 MJ/SD。

## 首次使用：同事上手流程

需要 Windows 10/11、Codex Desktop 随附 Node.js 与工作区依赖，以及已安装并登录的 Firecrawl CLI。仓库不包含个人登录状态、密钥和历史数据。在 Codex 中打开项目目录，先读 AGENTS.md。

### 1. 准备本地依赖，不安装定时任务

在项目目录运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\setup-local.ps1
$node = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
```

此步骤只连接本地依赖并检查环境，不采集、不写飞书。若随附运行时路径不存在，让 Codex 定位本机工作区依赖，不要复制别人电脑的 node_modules。

### 2. 先检查 Firecrawl，不要直接启动旧 WBI 扫描

未安装时按 [Firecrawl 官方 CLI 说明](https://docs.firecrawl.dev/sdks/cli)安装。以下版本用于本项目联调：

```powershell
npm install -g firecrawl-cli@1.16.2
firecrawl login --browser
firecrawl --status
```

Codex 对话还需要 firecrawl-search 技能，可通过 `firecrawl setup skills` 安装。程序通过 CLI 复用登录；只有技能文档不等于 CLI 已安装或账号已登录。

验证程序的真实接入路径：

```powershell
& $node .\app.mjs firecrawl-check
```

这只做一次搜索和正文抓取，消耗少量 Firecrawl 额度，保存证据但不写数据库或飞书。doctor 中 cliAvailable 仅证明 CLI 可执行，不保证登录和额度正常。

### 3. 交接去重历史

新下载的仓库没有旧 BV。正式采集前，由负责人停止采集进程后使用 SQLite 备份方式交接一致的 collector.sqlite，或另行迁移历史数据。运行中的 WAL 数据库不能只拷贝主文件。

绑定成功名单支持 CSV、TXT、JSON：

```powershell
& $node .\scripts\import-binding-history.mjs --file .\绑定成功.csv
```

CSV 推荐列为 bvid,courseName,batchLabel。绑定名单不等于全部采集历史，两者都要保留。不要发送含飞书密钥的整个 data 文件夹，不要让多台电脑通过同步盘共同写 SQLite。同一飞书表指定一台采集机发布。

### 4. 小批量试跑，再补到每区 50 条

先每区 5 条，最多 5 次 Firecrawl 搜索，不回退移动端或 WBI、不写飞书：

```powershell
& $node .\app.mjs collect --target 5 --max-searches 5 --no-mobile --no-wbi
```

正式补齐当天每区 50 条，然后预览：

```powershell
& $node .\app.mjs collect
& $node .\app.mjs feishu preview
```

当天重复运行续补同一批次，从 5 提升到 50 时保留已有 5 条；不能把目标降低到当天已收集数量以下。第二天新建批次，旧 BV 继续参与排重。

默认每次最多 20 次 Firecrawl 搜索，每次最多 20 个正文结果；第二档移动端最多 60 次 HTTP 请求（含搜索和逐条详情核验），仍不足才进入第三档，最多 20 次 WBI 搜索。两档 B站搜索每词最多 3 页。用 --max-searches、--max-mobile-requests、--max-wbi-requests 调整各档预算。--no-mobile 只禁用移动端，--no-wbi 只禁用 WBI；仅用 Firecrawl 时两个开关都要带。预算不是数量保证，未达标数量会如实报告。

第二档沿用历史 Mobile Search 的无签名搜索接口与移动网页发现路径，但搜索页的近似播放量不计入：逐条使用视频详情接口取得精确数据，并在 data/.mobile-search 保存证据。当天分页进度与已核验新增 BV 一起保留，重复运行继续补齐。

日常批次的移动端与 WBI 使用 `courseFillRequestDelayMinMs/MaxMs` 和 `courseFillHeavyRequestCount/CooldownMs`：默认请求间隔 5～8 秒、每 10 次请求休息 60 秒，不再套用旧全量扫描的 30～45 秒及每 6 次休息 10 分钟。两档仍共享持久化请求计数和时间；日志区分正常批量休息与风控冷却。旧 `scan --provider wbi` 保持原来的保守扫描节奏，旧 `fill-courses --provider wbi` 继续使用补齐节奏。

升级不会清除已经触发的 412/429/验证冷却。程序在启动时读取配置，正在运行的任务不会自动加速；待当前任务安全结束并释放锁后，更新代码，再运行 collect 续补当天批次。上述时间只是请求间隔，不是收齐 50 条的耗时保证；Firecrawl 超时、网络和合格新候选数量仍会影响速度。

程序核验正文的精确播放量和带时区的发布时间；仅搜索摘要、近似显示或缺少详情的候选不直接入库。日期搜索过滤不能代替逐条核验。

## 飞书配置与发布

先创建空白测试表，使用普通电子表格 /sheets/ 链接，不是 /base/ 多维表格。在飞书开放平台创建企业自建应用，申请电子表格读写权限，并将应用添加为目标表的可编辑协作者。

```powershell
.\scripts\configure-feishu.ps1
& $node .\app.mjs feishu doctor
& $node .\app.mjs feishu preview
& $node .\app.mjs feishu sync
```

也可用 `collect --sync` 在本批完整后发布。未达目标、记录过期或已绑定、跨日未建立新批次时拒绝覆盖。主表与五个分区只放本批，其他本机视频进入历史归档。归档是去重记录，不是待绑定候选；其他旧名称或无关工作表不自动删除。

同步前保存备份，云端若有本机没有的历史 BV 会先停止，要求交接历史数据。写入后读回核验。飞书多表写入不是原子事务；中途失败尝试恢复，恢复不完整时暂停使用远端表，根据 data/feishu-backups 备份人工处理。

默认模式下未建立批次时，feishu preview/sync 会要求先 collect，不会把旧资料库的最近 50 条冒充当天新增。只有 collectionProvider 明确设为 wbi 且不存在新批次时，才保留旧资料库视图兼容行为。

## 旧命令现在的默认行为

config.json 中 collectionProvider 默认 firecrawl。collect、scan --mode full、scan --mode incremental、fill-courses、cycle 都进入同一个当天批次流程。截图或旧教程里的 scan 命令不再默认绕过 Firecrawl。

默认模式下 --mode 不再选择旧时间片，--max-units 不控制 Firecrawl；使用 --max-searches 控制预算。scan/collect 默认不写飞书；cycle/fill-courses 仅在本批完整且已启用飞书自动同步时发布。

仅维护旧 WBI 断点扫描时显式运行：

```powershell
& $node .\app.mjs scan --mode full --provider wbi
```

旧模式不是当天新增 50 条流程。移动端和 WBI 共用跨进程限速、412/429/v_voucher 冷却：首次至少 12 小时，48 小时内再次触发为 24 小时。移动端触发限流后不会继续请求网页或 WBI。不清除冷却、不绕过验证码。第二档已集成到 collect；scripts 下旧 mobile-search/backfill 工具仍不是新人入口。

## 定时任务：可选

手动采集、授权与费用确认后再运行 `.\scripts\install-tasks.ps1`。安装每 12 小时执行 cycle 的 BVCollector-Incremental 和每周一 09:00 导出的 BVCollector-Weekly；卸载用 `.\scripts\uninstall-tasks.ps1`。

现有 cycle 任务升级后也会采用 Firecrawl 优先，可能消耗 Firecrawl 额度。当天已满额则不再搜索。需要电脑开机、联网、用户登录且不休眠；代码升级不会自行安装或启用任务，已有禁用状态在重新安装时保留。

## 配置、数据与维护

- config.json：默认 provider、搜索预算、分区与关键词。queries 用于搜索，matchTerms 用于正文命中，requiredContextTerms 限制歧义，enabled:false 停用，manualOnly:true 不作为普通搜索词。
- data/collector.sqlite：视频历史、绑定名单、批次和 WBI 冷却状态。
- data/.firecrawl/：原始搜索证据；data/feishu-backups/：同步前备份；均不入 Git。
- logs/：采集进度，不记录 Firecrawl 凭证和原始 stderr。

手动导出旧滚动资料库（不是当天批次视图）：

```powershell
& $node .\app.mjs export --scope master
& $node .\app.mjs export --scope weekly
npm test
```

Excel 写入 output/BV号自动采集.xlsx 或 output/周报/；飞书直接从 SQLite 读取，不依赖 Excel。主表当前 BV 只归属一个分区，库中历史关键词命中可有多个。

Firecrawl 使用独立服务额度，Codex 对话使用账户额度；不要把旧 WBI 脚本不调用模型 API 理解成整个流程免费。仓库不包含账号密钥、Cookie 或个人采集数据。

## License

MIT
