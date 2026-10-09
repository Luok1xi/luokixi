param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$campusPath = [IO.Path]::GetFullPath($PSScriptRoot)
$scriptPath = Join-Path $campusPath 'run_hub.py'
$dataPath = Join-Path $campusPath '.data'
$databasePath = Join-Path $dataPath 'hub/community.sqlite3'
if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) { throw 'Existing community database is required.' }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort 17861 -ErrorAction Stop)
$processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($processIds.Count -ne 1) { throw 'Expected exactly one existing community service on port 17861.' }
$currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($processIds[0])"
if (-not $currentProcess -or $currentProcess.CommandLine -notmatch [regex]::Escape($scriptPath)) {
    throw 'Port 17861 does not belong to this repository; nothing was stopped.'
}
$runtimePath = $currentProcess.ExecutablePath
if (-not $runtimePath -or -not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { throw 'Cannot identify the existing Python interpreter.' }
$arguments = @('-u', ('"' + $scriptPath + '"'))
if ($currentProcess.CommandLine -match '(?:^|\s)--review-mode(?:\s|$)') { $arguments += '--review-mode' }
if ($currentProcess.CommandLine -match '(?:^|\s)--no-worker(?:\s|$)') { $arguments += '--no-worker' }
$readOnlyProbe = @'
import json, sqlite3, sys
from pathlib import Path
from urllib.parse import quote
path = Path(sys.argv[1]).resolve()
with sqlite3.connect('file:' + quote(path.as_posix(), safe='/:') + '?mode=ro', uri=True) as connection:
    jobs = connection.execute("select count(*) from hub_job where state='running'").fetchone()[0]
    studio = connection.execute("select count(*) from hub_studiorun where state='running'").fetchone()[0]
print(json.dumps({'runningJobs':jobs,'runningStudioRuns':studio}))
'@
$probe = & $runtimePath -c $readOnlyProbe $databasePath
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect active work; nothing was stopped.' }
$active = $probe | ConvertFrom-Json
$plan = [ordered]@{ apply=[bool]$Apply; port=17861; processId=$currentProcess.ProcessId; runtime=$runtimePath;
    script=$scriptPath; arguments=$arguments; data=$databasePath; active=$active }
$plan | ConvertTo-Json -Depth 4
if (-not $Apply) { return }
if ($active.runningJobs -gt 0 -or $active.runningStudioRuns -gt 0) {
    throw 'The community service has active work. Retry after it finishes; nothing was stopped.'
}
# Match the exact same process again immediately before stopping it.
$verified = Get-CimInstance Win32_Process -Filter "ProcessId=$($currentProcess.ProcessId)"
if (-not $verified -or $verified.CommandLine -ne $currentProcess.CommandLine -or $verified.CreationDate -ne $currentProcess.CreationDate) {
    throw 'The process changed since inspection; restart cancelled.'
}
$savedEnvironment = @{}
$restartEnvironment = @{
    HUB_DATA_DIR=(Join-Path $dataPath 'hub'); CAMPUS_DATA_DIR=$dataPath;
    HUB_PUBLIC_ORIGIN='http://127.0.0.1:17860'; CAMPUS_HUB_PORT='17861'
}
try {
    foreach ($name in $restartEnvironment.Keys) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $restartEnvironment[$name], 'Process')
    }
    Stop-Process -Id $currentProcess.ProcessId -ErrorAction Stop
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $newProcess = Start-Process -FilePath $runtimePath -ArgumentList $arguments -WorkingDirectory $campusPath -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $dataPath "hub-media-$stamp.log") -RedirectStandardError (Join-Path $dataPath "hub-media-$stamp-error.log")
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($newProcess.HasExited) { throw "Community process exited. Inspect hub-media-$stamp-error.log; other services were not stopped." }
        try { $health = Invoke-RestMethod 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 1 } catch { continue }
        if ($health.ok -and $health.version -eq '2.0') {
            [ordered]@{ ready=$true; processId=$newProcess.Id; port=17861; chatVersion=$health.beikuangChatVersion } | ConvertTo-Json
            return
        }
    }
    throw "Community service did not become ready. Inspect hub-media-$stamp-error.log; other services were not stopped."
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
}
