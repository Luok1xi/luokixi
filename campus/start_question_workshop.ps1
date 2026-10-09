$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
# These desktop launchers always use the real project data, never inherited test paths.
$realDataDir = Join-Path $PSScriptRoot '.data'
if (-not (Test-Path -LiteralPath (Join-Path $realDataDir 'library.sqlite3'))) {
    throw 'The real library database is missing. Startup stopped to avoid creating an empty library.'
}
if (-not (Test-Path -LiteralPath (Join-Path $realDataDir 'hub\community.sqlite3'))) {
    throw 'The real community database is missing. Startup stopped; no empty replacement was created.'
}
$env:CAMPUS_DATA_DIR = $realDataDir
$env:HUB_DATA_DIR = Join-Path $realDataDir 'hub'
$env:CAMPUS_STATIC_DIR = Join-Path $siteRoot 'dist'
$env:CAMPUS_HUB_PORT = '17861'
$env:HUB_PUBLIC_ORIGIN = 'http://127.0.0.1:17860'
$runtimeCandidates = @($env:LUOKIXI_PYTHON, (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'), (Join-Path $siteRoot '.venv\Scripts\python.exe'), (Join-Path $env:USERPROFILE 'Documents\Codex\Python312\python.exe'))
$runtime = $runtimeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $runtime) { $runtime = (Get-Command python -ErrorAction Stop).Source }
if (-not (Test-Path -LiteralPath (Join-Path $siteRoot 'dist\question-workshop.html'))) { throw 'Build the website with npm run build first.' }
$dataDir = Join-Path $PSScriptRoot '.data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
foreach ($service in @(@{Port=17860;Script='server.py'}, @{Port=17861;Script='run_hub.py'})) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $service.Port -ErrorAction SilentlyContinue)
    foreach ($processId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
        $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
        $exactScript = Join-Path $PSScriptRoot $service.Script
        if (-not $existing -or $existing.CommandLine -notmatch [regex]::Escape($exactScript)) {
            throw "Port $($service.Port) is in use. This launcher will only restart the exact Luokixi script: $exactScript"
        }
        Stop-Process -Id $processId -ErrorAction Stop
    }
}
$hubScript = Join-Path $PSScriptRoot 'run_hub.py'
$frontScript = Join-Path $PSScriptRoot 'server.py'
Start-Process -FilePath $runtime -ArgumentList @('-u', ('"' + $hubScript + '"'), '--port', '17861', '--review-mode') -WorkingDirectory $siteRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'hub.log') -RedirectStandardError (Join-Path $dataDir 'hub-error.log') | Out-Null
Start-Process -FilePath $runtime -ArgumentList @('-u', ('"' + $frontScript + '"'), '--port', '17860') -WorkingDirectory $siteRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
$ready = $false
for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try {
        $front = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/api/health' -TimeoutSec 2
        $hub = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 2
        if ($front.app -eq 'cumtb-campus-library' -and $hub.version -eq '2.0') { $ready=$true; break }
    } catch {}
}
if (-not $ready) { throw 'Could not start Luokixi. Check campus/.data/server-error.log and hub-error.log.' }
Start-Process 'http://127.0.0.1:17860/question-workshop.html#qw-university'
