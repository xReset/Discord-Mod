# Restart Discord (no -Force; graceful) — renderer is read fresh by preload, no reinstall needed.
Stop-Process -Name Discord -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
& "$env:LOCALAPPDATA\Discord\Update.exe" --processStart Discord.exe
"RESTARTED"
