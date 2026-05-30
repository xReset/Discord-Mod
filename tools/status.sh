#!/usr/bin/env bash
# DCMod log status — prints the signal lines, skips noise. Usage: tools/status.sh [tailN]
L="E:/DiscordMod/logs/discord-console.log"
N="${1:-25}"
grep -E "DCMod\] (dispatcher hook|dispatcher found|flux candidates|cand\[|action type=|hookOutgoingDeletes|deleteMessage|UI installed|removeLocal|transform|ready|gave up|searching|capture|diag dispatcher|interceptor error|wrap error|scan threw|perf )" "$L" 2>/dev/null | tail -"$N"
