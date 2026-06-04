# Freeze Discord version — blocks auto-update by denying NEW-folder creation
# in %LOCALAPPDATA%\Discord. Squirrel installs each update as a fresh
# app-<version> folder there; deny "create folders" and the install can't land,
# so Discord keeps launching the current (modded) version.
#
# - Does NOT block file writes (installer.db / logs / Update.exe relaunch still work).
# - Only blocks creating sub-directories directly under \Discord.
# - Reversible with unfreeze-version.ps1.
#
# To update on purpose: run unfreeze -> launch Discord (let it update) ->
#   node install.js  -> run freeze again.

$dir = Join-Path $env:LOCALAPPDATA 'Discord'
if (-not (Test-Path $dir)) { Write-Error "Not found: $dir"; exit 1 }

$user = "$env:USERDOMAIN\$env:USERNAME"
# (AD) = AppendData/CreateDirectories. No (OI)(CI) = applies to THIS folder only.
icacls $dir /deny "${user}:(AD)"
if ($LASTEXITCODE -ne 0) { Write-Error "icacls failed ($LASTEXITCODE)"; exit 1 }

Write-Host ""
Write-Host "FROZEN: '$user' can no longer create new app-<version> folders in $dir" -ForegroundColor Green
Write-Host "Discord auto-update is now blocked. Run unfreeze-version.ps1 to update later." -ForegroundColor Green
