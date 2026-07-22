# AGENT_NOTES — read FIRST, update LAST (every session)

> **New here / smaller model? Read `WORKFLOW.md` first** — the safe edit→check→restart→verify loop,
> the helper scripts in `tools/`, and the rules that keep you from breaking the live client.


> **Mandate for any AI agent working in `E:\DiscordMod`:**
> 1. **Read this file before doing anything else.** It exists so you don't re-burn tokens
>    rediscovering Discord-client quirks we already paid for.
> 2. **Update it before you finish.** Any new niche, quirk, dead-end, or hard-won fact about
>    the Discord client / Electron / webpack internals → write it here. Add failed approaches
>    too (a documented dead-end saves the next agent a full restart cycle).
> 3. Keep entries terse and factual. Quote exact error strings. Note the Discord build
>    (`app-<version>`) a fact was observed on — internals change between builds.
> 4. This is the **scratch/quirks log**. `DiscordMod.md` = overview, `PROGRESS.md` = build status.
>    Put durable internals knowledge here.

**Current Discord build observed:** `app-1.0.9248` (Stable, Win11). Auto-update should stay FROZEN — see below.
Observed 9248 on 2026-07-22 (docs previously tracked 9243). Re-run `node install.js` after quit to apply
shim changes from the maintenance pass. Internals notes from 9239/9243 still the working baseline until
a health-line FAIL says otherwise.

---

## Hard rules (break these = logout / wasted hours)

- **NEVER spam `webpackChunkdiscord_app.push()`** during login/auth phase → logs the account out
  (corrupts auth handshake). Push only after `chunk.length >= 5`, cap pushes.
- **`Stop-Process -Force` mid-session can log you out** (kills during session-DB write). Observed ×3
  historically. Current loop: plain `Stop-Process -Name Discord` (no `-Force`) + 3s wait, then relaunch
  via `& "$env:LOCALAPPDATA\Discord\Update.exe" --processStart Discord.exe`. So far no logout this run.
- **DevTools:** Discord Stable forces `webPreferences.devTools=false`. We leave that alone —
  re-enabling / docking DevTools raises the practical minimum window size. Verify via
  `logs/discord-console.log`. Don't bother with settings.json DevTools flags.
- **CSP blocks inline `<script>`** (`Refused to execute inline script…`). Inject via
  `webFrame.executeJavaScript` from the preload (runs in main world, bypasses CSP).

## Iteration workflow (what actually works)

- **Edit `src/renderer/renderer.js` → restart Discord.** Preload reads renderer fresh each launch.
  **No `node install.js` needed** unless you change the SHIM itself (`install.js` / index.js / preload.js
  / the log filter).
- **Hot-reload (`fs.watch` → `executeJavaScript` reinject) is DISABLED in the shim.** It only
  cleared `__DCMOD_LOADED__` while other guards stayed set → silent no-ops / stale closures.
  **Full restart is the only iterate loop** (`tools/restart.ps1` or Stop-Process + Update.exe).
- **Logs:** `logs/discord-console.log`, fresh each launch. Filter keeps `[DCMod]` lines + real errors,
  and DROPS noise (`preloaded using link preload`, `PostMessageTransport`). Before the filter fix the
  file hit 8MB of woff2 warnings — unreadable. Don't loosen the filter back to all-warnings.
- To watch a boot from an agent: background-grep the log for
  `dispatcher hook installed|brute scan found no|ready ✓` then dump `grep DCMod | tail`.

## Webpack / module internals (build 1.0.9239)

- `window.webpackChunkdiscord_app` is the only webpack global. Grab `wreq` via
  `chunk.push([[Symbol()], {}, r => req = r])`.
- `wreq.c` = executed-module cache (~102 right after login). `wreq.m` = all registered factories (~3115).
  **Most modules are lazy** — registered in `wreq.m` but not executed, so they're absent from `wreq.c`.
- **Pushing more synthetic chunks does NOT grow `wreq.c`.** To populate the cache you must `wreq(id)`
  each factory. Brute-executing all of `wreq.m` (try/catch each) is safe POST-LOGIN and is a one-time cost.
- **`addInterceptor` is GONE** (removed Discord 2024+). The old "return true to block MESSAGE_DELETE"
  approach is dead. Block deletes by **wrapping `Dispatcher.dispatch`** and swallowing the action instead.
- **Discord module exports use throwing getters.** When scanning `Object.keys(exports)` and reading
  `exports[k]`, wrap EACH key access in its own try/catch — a single throwing getter must not abort the
  scan of that module's other properties. (This bug silently hid every candidate for multiple restarts.)
- Dispatcher instance shape to match: `typeof o.dispatch === "function"` AND one of
  `subscribe` / `wait` / `_actionHandlers` / `_subscriptions` / `_waitQueue`. Method/field names ARE
  minified, but action-type STRING LITERALS (`"MESSAGE_DELETE"`, `"MESSAGE_CREATE"`) survive minification.

## Build 1.0.9239 — dispatcher hunt findings (2026-05-30, costly, READ THIS)

Burned ~8 restart cycles confirming the following. Don't repeat:

