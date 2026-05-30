# Syntax-gate. ALWAYS run before restarting Discord. Exits non-zero on any error.
# Usage:  pwsh tools/check.ps1   (or)  & tools\check.ps1
$ErrorActionPreference = "Stop"
$files = @(
  "E:\DiscordMod\src\renderer\renderer.js",
  "E:\DiscordMod\install.js",
  "E:\DiscordMod\uninstall.js"
)
$failed = $false
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host "MISSING $f" -ForegroundColor Red; $failed = $true; continue }
  & node --check $f
  if ($LASTEXITCODE -ne 0) { Write-Host "SYNTAX FAIL: $f" -ForegroundColor Red; $failed = $true }
  else { Write-Host "ok: $f" -ForegroundColor Green }
}
if ($failed) { Write-Host "CHECK FAILED - do NOT restart until fixed." -ForegroundColor Red; exit 1 }
Write-Host "CHECK OK" -ForegroundColor Green
