param(
    [switch]$RunInitialBackfill
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$nodePath = Join-Path $runtimeRoot 'bin\node.exe'
$nodeModulesTarget = Join-Path $runtimeRoot 'node_modules'
$nodeModulesLink = Join-Path $projectRoot 'node_modules'
$appPath = Join-Path $projectRoot 'app.mjs'
$taskNames = @('BVCollector-Incremental','BVCollector-Daily','BVCollector-Weekly')
$existingEnabled = @{}
foreach ($taskName in $taskNames) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $existingTask) {
        $existingEnabled[$taskName] = [bool]$existingTask.Settings.Enabled
    }
}

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "Codex Node.js runtime not found: $nodePath"
}
if (-not (Test-Path -LiteralPath $nodeModulesTarget)) {
    throw "Codex Node.js dependencies not found: $nodeModulesTarget"
}
if (-not (Test-Path -LiteralPath $nodeModulesLink)) {
    New-Item -ItemType Junction -Path $nodeModulesLink -Target $nodeModulesTarget | Out-Null
}

& $nodePath --no-warnings $appPath doctor
if ($LASTEXITCODE -ne 0) { throw 'Doctor check failed. Scheduled tasks were not installed.' }

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 6 `
    -RestartInterval (New-TimeSpan -Minutes 30) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 10)

function Register-BVTask {
    param(
        [string]$TaskName,
        [string[]]$TaskArguments,
        [Microsoft.Management.Infrastructure.CimInstance]$Trigger,
        [string]$Description
    )
    $argumentText = '--no-warnings "' + $appPath + '" ' + ($TaskArguments -join ' ')
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument $argumentText -WorkingDirectory $projectRoot
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $Trigger -Principal $principal -Settings $settings -Description $Description -Force | Out-Null
}

$incrementalTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(12) `
    -RepetitionInterval (New-TimeSpan -Hours 12) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At '03:30'
$weeklyTrigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '09:00'

Register-BVTask -TaskName 'BVCollector-Incremental' -TaskArguments @('cycle') -Trigger $incrementalTrigger -Description 'Collect new videos and resume a bounded initial backfill batch every 12 hours.'
Register-BVTask -TaskName 'BVCollector-Daily' -TaskArguments @('scan', '--mode', 'full', '--max-units', '3') -Trigger $dailyTrigger -Description 'Resume up to three rolling 90-day backfill units every day.'
Register-BVTask -TaskName 'BVCollector-Weekly' -TaskArguments @('export', '--scope', 'weekly') -Trigger $weeklyTrigger -Description 'Export the previous completed week every Monday.'

foreach ($taskName in $taskNames) {
    if ($existingEnabled.ContainsKey($taskName) -and -not $existingEnabled[$taskName]) {
        Disable-ScheduledTask -TaskName $taskName | Out-Null
    }
}

Get-ScheduledTask -TaskName 'BVCollector-Incremental','BVCollector-Daily','BVCollector-Weekly' |
    Select-Object TaskName, State, Description |
    Format-Table -AutoSize

if ($RunInitialBackfill) {
    & $nodePath --no-warnings $appPath scan --mode full --qa
    if ($LASTEXITCODE -ne 0) { throw 'Initial 90-day backfill failed. Tasks remain installed for retry.' }
}
