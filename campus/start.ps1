$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
$runtimeCandidates = @(
    $env:LUOKIXI_PYTHON,
    (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'),
    (Join-Path $siteRoot '.venv\Scripts\python.exe')
)
$runtime = $runtimeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $runtime) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $runtime = $pythonCommand.Source }
}
if (-not $runtime) { throw '未找到 Python 运行环境，请按 campus/README.md 安装。' }
Push-Location -LiteralPath $siteRoot
try {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $npmPath = if ($npm) { $npm.Source } else { 'D:\Program Files\nodejs\npm.cmd' }
    if (-not (Test-Path -LiteralPath $npmPath)) { throw '需要安装 Node.js 后构建网页。' }
    & $npmPath run build
    if ($LASTEXITCODE -ne 0) { throw '网站构建未通过。' }
    $dataDir = Join-Path $PSScriptRoot '.data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $hubReady = $false
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 2; $hubReady = $health.version -eq '2.0' } catch {}
    if (-not $hubReady) {
        $hubScript = Join-Path $PSScriptRoot 'run_hub.py'
        Start-Process -FilePath $runtime -ArgumentList @('-u', ('"' + $hubScript + '"')) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'hub.log') -RedirectStandardError (Join-Path $dataDir 'hub-error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 300
            try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 1; if ($health.version -eq '2.0') { $hubReady = $true; break } } catch {}
        }
    }
    if (-not $hubReady) { throw '社区服务未启动，请检查 campus/.data/hub-error.log 并安装 hub-requirements.txt。' }
    $ready = $false
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/api/health' -TimeoutSec 2; $ready = $health.app -eq 'cumtb-campus-library' } catch {}
    if (-not $ready) {
        $dataDir = Join-Path $PSScriptRoot '.data'
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        $serverScript = Join-Path $PSScriptRoot 'server.py'
        Start-Process -FilePath $runtime -ArgumentList @('-u', ('"' + $serverScript + '"'), '--port', '17860') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 300
            try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/api/health' -TimeoutSec 1; if ($health.app -eq 'cumtb-campus-library') { $ready = $true; break } } catch {}
        }
    }
    if (-not $ready) { throw '知识库服务未启动，请查看 campus/.data/server-error.log。' }
    Start-Process 'http://127.0.0.1:17860/'
} finally { Pop-Location }