- **All method/property names are obfuscated** to 2-char garbage. Probing executed-module
  exports (depth 0-1) for `dispatch`/`subscribe`/`wait`/`register`/`addChangeListener`/
  `_dispatchToken`/`flushWaitQueue`/`addInterceptor` → **count=0 for every one**. Only `getName`
  matched (count=1). So `findByProps("dispatch","subscribe")` style discovery is DEAD here.
- **No action-handler MAP object exists.** Scanned all exports depth 0-2 for a plain object keyed
  by action-type strings (`"MESSAGE_DELETE"`+≥6 ALLCAPS keys) → **0 hits**. Modern stores appear to
  use switch/reducer functions, not `{MESSAGE_DELETE: fn}` maps. (Could also be `Map`-based; either
  way not reachable as plain-object keys.)
- **Action-type STRING LITERALS survive in factory SOURCE** (`wreq.m[id].toString()` contains
  `"MESSAGE_DELETE"`), but the modules that contain them are action-creators/components
  (functions with empty prototypes), not the store/dispatcher.
- **Brute-force executing every `wreq.m` factory is harmful for discovery:** ~590 of ~3100 THROW
  when required out of dependency order. The FluxDispatcher module likely throws → never lands in
  `wreq.c` → never scanned. So "execute everything then scan cache" CANNOT find it.
- **Chunks load lazily by route:** at `@me` only ~1645 factories registered; opening a real text
  channel grows `wreq.m` to ~3115-3417. Message/dispatcher chunks only exist after navigating into
  a channel. Any discovery must re-run as `wreq.m` grows (we gate brute on module-count growth).
- **Correct approach (per research):** do NOT force-execute. Instead wrap the webpack chunk `push`
  / module factories to observe each module's exports as Discord executes them IN ORDER, and match
  the dispatcher by `findByCode`-style source-string matching, not by live property names. See the
  research report + Vencord/moonlight `webpack` patcher. (Implementing this next.)

## Webpack/Flux technique — from researching Vencord/moonlight (2026-05-30, AUTHORITATIVE)

The earlier "names are all obfuscated" conclusion was WRONG about the cause. Truth:

- **`dispatch` and `subscribe` ARE live runtime property keys on the FluxDispatcher INSTANCE.**
  They're the public flux API and survive minification. Vencord finds it with literally
  `findByProps("dispatch","subscribe")` / `waitFor(["dispatch","subscribe"])`. Internals
  `_actionHandlers`/`_subscriptions`/`_interceptors`/`addInterceptor`/`isDispatching` also survive
  (underscore-prefixed). **`addInterceptor` is NOT gone** — moonlight still maps it.
- **Why our scan saw count=0:** we were FORCE-EXECUTING every `wreq.m` factory (`wreq(id)`), which
  throws on out-of-order deps (~590 throws) and corrupts/partial-fills the dispatcher's cache entry.
  **NEVER force-execute factories for discovery.** Scan only naturally-executed `wreq.c` exports,
  checking the export object AND each enumerable member (`for..in`). The dispatcher is core and is
  loaded naturally within seconds — no navigation/brute needed.
- `findByProps` matches **live `exports` object property keys**, NOT minified factory source text.
  Source-string search (`wreq.m[id].toString()`) is a *different* tool (`findByCode`) for finding a
  module by a stable literal it contains.
- **Minify-stable locator strings** (use with source search if prop-scan ever fails):
  - FluxDispatcher module: `"Dispatch.dispatch(...) called without an action type"`
  - Dispatcher class export: `"_dispatchWithDevtools("`
  - MessageStore module: `'"MessageStore"'` ; ReferencedMessageStore: `'"ReferencedMessageStore"'`
- **Grabbing `wreq` properly (if push-capture is unreliable):** modern mods hook the
  **`Function.prototype.m` setter** (fires when each Rspack entrypoint assigns its module table),
  guarding the main instance via `String(require).includes("exports:{}")` (Vencord) or call-stack
  `includes("/assets/web.")` (moonlight). Discord is **Rspack** now; `.push` is reassigned per
  entrypoint and chained via `.bind` — if you wrap push, intercept via getter/setter and pass `.bind`
  through or you deadlock. (Our simple one-time `push([[Symbol()],{} ,r=>req=r])` is fine for grabbing
  `wreq` to read `wreq.c`; we just must not force-execute.)
- **Keeping deleted messages (Vencord MessageLogger):** they patch the **MessageStore factory's
  `MESSAGE_DELETE:function(e){…}` handler** (regex on factory source, replacing remove→`deleted:true`
  annotation + `commit` + `return`). That needs factory-source patching (Function.prototype.m hook).
  Our lighter approach: find dispatcher, **wrap `dispatch`** and swallow MESSAGE_DELETE (message never
  leaves store), style red via CSS/DOM. Equivalent for a personal viewer.

## ✅ SOLVED — dispatcher discovery that works on 1.0.9239 (2026-05-30)

**Root cause of every prior failure:** the chunk-push require (`push([[Symbol()],{},r=>req=r])`)
returns a require whose `.c` only had ~102 modules — it MISSES the entrypoint's pre-populated
modules where the FluxDispatcher lives. Forcing execution to compensate corrupted things.

