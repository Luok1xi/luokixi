param(
    [string]$Owner = 'luokixi-owner',
    [switch]$WithoutDeepSeek,
    [switch]$Disable
)
$ErrorActionPreference = 'Stop'
$studioCandidates = @(
    (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE 'Documents\Codex\tools\scrapling\.venv\Scripts\python.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe')
)
$studioPython = $studioCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $studioPython) { throw '未找到本机 Python，请按 campus/HUB_SETUP.md 安装依赖。' }
$studioArguments = @((Join-Path $PSScriptRoot 'manage_hub.py'), 'hub_studio_setup', '--owner', $Owner)
if ($WithoutDeepSeek) { $studioArguments += '--without-deepseek' }
if ($Disable) { $studioArguments += '--disable' }
& $studioPython @studioArguments
if ($LASTEXITCODE -ne 0) { throw '配置未完成。请按照提示修正；不要把密钥发进聊天。' }
Write-Output '配置完成。已运行的工作室 worker 将在下一项工作读取新配置。'
