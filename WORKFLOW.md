# WORKFLOW — how to work in this repo without breaking it

**Read this FIRST, every session — especially if you are a smaller/faster model (Sonnet/Haiku).**
This repo modifies a live Discord client by injecting JS. Mistakes here can log the user out or
break the client. Follow this exactly. When unsure, STOP and ask — do not guess.

## Reading order (do this before touching code)
1. `WORKFLOW.md` (this file) — how to iterate + verify.
2. `AGENT_NOTES.md` — hard-won internals, perf rules, what breaks and why.
3. `PLAN.md` — corrected UX model + the next build plan + undocumented hooks.
4. `DiscordMod.md` / `SELFBOT_AND_CLIENT.md` — overview + feature map. (Skim.)

## The golden rules
1. **Verify EVERY change. No exceptions.** A change is not "done" until you have (a) passed the
   syntax check AND (b) seen it work in the running client via the log (and asked the user to confirm
   visually for UI/behavior). "It should work" is not done.
2. **Surgical edits only.** Touch the minimum. Do NOT refactor, rename, reformat, or "improve"
   nearby code. Match the existing style. The renderer is one long IIFE — keep it that way.
3. **Never force-execute webpack factories** (`wreq(id)` over all of `wreq.m`). It throws and
   corrupts modules. See AGENT_NOTES. Discover via the captured requires + property/code matching.
4. **Guard every global hook** with an idempotency flag (e.g. `MA.__dcmodSendHook`). Boot runs more
   than once (hot-reload reinjects). Un-guarded hooks double-wrap → bugs.
5. **Wrap risky access in try/catch.** Discord exports use throwing getters. One unguarded access
   can abort a whole scan or crash boot (then nothing loads).
6. **Don't break the deleted-message interceptor or the `Function.prototype.m` capture.** They are
   load-bearing. If you must edit near them, re-read AGENT_NOTES first.
7. **Commit only when the user asks.** Always `node --check` before committing.

## The iterate loop (the ONLY safe path)
Renderer edits do NOT need reinstall — the preload reads `src/renderer/renderer.js` fresh each
launch. (Reinstall with `node install.js` ONLY if you change the shim: `install.js` itself, or the
generated `index.js`/`preload.js` strings, or the log filter.)

```
1. Edit src/renderer/renderer.js              (surgical)
2. tools\check.ps1            (or)  node --check src/renderer/renderer.js   → verify: "CHECK OK"
3. tools\restart.ps1          (or)  tools\iterate.ps1 = check + restart in one
4. bash tools/wait-ready.sh   (run in BACKGROUND; blocks until "ready ✓" or "gave up")
5. Read the status it prints. Confirm your change's expected log line appears.
6. For UI/behavior changes: ask the user to confirm visually. You cannot see the screen.
```
Hot-reload (fs.watch auto-reinject) EXISTS but its console output is NOT captured to the log —
treat it as unreliable for verification. **Full restart is the source of truth.**

## How to verify (match the change type)
- **Syntax:** `tools\check.ps1` → must say `CHECK OK`. If FAIL, do not restart.
- **Boots clean:** `bash tools/wait-ready.sh` → must show `ready ✓` and `dispatcher hook installed`.
  If it shows `gave up waiting` or an error line, your change broke boot — revert/fix.
- **Feature works:** add a temporary `log(...)` line proving your code path ran, restart, confirm it
  in the log via `bash tools/status.sh`. Remove noisy temp logs before committing.
- **No regressions:** deleted-viewer still works, no `interceptor error` / `wrap error` /
  `scan threw` lines in the log.
- **Perf:** if you touched anything on a hot path (dispatch, observer, send), eyeball
  `DCMod.perf()` / run `DCMod.autoBench()` (see AGENT_NOTES perf section). Keep our self-cost ~0.

## Scripts (in tools/)
| Script | What | When |
|---|---|---|
| `check.ps1` | `node --check` renderer + install + uninstall | before EVERY restart/commit |
| `iterate.ps1` | check → restart (aborts if check fails) | the normal edit→run step |
| `restart.ps1` | kill Discord (graceful) + relaunch | restart only |
| `wait-ready.sh` | block until boot done, print status | after restart (run in background) |
| `status.sh [N]` | print last N signal log lines (skips noise) | anytime to inspect state |

Log file: `logs/discord-console.log` (fresh each launch; filtered to `[DCMod]` + real errors).

## Things that WILL break the client / log the user out (do not do)
- `Stop-Process -Force` on Discord mid-write → logout. `restart.ps1` already avoids `-Force`.
- Spamming `webpackChunkdiscord_app.push(...)` during login → logout. Don't add push loops.
- Force-executing all webpack factories (see rule 3).
- Removing/altering the `__DCMOD_LOADED__` guard, the `Function.prototype.m` capture, or `restoreM()`.
- Editing VM/service/.env files — out of scope for this repo.

## Restart caveat
`restart.ps1` uses no `-Force`. If Discord doesn't die within 3s, the relaunch may attach to the
existing instance (no true restart). After restart, CONFIRM a fresh boot by checking the
`diag url=…`/`chunkLen` line timestamp in the log — don't assume the restart took.

## Adding a new hook safely (template)
```js
function installMyHook() {
  const target = findByPropsAll("someStableProp"); // never force-execute
  if (!target || typeof target.someFn !== "function") { log("myHook: not found"); return false; }
  if (target.__dcmodMyHook) return true;            // GUARD (boot runs twice)
  target.__dcmodMyHook = true;
  const orig = target.someFn;
  target.someFn = function () { try { /* ... */ } catch (e) { warn("myHook err", String(e)); } return orig.apply(this, arguments); };
  log("myHook installed");                          // VERIFY: confirm this line in the log
  return true;
}
```
Call it in `boot()` success block next to the other `install*()` calls. Then iterate + verify.

## If you get stuck
Don't thrash with blind restarts (it burns tokens and risks the session). Re-read AGENT_NOTES,
add a targeted diagnostic `log()`, restart once, read the log. If still stuck, ask the user or
research the open-source mods (Vencord/moonlight) the way the dispatcher problem was solved.
