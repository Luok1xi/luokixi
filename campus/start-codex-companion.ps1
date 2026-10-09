param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference='Stop'
$hostFile=Join-Path $PSScriptRoot 'companion\website-host.mjs'
$dataPath=Join-Path $PSScriptRoot '.data'
$health=$null
try {$health=Invoke-RestMethod 'http://127.0.0.1:17864/health' -TimeoutSec 2} catch {}
if ($health -and $health.engine -eq 'campus-companion' -and $health.seat -eq 'codex' -and $health.bridgeVersion -eq 28) {return}
foreach ($processId in (@(Get-NetTCPConnection -LocalPort 17864,17840 -State Listen -ErrorAction SilentlyContinue)|Select-Object -ExpandProperty OwningProcess -Unique)) {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process -or $process.CommandLine -notmatch [regex]::Escape($hostFile) -or $process.CommandLine -notmatch '--codex') {throw 'Codex companion port belongs to another program; preserved.'}
    Stop-Process -Id $processId
}
Start-Process -FilePath $NodePath -ArgumentList @('"'+$hostFile+'"','--codex') -WorkingDirectory (Split-Path -Parent $hostFile) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'codex-companion.log') -RedirectStandardError (Join-Path $dataPath 'codex-companion-error.log') | Out-Null
for ($attempt=0;$attempt -lt 40;$attempt++) {
    Start-Sleep -Milliseconds 300
    try {$health=Invoke-RestMethod 'http://127.0.0.1:17864/health' -TimeoutSec 1;if ($health.seat -eq 'codex' -and $health.bridgeVersion -eq 28) {return}} catch {}
}
throw 'Codex original companion runtime did not start. See campus/.data/codex-companion-error.log.'
