param([switch]$OpenLogin)
$ErrorActionPreference='Stop'
$napRoot=Join-Path $PSScriptRoot 'napcat-v4.18.28'
$uiFile=Join-Path $napRoot 'config\webui.json'
if (-not (Test-Path -LiteralPath $uiFile)) { throw 'QQ reader has not been configured.' }
$listening=Get-NetTCPConnection -LocalPort 17842 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  $qqPath='D:\Program Files\Tencent\QQNT\QQ.exe'
  if (-not (Test-Path -LiteralPath $qqPath)) { throw 'Configured QQ executable no longer exists.' }
  $env:NAPCAT_PATCH_PACKAGE=Join-Path $napRoot 'qqnt.json'
  $env:NAPCAT_LOAD_PATH=Join-Path $napRoot 'loadNapCat.js'
  $env:NAPCAT_INJECT_PATH=Join-Path $napRoot 'NapCatWinBootHook.dll'
  $process=Start-Process -FilePath (Join-Path $napRoot 'NapCatWinBootMain.exe') -ArgumentList @(('"'+$qqPath+'"'),('"'+$env:NAPCAT_INJECT_PATH+'"')) -WorkingDirectory $napRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $napRoot 'boot-private.log') -RedirectStandardError (Join-Path $napRoot 'boot-private-error.log') -PassThru
  $process.Id | Set-Content -LiteralPath (Join-Path $napRoot 'boot.pid')
}
if ($OpenLogin) {
  $ui=Get-Content -LiteralPath $uiFile -Raw | ConvertFrom-Json
  Start-Process ('http://127.0.0.1:17842/webui?token='+[Uri]::EscapeDataString($ui.token))
}
Write-Output 'QQ reader is starting or already running. Login stays user-controlled.'