**The fix (works, in renderer.js now):** install a `Function.prototype.m` setter capture
SYNCHRONOUSLY at inject time (before webpack boots). Every Rspack require assigns `.m` once at
boot → the setter records each require into a Set, then restores `.m` as a normal own data property.
Then scan EVERY captured require's `.c` for the live object with `dispatch`+`subscribe`
(`isFlux`). Result: captured require has **~6000-7700 modules**, dispatcher found in <1s, keys =
`dispatch,subscribe,addInterceptor`. `addInterceptor` confirmed present.

Critical: the renderer is injected via preload `webFrame.executeJavaScript` which runs BEFORE page
scripts, so the `Function.prototype.m` hook is early enough. If you ever move injection later, this
breaks. Do NOT remove the capture block at the top of renderer.js.

## Open / in-progress

- None for dispatcher discovery — **SOLVED** (see section above). Remaining deferred feature work
  lives in `MAINTENANCE_PLAN.md` Phase E (spellchecker consent, MessageStore retention, etc.).

## Gotcha: many objects expose dispatch+subscribe — most are FACADES

`findByProps("dispatch","subscribe")` returns the FIRST match, often a facade with ONLY
`{dispatch,subscribe,addInterceptor}` (3 keys). Discord does NOT dispatch through the facade —
wrapping its `.dispatch` is silently dead (we saw ZERO actions flow through it). The REAL
FluxDispatcher instance has internal `_`-fields:
`_defaultBand,_interceptors,_subscriptions,_waitQueue,_processingWaitQueue,_currentDispatchActionType,_actionHandlers,_sentryUtils,actionLogger,functionCache`.
**Score candidates and pick the one with the most `_`-fields / `isDispatching`.** ~28 flux
candidates exist on a loaded client.

Real action shapes (build 1.0.9239):
- `MESSAGE_DELETE` = `{type,id,channelId}` (gateway) or `{type,guildId,id,channelId}`.
- `MESSAGE_DELETE_BULK` = `{type,...,ids}`.
- `addInterceptor(cb)`: return `true` to DROP the action (keeps message). Confirmed working.

## DOM / UX niches (build 1.0.9239)

- **Deleted message styling target:** the text node has DOM id `message-content-<messageId>`
  (class `dcmod-deleted`, red text, no label). BUT gif/embed-only messages have no text there, so we
  ALSO tag + style the whole message ROW: find the `li` (via `content.closest('li')` or
  `li[id*="<id>"]`), add class `dcmod-deleted-row` + `data-dcmod-id=<id>`. See `elsFor(id)`.
- **Your own deletes vanish; others' stay red.** A `deleteMessage` hook (on the MessageActions
  aggregate, see below) adds ids YOU delete to `allowDelete`, so the interceptor lets them through.
  Deletes by others (gateway-only) hit the interceptor with no allow-list entry → blocked → red.
- **Shift+right-click removal:** a `contextmenu` listener in CAPTURE phase
  (`addEventListener("contextmenu", fn, true)`). Only acts when `e.shiftKey` AND the target is within
  a `[data-dcmod-id]` row (or a `.dcmod-deleted` content node); then `preventDefault()` + `removeLocal`.
  Plain right-click and all non-preserved messages pass through to Discord untouched.
- **Local removal = replay the real delete:** `removeLocal(id)` adds the id to `allowDelete`
  then re-dispatches the stored `MESSAGE_DELETE` through the dispatcher; the interceptor sees
  it's allow-listed and lets it pass → store drops it → gone from view. (These messages are
  already deleted server-side, so there's nothing to delete on Discord's end.)

## Context-menu injection (Copy Avatar) — build 1.0.9239 (2026-05-30)

- **The listener MUST be CAPTURE phase** (`addEventListener("contextmenu", fn, true)`). Discord calls
  `stopPropagation()` on the contextmenu event for **user rows** (DM list, member list), so a BUBBLE
  listener never fires for them — server-folder icons bubble fine, which made it look intermittent.
  This was the "button doesn't appear" bug. (Same reason the snipe listener is capture.)
- **Get the userId by climbing ancestors** from `e.target` outward (≤8 levels), using the FIRST element
  that encloses an avatar `<img>`; parse its src. Works wherever on the row you click. A single
  `closest(selector)` guess is fragile (avatar may be outside the matched container) → flaky.
  - global avatar src: `/avatars/<userId>/<hash>` · guild avatar src: `/guilds/<gid>/users/<uid>/avatars/<hash>`.
  - Default-avatar users (`/embed/avatars/N.png`) carry **no id** → item can't resolve for them (rare).
- **Menu renders 1-2 frames AFTER the contextmenu event** → on right-click, record the user, then poll
  ~30 rAF frames for an open `[role="menu"]` that contains a "Copy User ID" item; inject once, stop.
- **Match styling by CLONING** Discord's "Copy User ID" menuitem (`cloneNode(true)`) — identical
  classes = identical height/padding. The clone is inert (React handlers are fiber-tracked, not copied),
  so add our own `click` listener; strip the `[class*=iconContainer]` ID badge; relabel `[class*=label]`.
  Cloned items don't get Discord's JS focus-highlight class → add a CSS `.dcmod-menuitem:hover` using
  `var(--background-modifier-hover)` for feedback. Close the menu after action via
  `_dispatcher.dispatch({type:"CONTEXT_MENU_CLOSE"})`.
