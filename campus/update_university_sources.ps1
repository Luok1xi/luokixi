param(
    [switch]$Offline,
    [int]$MaxSources = 6,
    [int]$MaxDownloads = 8,
    [int]$MaxExtractions = 24
)
$ErrorActionPreference = 'Stop'
$siteRoot = Split-Path -Parent $PSScriptRoot
$runtimeCandidates = @(
    $env:LUOKIXI_PYTHON,
    (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'),
    (Join-Path $siteRoot '.venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE 'Documents\Codex\Python312\python.exe')
)
$runtime = $runtimeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $runtime) {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) { $runtime = $pythonCommand.Source }
}
if (-not $runtime) { throw '需要 Python 3.11 或更高版本。可用 LUOKIXI_PYTHON 指定已有运行环境。' }
if ($Offline) {
    & $runtime (Join-Path $PSScriptRoot 'university_sources_robot.py') --reclassify-only --reextract --max-extractions $MaxExtractions
} else {
    & $runtime (Join-Path $PSScriptRoot 'university_sources_robot.py') --download --max-sources $MaxSources --max-downloads $MaxDownloads --max-extractions $MaxExtractions
}
if ($LASTEXITCODE -ne 0) { throw '本批采集未完成，请查看 university-sources.json 的 failures 记录；已完成进度已保留。' }
