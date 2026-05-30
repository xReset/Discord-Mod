#!/usr/bin/env bash
# Block until the mod boots (ready) or gives up, then print the signal lines.
# Run it in the BACKGROUND (it polls up to ~3min) so you're notified on completion:
#   Bash tool with run_in_background: true
# Usage: bash tools/wait-ready.sh [maxPolls]
L="E:/DiscordMod/logs/discord-console.log"
MAX="${1:-90}"   # 90 * 2s = 3 min
for i in $(seq 1 "$MAX"); do
  if grep -qE "ready ✓|gave up waiting" "$L" 2>/dev/null; then break; fi
  sleep 2
done
echo "=== DCMod boot status ==="
grep -E "DCMod\] (Function.prototype.m|dispatcher hook|dispatcher found|hookOutgoingDeletes|deleteMessage|UI installed|ready|gave up|interceptor error|wrap error|scan threw)" "$L" 2>/dev/null | tail -15
if ! grep -qE "ready ✓" "$L" 2>/dev/null; then
  echo "!!! NOT READY — mod did not finish booting. Check the lines above for errors."
fi