- **UserStore discovery is a trap:** `findByProps("getCurrentUser","getUser")` matches a **locale store**
  too (its `getCurrentUser()` returns `{locale,ast}`). Validate: scan for a module where
  `getCurrentUser()` returns an object with `.id` AND `typeof .username === "string"`. `getUsers` alone
  is NOT a reliable extra prop. GuildMemberStore = `findByProps("getMember","getMemberIds")`.
- **Clipboard:** fetch the CDN `.png?size=4096` (returns `image/png` — CORS allowed from discord.com),
  `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`. Runs in the click gesture → allowed.
  Canvas-convert as a fallback if a non-png ever comes back.

## Window minimum size (2026-07-22)

- **Not DevTools.** Vanilla Discord (`discord_desktop_core` `core.asar`) sets
  `MIN_WIDTH=settings.get("MIN_WIDTH",940)`, `MIN_HEIGHT=…500`, passes them as BrowserWindow
  `minWidth`/`minHeight`, and clamps saved `WINDOW_BOUNDS`. Webapp can also call
  `WINDOW_SET_MINIMUM_SIZE` → `win.setMinimumSize`.
- **Fix in shim `PatchedBrowserWindow`:** set `options.minWidth/minHeight=0` before `super`, call
  `RealBW.prototype.setMinimumSize(0,0)`, then replace `this.setMinimumSize` with a no-op.
  Settings.json alone is unreliable on current Stable (Vencord/BD same conclusion).
- Electron frameless OS floor (~39px @ 100% DPI) remains; that is far below Discord's old 940.

## Window-control (min/maximize) fix — build 1.0.9240 (2026-06-10)

- **Symptom:** titlebar minimize/maximize buttons do nothing.
- **Diagnosis (use temp probes → `logs/discord-console.log`, NOT guesswork):**
  - Buttons exist, sized 32×32, inside `trailing(no-drag) > bar(drag)` → input/drag layer is fine.
    `elementFromPoint` at the button center returns the button (not covered). NOTE: `elementFromPoint`
    is DOM hit-test only — it can't see `-webkit-app-region: drag` capture, so it does NOT prove
    clickability; check the `no-drag` ancestor instead.
  - `DiscordNative.window` has `minimize/maximize/restore`, but renderer `maximize()` **no-ops**
    (`window.outerHeight` unchanged). Main-process `win.maximize()` **works**
    (`isMaximized=true`, bounds grow). ⇒ Discord's renderer→main window-control IPC is dead on this
    frozen build; the Electron window is fully maximizable/minimizable (`isResizable/isMaximizable=true`,
    no min==max lock).
- **Fix = our own bridge** (don't rely on Discord's IPC):
  - `preload.js`: `contextBridge.exposeInMainWorld("DCModNative", {minimize,toggleMaximize,close})`,
    each doing `ipcRenderer.send("DCMOD_WINCTL", action)`. Fallback `window.DCModNative=` if isolation off.
  - shim `index.js`: `ipcMain.on("DCMOD_WINCTL", …)` → `BrowserWindow.fromWebContents(event.sender)` →
    `minimize()` / `isMaximized()?unmaximize():maximize()` / `close()`.
  - renderer `installWindowControls()`: capture-phase `click` on `[class*="winButton"]`, skip the 0×0
    leading set, read `aria-label` (minimize / maximize / restore), call the bridge. No `preventDefault`
    so Discord's own inert handler still runs harmlessly. Close also uses the bridge (`api.close()` →
    `win.close()`) — Discord's close IPC is equally dead on this build.
