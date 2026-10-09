param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExecutable = if ($nodeCommand) { $nodeCommand.Source } elseif (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { throw 'Please install Node.js 24 or later.' }
$version = & $nodeExecutable -p 'Number(process.versions.node.split(".")[0])'
if ([int]$version -lt 24) { throw 'Node.js 24 or later is required.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@larksuiteoapi\node-sdk'))) { throw 'Dependencies are missing. In this folder, run npm install, then start again.' }
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'tools\crawler\node_modules\@crawlee\basic'))) { throw 'Crawlee is missing. In this folder, run npm ci --prefix tools/crawler --ignore-scripts, then start again.' }
$mikuPort = if ($env:MIKU_PORT) { [int]$env:MIKU_PORT } else { 17839 }
$url = 'http://127.0.0.1:' + $mikuPort
$alreadyRunning = $false
try { $health = Invoke-RestMethod -Uri ($url + '/health') -TimeoutSec 2; $alreadyRunning = $health.app -eq 'miku-local' } catch { }
if (-not $alreadyRunning) {
  $dataDir = Join-Path $projectRoot 'data'
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $serverEntry = Join-Path $projectRoot 'src\server.mjs'
  $process = Start-Process -FilePath $nodeExecutable -ArgumentList ('--env-file-if-exists=.env "' + $serverEntry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') -PassThru
  $process.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')
  for ($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 300
    try { $health = Invoke-RestMethod -Uri ($url + '/health') -TimeoutSec 1; if ($health.app -eq 'miku-local') { $alreadyRunning = $true; break } } catch { }
    if ($process.HasExited) { break }
  }
}
if (-not $alreadyRunning) { throw ('Unable to start. Check ' + (Join-Path $projectRoot 'data\server-error.log')) }
if (-not $NoBrowser) { Start-Process $url }
Write-Output ('Miku is running: ' + $url)
