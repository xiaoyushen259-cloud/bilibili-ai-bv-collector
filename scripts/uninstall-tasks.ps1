$ErrorActionPreference = 'Stop'
$taskNames = @('BVCollector-Incremental', 'BVCollector-Daily', 'BVCollector-Weekly')
foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "Removed scheduled task: $taskName"
    }
}