- **Verified end-to-end:** bridge `toggleMaximize()` drove 720→1392 and restored (same path as a click).
- These probes also revealed the **hot-reload reinject is broken** (file-change `re-injecting` logs but
  the new IIFE never re-emits `renderer injected` — the guard isn't actually re-running new code). Not
  fixed here (out of scope); iterate via full restart (`tools` / Stop-Process + Update.exe) for now.

## Telemetry blocking + fast-UI (2026-05-30)

- **`noTrack` (default ON):** interceptor returns `true` (drops) for action types `TRACK` /
  `ANALYTICS_TRACK_EVENT` — handler never builds the payload. PLUS a network wrapper installed
  **pre-webpack** (these globals exist before boot) patches `fetch` / `XMLHttpRequest.open+send` /
  `navigator.sendBeacon` to drop URLs matching
  `/api/v\d+/(science|metrics|track)`, `/error-reporting`, `sentry.io`, `/observability`, `/rtc/quality`.
  fetch returns a fake 204 so Discord's code doesn't throw. Idempotent via `window.__DCMOD_NOTRACK__`.
  Verified ~1 dropped req/sec. The dispatcher candidate has a `_sentryUtils` field — that's the
  crash-telemetry path the block starves.
- **`fastUI` (default ON):** one static `<style>` sets `transition-duration:.001s; transition-delay:0s`
  on `*`. **Transitions only — never keyframe `animation`** (spinners/loading/voice rings must keep
  working). Resource-negative (fewer composited frames). NOT measurable by the longtask harness (it's a
  tween delay, not CPU) — verify by feel / `DCMod.fastUI(false)` A/B.
- **fastUI flicker fix (2026-06-02):** killing `*` transitions made the **emoji/sticker/gif picker**
  (`[class*=expressionPicker]`) flicker on open — Discord fades its lazily-rendered grid in to mask the
  pop, and we were collapsing that fade to ~0. Measured via CDP (`--remote-debugging-port=9222`): fastUI
  ON forced 200/201 picker els to `0.001s`, nuking ~19 real transitions (0.08–0.25s). Fix: a
  higher-specificity exception in `injectSpeedStyle` restores **`transition-property:opacity; duration:.15s`**
  for the picker subtree. **OPACITY ONLY** — restoring `all`/`transform` would animate the virtualized
  scroller's row positions = scroll jitter. Don't change `revert`/`unset` here: under a `*!important`
  kill, NO keyword (`revert`/`revert-layer`/`unset`) can re-expose Discord's per-element author values
  (important-author always beats normal-author, even across cascade layers) — verified empirically, all
  gave `0s`. Re-declaring opacity@.15s is the only thing that works.

## Performance (must stay light — user runs many servers)

- **Our self-overhead is ~0 at idle** and now genuinely free off the hot path. The interceptor
  **early-outs on non-delete action types BEFORE any timing or work** (one string compare + return for
  the thousands of other dispatches). Perf timing (`performance.now()` ×2 + counter writes) is gated
  behind `_measuring` (default OFF; only `bench`/`autoBench` flip it on) — so we don't tax every
  dispatch just to measure ourselves. The dominant long-task time in the log is Discord, not us.
- **`_rowCache` (Map id→`<li>`, validated by `isConnected`)** caches the costly avatar-row lookup so
  `applyAll` doesn't re-run `querySelector('li[id$="<id>"]')` every animation frame during scroll.
  Cleared on `removeLocal`/`clearDeleted`; bounded by the retention cap. The selector is suffix
  (`[id$=]`) not substring (`[id*=]`) — anchored, faster.
- **MutationObserver discipline:** only observe while `deletedIds.size > 0`; disconnect when it
  hits 0; coalesce to ONE `applyAll` per `requestAnimationFrame`. Never re-add a `document.body`
  `{subtree:true}` observer that runs on every mutation — that was the tax.
- **`Function.prototype.m` accessor is REMOVED after boot** (`restoreM()`), so it doesn't tax
  every `.m` read for the whole session. Only needed during capture.
- **Scaling: retention cap IMPLEMENTED.** `RETENTION_CAP = 500` (renderer.js). `deletedIds` is an
  insertion-ordered Set; when size exceeds the cap, `markDeleted` evicts the oldest via
  `removeLocal` (actually deletes it → frees store + DOM). Keeps memory bounded over long sessions
  across many servers. Tune the constant if needed.
- **Benchmark tools (in renderer, console):** `DCMod.perf()` snapshot; `DCMod.setActive(bool)`
  A/B toggle; `DCMod.autoBench(secs)` = scripted identical triangle-wave scroll with hooks ON
  then OFF, logs `autoBench RESULT` comparing `ltPerMin`/`blockMsPerMin`. `longtask` = main-thread
  task >50ms (Chromium PerformanceObserver). NOTE: DevTools being OPEN inflates these numbers a lot
  — for a clean read, run autoBench, then check the log (don't trust numbers with DevTools perf
  profiler active). `findScroller` walks up from a `message-content-` node to the nearest scrollable
  ancestor; needs a channel with messages visible.

## Benchmark result (2026-05-30, autoBench, 15s scripted scroll/phase)

`autoBench RESULT ltPerMin on=24 off=67.6 | blockMsPerMin on=6401 off=17779 | ourMs on=0.5`

- Our hooks cost **0.5ms over 15s** — negligible. Hooks ON was not slower than OFF (ON actually
  showed fewer longtasks — run-order/layout-warming variance, not our code).
- **Conclusion: the mod is not the perf bottleneck.** Absolute longtask numbers were inflated
  because DevTools console was open during the run (profiler taxes the main thread). For a real
  feel-test, close DevTools.
- Method note: autoBench runs ON phase first, OFF second; second pass can differ (warm caches,
  different rendered content). For rigor, run autoBench 2-3× and average, DevTools closed.

## Environment quirk: stuck launch + can't join VC (NOT a mod bug)

Observed `app-1.0.9239`, 2026-06-03. Discord stalled on "checking for updates" splash
(~47s) and could not join voice channels. **Not the mod** — DCMod boots clean (dispatcher
hooked, `ready ✓`); telemetry regex is narrow (only `science|metrics|track`, `sentry.io`,
`/rtc/quality`) and touches no functional API or voice/gateway endpoints.

Root cause = Discord's **experimental audio subsystem**. `%APPDATA%\discord\settings.json` had:
```
"audioSubsystem": "experimental",
"offloadAdmControls": true,
```
Voice log `%APPDATA%\discord\logs\discord-webrtc_0` spammed the Rust ADM failing every device op:
```
(rust_adm.cpp:431): Not implemented
(rust_adm.cpp:582): Audio device module error: -100, device:
```
Main log also: `Deferring audio subsystem switch to experimental until next restart.`

**Fix:** set both back to `"standard"` / `false`. **Gotcha:** Discord rewrites settings.json
from its internal store on launch, so a plain edit-while-quit reverts. Procedure that sticks:
1. `Stop-Process -Name Discord -Force` (kill ALL procs — confirm count 0).
2. Edit settings.json → `"audioSubsystem": "standard"`, `"offloadAdmControls": false`.
3. Set the file **read-only** (`(Get-Item $s).IsReadOnly = $true`) so Discord can't overwrite.
4. Relaunch: `%LOCALAPPDATA%\Discord\Update.exe --processStart Discord.exe`.

Backup kept at `settings.json.dcmod-bak`. Verified: setting held = `standard` after relaunch.
Note: some `rust_adm` "Not implemented" lines for volume/mute on empty device are benign boot
probes; the VC-breaking signature is the experimental subsystem + repeated `-100` on real
record/playout device selection.

## Auto-update freeze (2026-06-04) — why the mod kept vanishing

**Cause:** Discord (classic Squirrel: `Update.exe` + `packages\RELEASES` + `.nupkg`) checks for
updates **on every launch** (the "checking for updates" splash) and periodically. On update it
creates a **fresh `app-<version>\resources\app.asar` folder and DELETES the old one** — taking our
patched asar with it. `9239 → 9240` installed 2026-06-03 18:14 (PC restart relaunched Discord →
launch triggered the check). The version bump alone wipes the mod; nothing else broke.

**Fix (implemented):** deny the user the `(AD)` = create-folder right on `%LOCALAPPDATA%\Discord`
so Squirrel can't land a new `app-<ver>` folder. Discord then keeps launching the current modded
version. File writes (installer.db, logs, `Update.exe --processStart` relaunch) still work — only
NEW sub-folder creation is blocked. Verified: folder-create denied, file-write OK, client boots.

- Freeze:   `tools/freeze-version.ps1`   → `icacls %LOCALAPPDATA%\Discord /deny "<user>:(AD)"`
- Unfreeze: `tools/unfreeze-version.ps1` → `icacls ... /remove:d <user>`
- ACL check: `icacls %LOCALAPPDATA%\Discord` should show `<user>:(DENY)(AD)`.

**To update ON PURPOSE (the only allowed path):**
1. `tools/unfreeze-version.ps1`
2. Launch Discord, let it update to the new `app-<version>`.
3. Fully quit Discord.
4. `node install.js`  (re-patch the new version — re-detects newest `app-<ver>`).
5. `tools/freeze-version.ps1`  (re-block).

Note: SYSTEM/Administrators keep Full Control, but Discord's updater runs as the **user**, so the
user-scoped deny is sufficient. Don't delete/rename `Update.exe` — Discord relaunches through it.

## Next work → see PLAN.md

Direction: a client **strictly faster/lighter than vanilla** + QOL. Done: snipe, telemetry block,
fast-UI, Copy-Avatar. The old send-time-transforms / UI-panel plan is **abandoned** (UI + transforms
removed). Next roadmap (highest felt-impact first): hover-prefetch DMs/channels, MessageStore retention
across navigation, GIF-favorites cache, spellchecker-off (main-process), edit-snipe / ghost-ping snipe.
Full notes in `PLAN.md`.

## Health line + resilience (2026-06-30)

- **Boot health line** (renderer `boot()`): one grep target after any Discord update —
  `health dispatcher=ok interceptor=addInterceptor deleteHook=ok telemetry=ok ctxMenu=ok avatarMenu=ok winctl=ok settings={...}`.
  Any `=FAIL` / `deleteHook=miss` = that subsystem's internals moved; the rest still works. Check it FIRST.
- **Safe source-fallback locator** (`findDispatcherBySource`): if the live-cache prop-scan finds no flux
  candidate, scan `wreq.m[id].toString()` for minify-stable strings
  (`"Dispatch.dispatch(...) called without an action type"`, `"_dispatchWithDevtools"`) and execute ONLY
  that ONE matched module. This is NOT the banned mass force-execution (which ran ALL ~3100 factories out
  of order) — it's a single targeted require of the dispatcher's self-contained factory. Logs
  `dispatcher found via SOURCE fallback` when it triggers (a signal internals shifted).
- **DEBUG flag** (persisted, default OFF): gates the chatty dev logs — the per-delete `action type=…`
  dump, the 5-min `perf interval` sampler, and the per-eviction `removeLocal` line. A normal multi-hour
  session now stays quiet (the log was accruing a `removeLocal` line every few seconds from retention-cap
  eviction across many servers). `DCMod.debug(true)` to re-enable; the one-shot `perf baseline` stays on.
- **Settings persistence** (`localStorage` key `dcmod:settings`): `noTrack`/`fastUI`/`enabled`/`debug`
  survive restarts. Toggles write on change; boot reads them (defaults preserved if absent).
- **Picker scroll-jank fix:** the fastUI open-flicker exception was `[class*=expressionPicker] *`
  (EVERY descendant) → the .15s opacity fade also hit the VIRTUALIZED grid rows, which mount/unmount on
  scroll → ghosting/jank on fast scroll of favorited GIFs/stickers/emoji. Scoped it to
  `[class*="expressionPicker"]` (container only): the open-fade (on the container) is kept, scrolled-in
  rows are instant. Still OPACITY-ONLY (never transform/all). **Needs an eyeball to confirm BOTH: (a)
  picker still opens with no flicker, (b) scroll is smooth.** One-line revert if open-flicker returns
  (re-add the descendant selectors).

## Phase 5 features (2026-06-30) — edit-snipe, ghost-ping, hover-prefetch

- **MessageStore access:** `findByPropsAll("getMessage","getMessages")`. `getMessage(channelId, id)`
  returns the live Message record (`.content`, `.mentions` [array of user objects], `.mentioned`).
  Confirmed on 9243 (`health … msgStore=ok`).
- **Edit-snipe:** interceptor handles `MESSAGE_UPDATE` (`{type, message:{id, channel_id, content, …}}`),
  reads the OLD message from the store BEFORE the update applies (interceptor runs pre-dispatch), and
  records `{from,to}` in `editHistory` (Map, cap 300). Returns `false` — never blocks the edit. Skips
  embed-only updates (old===new content). Query: `DCMod.editSnipe(id)`.
- **Ghost-ping:** on a blocked `MESSAGE_DELETE`, `_isGhostPing` reads the message from the store and
  checks `mentions.some(u=>u.id===selfId)` / `mentioned===true` against `UserStore.getCurrentUser().id`.
  Hits get `ghostPings.add(id)` + a NON-debug `GHOST PING preserved` log + a distinct **orange** row
  style (`.dcmod-ghostping-row`, `#faa61a`) layered over the red. Query: `DCMod.ghostPings()`.
- **Hover-prefetch:** `findByPropsAll("fetchMessages")` → `MF.fetchMessages({channelId, limit:50})`.
  **Signature `{channelId, limit}` CONFIRMED on 9243** — fired live with no error (`prefetch channel=…`,
  no `prefetch failed`). Capture-phase `mouseover` on document; resolve channelId from the closest
  `a[href*="/channels/"]`; 150ms hover-intent debounce; dedupe per channel 30s; skip the open channel;
  all in try/catch (a wrong signature would be a silent no-op, not a crash). Toggle `DCMod.prefetch`.
  Idle self-overhead unchanged (still `intN=0 obsN=0`) — the mouseover handler early-outs on non-link
  targets and only fires on real hover intent.
- **Deferred (NOT built — reasons):** MessageStore-retention-across-nav (risk: stale data / memory if we
  fight Discord's eviction), GIF-favorites cache (complexity), spellchecker-off (needs user consent — it
  loses red-underline spellcheck), offscreen-autoplay-throttle (risk of breaking GIF/video playback).
  See `ROADMAP.md` Phase 5.

## Unit tests (2026-06-30)

`test/pure.test.js` (`node --test` / `npm test`): telemetry regex (blocks telemetry, allows functional
API), avatar-src parsing, row-id regex, default-avatar index, retention/allow-list eviction bound,
bulk-delete mixed-batch trim. Each regex test asserts the renderer.js source still contains the literal
(drift guard). 6/6 pass. These are the pure bits that silently rot on updates.

## Changelog (append one line per session)

- 2026-06-30 (Phase 5): **edit-snipe** (capture pre-edit content on MESSAGE_UPDATE → `DCMod.editSnipe`),
  **ghost-ping snipe** (deleted messages that @mention you → orange style + `DCMod.ghostPings`),
  **hover-prefetch** (warm channel messages on 150ms hover intent → instant open; `fetchMessages({channelId,
  limit})` signature confirmed live on 9243, fired with no error; `DCMod.prefetch`). Health line extended
  with `msgStore` + `prefetch`. Idle overhead held at 0. Deferred retention/GIF-cache/spellchecker/autoplay
  (reasons above). Committed.
- 2026-06-30: **Updated 9240→9243** (unfreeze→launch→install→freeze; internals unchanged, verified
  clean boot). **Bugfixes:** mixed MESSAGE_DELETE_BULK data-loss (trim action.ids to allow-listed subset
  instead of passing whole batch → preserved messages no longer wiped); removed dead+dangerous
  `findModuleBySource` (force-executed factories — the banned pattern) and dead `exportCandidates`;
  bounded `allowDelete` (leak guard, cap 200); per-window preload path via `additionalArguments` (was a
  single `process.env` slot = multi-window race). **Maintainability:** settings persistence (localStorage),
  DEBUG-gated dev logs (quiet sessions), in-file (kept single-IIFE per WORKFLOW). **Resilience:** boot
  health line, safe source-fallback dispatcher locator. **Fix:** picker scroll-jank (fastUI fade scoped
  to picker container, off the virtualized grid rows). **Tests:** `test/pure.test.js`, 6/6. All verified
  via log (dispatcher/hooks/health clean, 0 errors, idle overhead still 0). See ROADMAP.md for the plan.
- 2026-05-30: Created this file. Rewrote dispatcher discovery (deep export scan + brute-execute all
  factories), swapped addInterceptor→dispatch-wrap, added hover-✕ local removal, fixed log-noise filter,
  fixed per-key getter try/catch. Restart-loop iteration confirmed; hot-reload confirmed dead.
- 2026-05-30: SOLVED. Function.prototype.m capture → real require (~7700 modules). Score-pick real
  dispatcher (not facade) by `_`-fields. addInterceptor block. Deleted messages persist. ✅ committed.
- 2026-05-30: UX + perf pass. Red-only (dropped "(deleted)" label + hover-✕). Lazy MutationObserver
  (disconnect when no deletions, rAF-coalesced). restoreM() after boot. Perf harness + scripted-scroll
  autoBench A/B. Our idle overhead measured ~0. Robust findScroller. Retention cap (500).
- 2026-05-30: Removal model finalized. **deleteMessage hook** → your own deletes vanish, others' stay
  red. Row-based styling/targeting (`dcmod-deleted-row` + `data-dcmod-id`) so gif/embed-only messages
  work. Removal gesture is **SHIFT+right-click**. Custom UI panel (black/white) with deleted-viewer
  toggle/clear + (draft-rewrite) transform buttons — buttons to be repurposed to send-time toggles
  (see PLAN.md). Added WORKFLOW.md + validated tools/ scripts (fixed em-dash PowerShell parse bug).
  Audited all .md for accuracy.
- 2026-05-30: Optimization + features pass. Interceptor early-out before timing + `_measuring` gate
  (zero per-dispatch overhead). `_rowCache` + `[id$=]` selector. Async/batched shim log flush. Boot
  poll backoff. **Telemetry blocking** (`noTrack`: TRACK dispatch + fetch/XHR/sendBeacon, default ON,
  ~1 req/sec dropped). **fast-UI** (instant transitions, default ON). **Copy-Avatar** context-menu
  item (clone "Copy User ID", CAPTURE-phase listener, ancestor-climb userId, validated UserStore,
  server-vs-default choice, clipboard PNG). **Removed** DC launcher/panel + text transforms +
  `DCMod.transforms`. Added `sign-off` skill + this changelog. Committed + pushed.
- 2026-06-02: **fastUI sticker-picker flicker fix.** `*{transition-duration:.001s}` was nuking the
  picker's opacity fade → flicker on open. Diagnosed live over CDP (screenshot/transition measurement).
  Added a picker-scoped exception restoring `opacity` fade @ .15s (opacity-only to avoid scroll jitter).
  See the fastUI flicker-fix note above. Verified on fresh boot. Committed + pushed.
- 2026-06-04: Discord auto-updated 9239→9240 (Squirrel, on-launch check after PC restart) → new
  app-<ver> folder replaced the modded one → mod gone. Re-ran install.js to patch 9240 (verified
  ready ✓, dispatcher hooked). FROZE auto-update: `icacls /deny <user>:(AD)` on %LOCALAPPDATA%\Discord
  blocks new app-<ver> folder creation. Added tools/freeze-version.ps1 + unfreeze-version.ps1 + the
  manual-update procedure above. Bumped build to 9240.
- 2026-06-03: SOLVED env issue — stuck launch + can't join VC. Root cause Discord's experimental
  audio subsystem (`rust_adm.cpp` "Not implemented" / ADM error -100), NOT the mod. Reverted
  settings.json `audioSubsystem`→`standard`, `offloadAdmControls`→`false`, set file read-only so
  Discord can't rewrite it on launch. See "Environment quirk" section above. Verified held.
- 2026-06-10: **Window-control (min/maximize) fix.** Titlebar buttons dead on 9240 — diagnosed via
  temp probes that Discord's renderer `DiscordNative.window.maximize()` no-ops while main-process
  `win.maximize()` works (so it's Discord's IPC, not the Electron window). Added own bridge: preload
  `DCModNative` (`contextBridge`→`ipcRenderer`) → shim `ipcMain DCMOD_WINCTL` → `win.minimize/maximize/
  unmaximize`; renderer `installWindowControls()` catches `winButton` clicks. Verified end-to-end
  (toggleMaximize 720→1392→restore). No perf change (idle overhead already ~0; logged blocking is
  Discord's). Also noted hot-reload reinject is broken (separate, out of scope). Committed + pushed.
- 2026-07-22: **DevTools left off** (no longer force `devTools=true` / Ctrl+Shift+I) — docked DevTools
  raise Chromium min window size. **Close button bridged** via existing `DCModNative.close` →
  `win.close()` (was intentionally falling through to dead Discord IPC). Verify via log file.
- 2026-07-22: **Bugfixes** — `clearDeleted` strips row attrs + clears `deletedActions` + stops
  observer; prefetch cancels on mouseout; ghost-ping log DEBUG-gated; hot-reload reinject disabled.
- 2026-07-22: **Build stamp** (`DCModNative.patchedBuild` + health `build=` + `build changed` warn) and
  install/uninstall refuse while Discord.exe is running. Live install observed at **1.0.9248**.
- 2026-07-22: Expanded pure tests + doc hygiene (WORKFLOW/AGENT_NOTES/MAINTENANCE_PLAN Phase D).
- 2026-07-22: **Disable min size** — Discord core defaults 940×500; shim zeros ctor mins + no-ops
  `setMinimumSize` (webapp IPC can't restore). DevTools was a red herring for the resize floor.
- 2026-07-22: **Copy message-link/raw** — shift+right-click copies discord.com link; alt+shift copies
  MessageStore content; deleted rows still removeLocal.
- 2026-07-22: **Spellchecker off** by default (`setSpellCheckerEnabled(false)`); `DCMod.spellcheck(true)`
  restores via `DCMOD_SPELLCHECK` IPC; setting persists.
