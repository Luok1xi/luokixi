$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot 'data\server.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No launcher-owned process found.'; exit }
$mikuPid = [int](Get-Content -LiteralPath $pidFile)
$processInfo = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $mikuPid)
$expectedEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'src\server.mjs'))
if ($processInfo -and $processInfo.Name -eq 'node.exe' -and $processInfo.CommandLine.Contains($expectedEntry)) {
  [Diagnostics.Process]::GetProcessById($mikuPid).Kill()
  Remove-Item -LiteralPath $pidFile
  Write-Output 'Miku stopped. Scheduled reminders are paused.'
} else { Write-Output 'Recorded process does not match Miku; nothing was stopped.' }
