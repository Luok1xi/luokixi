param([switch]$NoWait)
$ErrorActionPreference = 'Stop'
$voiceRoot = Join-Path $PSScriptRoot '.data\voice-runtime'
$engine = Join-Path $voiceRoot 'engine\GPT-SoVITS-v2pro-20250604-nvidia50'
$python = Join-Path $engine 'runtime\python.exe'
$profiles = Join-Path $PSScriptRoot '.data\voices\profiles.json'
if (-not (Test-Path -LiteralPath $python) -or -not (Test-Path -LiteralPath $profiles)) { return }
try {
    $health = Invoke-RestMethod 'http://127.0.0.1:17863/luokixi-health' -TimeoutSec 2
    if ($health.app -eq 'luokixi-character-voice') { return }
} catch {}
if (Get-NetTCPConnection -LocalPort 17863 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Voice port 17863 belongs to a different service.'
}
$env:PYTHONIOENCODING = 'utf-8'
$env:TORCH_FORCE_WEIGHTS_ONLY_LOAD = '1'
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$oldPath = $env:PATH
try {
    $env:PATH = (Join-Path $engine 'runtime') + ';' + $oldPath
    Start-Process -FilePath $python -ArgumentList @('-u', ('"' + (Join-Path $PSScriptRoot 'run_character_voice.py') + '"')) -WorkingDirectory $engine -WindowStyle Hidden -RedirectStandardOutput (Join-Path $voiceRoot 'voice.log') -RedirectStandardError (Join-Path $voiceRoot 'voice-error.log') | Out-Null
} finally { $env:PATH = $oldPath }
if (-not $NoWait) {
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        Start-Sleep -Milliseconds 500
        try { $health = Invoke-RestMethod 'http://127.0.0.1:17863/luokixi-health' -TimeoutSec 1; if ($health.app -eq 'luokixi-character-voice') { return } } catch {}
    }
    Write-Warning 'Character voice is still warming up. See campus/.data/voice-runtime/voice-error.log.'
}
