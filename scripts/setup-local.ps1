$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$nodePath = Join-Path $runtimeRoot 'bin\node.exe'
$dependencyPath = Join-Path $runtimeRoot 'node_modules'
if (-not (Test-Path -LiteralPath $nodePath) -or -not (Test-Path -LiteralPath $dependencyPath)) {
    throw '未找到 Codex 随附 Node.js/依赖，请让 Codex 检查本机工作区依赖路径；不要直接启动采集。'
}
$linkPath = Join-Path $projectRoot 'node_modules'
if (-not (Test-Path -LiteralPath $linkPath)) {
    New-Item -ItemType Junction -Path $linkPath -Target $dependencyPath | Out-Null
}
& $nodePath --no-warnings (Join-Path $projectRoot 'app.mjs') doctor
if ($LASTEXITCODE -ne 0) { throw '本地检查失败，请先修复环境。' }
Write-Host '仅完成本地准备；未采集、未写飞书、未安装定时任务。请继续检查 firecrawl --status。'
