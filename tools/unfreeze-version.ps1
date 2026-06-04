# Unfreeze Discord version — removes the deny-rule set by freeze-version.ps1,
# letting Discord auto-update again. Use ONLY when you intend to update:
#   1. .\unfreeze-version.ps1
#   2. Launch Discord, let it update to the new app-<version>.
#   3. Fully quit Discord.
#   4. node install.js   (re-patch the new version)
#   5. .\freeze-version.ps1   (re-block)

$dir = Join-Path $env:LOCALAPPDATA 'Discord'
if (-not (Test-Path $dir)) { Write-Error "Not found: $dir"; exit 1 }

$user = "$env:USERDOMAIN\$env:USERNAME"
icacls $dir /remove:d $user
if ($LASTEXITCODE -ne 0) { Write-Error "icacls failed ($LASTEXITCODE)"; exit 1 }

Write-Host ""
Write-Host "UNFROZEN: deny-rule removed. Discord can auto-update again." -ForegroundColor Yellow
Write-Host "Remember to re-run install.js + freeze-version.ps1 after it updates." -ForegroundColor Yellow
