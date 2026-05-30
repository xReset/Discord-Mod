# Safe iterate: syntax-check renderer, then restart Discord ONLY if check passes.
# Renderer is read fresh by the preload each launch; no reinstall needed for renderer edits.
# (Re-run "node install.js" ONLY when you change the shim: install.js / index.js / preload.js.)
# Usage:  & tools\iterate.ps1
& "E:\DiscordMod\tools\check.ps1"
if ($LASTEXITCODE -ne 0) { Write-Host "Aborting restart - fix syntax first." -ForegroundColor Red; exit 1 }
& "E:\DiscordMod\tools\restart.ps1"
Write-Host ""
Write-Host "Restarted. Wait ~30s for boot, then verify with:" -ForegroundColor Cyan
Write-Host "  bash tools/wait-ready.sh   (blocks until ready/gave-up, prints status)" -ForegroundColor Cyan
Write-Host "  bash tools/status.sh       (signal log lines)" -ForegroundColor Cyan
