param(
    [string]$AppId,
    [string]$SheetUrl,
    [switch]$SkipDoctor
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $projectRoot 'data'
$configPath = Join-Path $dataDir 'feishu-config.json'
$nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$appPath = Join-Path $projectRoot 'app.mjs'

if (-not $AppId) { $AppId = Read-Host 'Feishu App ID' }
if (-not $SheetUrl) { $SheetUrl = Read-Host 'Feishu spreadsheet URL' }
if (-not $AppId -or -not $SheetUrl) { throw 'App ID and spreadsheet URL are required.' }

$secureSecret = Read-Host 'Feishu App Secret (input is hidden)' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
    $appSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    if (-not $appSecret) { throw 'App Secret is required.' }
    $config = [ordered]@{
        enabled = $true
        app_id = $AppId.Trim()
        app_secret = $appSecret
        sheet_url = $SheetUrl.Trim()
        batch_rows = 200
        clear_until_row = 20000
    }
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $json = $config | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, $json, [Text.UTF8Encoding]::new($false))
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
}

Write-Host "Feishu configuration saved locally: $configPath"
Write-Host 'This file is ignored by Git and will not be uploaded.'

if (-not $SkipDoctor) {
    & $nodePath --no-warnings $appPath feishu doctor
    if ($LASTEXITCODE -ne 0) {
        throw 'Feishu doctor failed. Check app permissions and add the app as an editor of the spreadsheet.'
    }
}
