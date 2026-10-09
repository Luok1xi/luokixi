param([switch]$NoBrowser)
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
if (-not $runtime) { throw '未找到 Python 运行环境，请按 campus/README.md 安装。' }
Push-Location -LiteralPath $siteRoot
try {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    $npmPath = if ($npm) { $npm.Source } else { 'D:\Program Files\nodejs\npm.cmd' }
    if (-not (Test-Path -LiteralPath $npmPath)) { throw '需要安装 Node.js 后构建网页。' }
    # Keep the user's original character art; import it before building static assets.
    $characterArt = [System.IO.Path]::GetFullPath((Join-Path $siteRoot 'public\art\beikuang'))
    $publicArt = [System.IO.Path]::GetFullPath((Join-Path $siteRoot 'public\art')) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $characterArt.StartsWith($publicArt, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Character asset target escaped the project.'
    }
    New-Item -ItemType Directory -Path $characterArt -Force | Out-Null
    $characterSources = @{
        'avatar.png' = 'F856DF5E-9E23-4B76-B77D-ADCF0D585965.png'
        'neutral.png' = '473539ED-7E2A-4B41-BEE9-91168028A5D6.PNG'
        'surprised.png' = 'CCCC1DA5-5772-493B-93B8-5BD739433244.PNG'
        'serious.png' = 'FBC300D0-2D60-4B0D-8DC2-A0D3A1A1D2CC.PNG'
        'happy.png' = '781F86F3-97B5-4248-B19B-BC8C86DF6FB8.PNG'
        'awkward.png' = '25844F7D-C7C7-4924-B82F-D5D67AD7C584.PNG'
        'pouting.png' = '2D532559-0C39-4399-865A-BC5E51713701.PNG'
    }
    foreach ($asset in $characterSources.GetEnumerator()) {
        $assetSource = Join-Path (Join-Path $env:USERPROFILE 'Downloads') $asset.Value
        $assetTarget = Join-Path $characterArt $asset.Key
        if (Test-Path -LiteralPath $assetSource) {
            if (-not (Test-Path -LiteralPath $assetTarget) -or
                (Get-FileHash -LiteralPath $assetSource).Hash -ne (Get-FileHash -LiteralPath $assetTarget).Hash) {
                Copy-Item -LiteralPath $assetSource -Destination $assetTarget -Force
            }
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $characterArt 'avatar.png'))) {
        throw 'The supplied Beikuang avatar is missing from Downloads and public/art/beikuang.'
    }
    # Regression checks run in isolation before the live service is reloaded.
    if ($env:LUOKIXI_REPAIR_CHECKS -ne '0') {
    # Acceptance uses an isolated directory; no live users, messages or model quota.
    $liveHubDataDir = $env:HUB_DATA_DIR
    $testHubDataDir = Join-Path $realDataDir ('chat-repair-test-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testHubDataDir -Force | Out-Null
    $savedErrorPreference = $ErrorActionPreference
    $testExitCode = -1
    try {
        $env:HUB_DATA_DIR = $testHubDataDir
        # Django prints normal progress to stderr; Windows PowerShell wraps it as
        # NativeCommandError. Judge the process exit code, not the output stream.
        $ErrorActionPreference = 'Continue'
        & $runtime (Join-Path $PSScriptRoot 'manage_hub.py') test hub.test_studio_recovery hub.test_companion_codex hub.test_companion_controls hub.test_companion_bridge hub.test_beikuang hub.test_beikuang_tools hub.test_beikuang_dialogue hub.test_question_robot hub.test_studio hub.test_robot_actions hub.test_content_pipeline --noinput 2>&1 | Out-File -FilePath (Join-Path $realDataDir 'chat-repair-tests.log') -Encoding utf8
        $testExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorPreference
        $env:HUB_DATA_DIR = $liveHubDataDir
    }
    if ($testExitCode -ne 0) { throw 'Chat repair checks failed. See campus/.data/chat-repair-tests.log; existing services were not stopped.' }
    }
    $changedPython = @('run_hub.py', 'hub\beikuang.py', 'hub\question_robot.py', 'hub\question_api.py',
        'hub\question_university_sources.py', 'hub\studio_config.py', 'hub\worker.py', 'hub\operations.py',
        'hub\github_guides.py', 'hub\project_summaries.py', 'hub\accounts.py', 'hub\studio_worker.py', 'hub\beikuang_tools.py', 'hub\codex_chat.py', 'hub\beikuang_dialogue.py', 'hub\beikuang_memory.py', 'hub\beikuang_turns.py', 'hub\studio_providers.py', 'hub\companion_bridge.py')
    $compilePaths = @($changedPython | ForEach-Object { Join-Path $PSScriptRoot $_ })
    & $runtime -m py_compile @compilePaths
    if ($LASTEXITCODE -ne 0) { throw 'Python syntax validation failed; existing services were not stopped.' }
    $nodePath = Join-Path (Split-Path -Parent $npmPath) 'node.exe'
    & $nodePath (Join-Path $PSScriptRoot 'companion\export-character.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Character card export failed; existing services were not stopped.' }
    & $nodePath (Join-Path $PSScriptRoot 'companion\export-stickers.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Original sticker export failed; existing services were not stopped.' }
    & $npmPath run build
    if ($LASTEXITCODE -ne 0) { throw '网站构建未通过。' }
    $dataDir = Join-Path $PSScriptRoot '.data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $hubReady = $false
    $hubReviewMode = $false
    $health = $null
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 2 } catch {}
    $hubReady = $health -and $health.version -eq '2.0' -and $health.beikuangChatVersion -eq 34
    if ($health -and $health.version -eq '2.0' -and -not $hubReady) {
            # Reload only this repository's community service after the chat repair.
            $hubScriptPath = Join-Path $PSScriptRoot 'run_hub.py'
            $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 17861 -ErrorAction SilentlyContinue)
            foreach ($processId in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
                $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
                if (-not $existing -or $existing.CommandLine -notmatch [regex]::Escape($hubScriptPath)) {
                    throw 'Port 17861 belongs to another program; restart cancelled.'
                }
                $hubReviewMode = $hubReviewMode -or ($existing.CommandLine -match '--review-mode')
                Stop-Process -Id $processId -ErrorAction Stop
            }
    }
    if (-not $hubReady) {
        $hubScript = Join-Path $PSScriptRoot 'run_hub.py'
        $hubArguments = @('-u', ('"' + $hubScript + '"'))
        if ($hubReviewMode) { $hubArguments += '--review-mode' }
        Start-Process -FilePath $runtime -ArgumentList $hubArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'hub.log') -RedirectStandardError (Join-Path $dataDir 'hub-error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 300
            try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17861/api/hub/health' -TimeoutSec 1; if ($health.version -eq '2.0' -and $health.beikuangChatVersion -eq 34) { $hubReady = $true; break } } catch {}
        }
    }
    if (-not $hubReady) { throw '社区服务未启动，请检查 campus/.data/hub-error.log 并安装 hub-requirements.txt。' }
    & $runtime (Join-Path $PSScriptRoot 'prepare_codex_companion.py')
    if ($LASTEXITCODE -ne 0) {throw 'Codex companion configuration failed.'}
    # Run the imported original companion beside the website, with the same private data on every start.
    $companionHost = Join-Path $PSScriptRoot 'companion\website-host.mjs'
    $companionReady = $false
    try { $companionHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17862/health' -TimeoutSec 2; $companionReady = $companionHealth.engine -eq 'campus-companion' -and $companionHealth.bridgeVersion -eq 28 } catch {}
    if ($companionHealth -and $companionHealth.engine -eq 'campus-companion' -and -not $companionReady) {
        foreach ($processId in (@(Get-NetTCPConnection -State Listen -LocalPort 17862 -ErrorAction SilentlyContinue) | Select-Object -ExpandProperty OwningProcess -Unique)) {
            $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
            if (-not $existing -or $existing.CommandLine -notmatch [regex]::Escape($companionHost)) { throw 'Companion port belongs to another program; reload cancelled.' }
            Stop-Process -Id $processId -ErrorAction Stop
        }
    }
    if (-not $companionReady) {
        $occupied = @(Get-NetTCPConnection -State Listen -LocalPort 17862,17839 -ErrorAction SilentlyContinue)
        if ($occupied.Count) { throw 'Companion ports are occupied. Existing processes were preserved.' }
        $nodePath = Join-Path (Split-Path -Parent $npmPath) 'node.exe'
        Start-Process -FilePath $nodePath -ArgumentList @('"' + $companionHost + '"') -WorkingDirectory (Split-Path -Parent $companionHost) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'companion.log') -RedirectStandardError (Join-Path $dataDir 'companion-error.log') | Out-Null
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 300
            try { $companionHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:17862/health' -TimeoutSec 1; if ($companionHealth.engine -eq 'campus-companion') { $companionReady = $true; break } } catch {}
        }
    }
    if (-not $companionReady) { throw 'Original companion did not start; inspect campus/.data/companion-error.log.' }
    & (Join-Path $PSScriptRoot 'start-codex-companion.ps1') -NodePath $nodePath
    & (Join-Path $PSScriptRoot 'start-voice.ps1') -NoWait
    $ready = $false
    try { $health = Invoke-RestMethod -Uri 'http://127.0.0.1:17860/api/health' -TimeoutSec 2; $ready = $health.app -eq 'cumtb-campus-library' -and $health.libraryPipelineVersion -eq 3 } catch {}
    if (-not $ready) {
        foreach ($processId in (@(Get-NetTCPConnection -State Listen -LocalPort 17860 -ErrorAction SilentlyContinue) | Select-Object -ExpandProperty OwningProcess -Unique)) {
            $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
            if ($existing.CommandLine -notlike "*$PSScriptRoot*server.py*") { throw 'Port 17860 belongs to another application; it was not stopped.' }
            Stop-Process -Id $processId -ErrorAction Stop
        }
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
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:17860/' }
} finally { Pop-Location }
