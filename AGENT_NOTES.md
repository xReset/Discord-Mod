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

**Current Discord build observed:** `app-1.0.9239` (Stable, Win11).

---

## Hard rules (break these = logout / wasted hours)

- **NEVER spam `webpackChunkdiscord_app.push()`** during login/auth phase → logs the account out
  (corrupts auth handshake). Push only after `chunk.length >= 5`, cap pushes.
- **`Stop-Process -Force` mid-session can log you out** (kills during session-DB write). Observed ×3
  historically. Current loop: plain `Stop-Process -Name Discord` (no `-Force`) + 3s wait, then relaunch
  via `& "$env:LOCALAPPDATA\Discord\Update.exe" --processStart Discord.exe`. So far no logout this run.
- **DevTools:** Discord Stable forces `webPreferences.devTools=false` and wipes the `settings.json`
  flag on exit. We force `devTools=true` in the shim's `PatchedBrowserWindow` ctor. Don't bother with
  settings.json.
- **CSP blocks inline `<script>`** (`Refused to execute inline script…`). Inject via
  `webFrame.executeJavaScript` from the preload (runs in main world, bypasses CSP).

## Iteration workflow (what actually works)

- **Edit `src/renderer/renderer.js` → restart Discord.** Preload reads renderer fresh each launch.
  **No `node install.js` needed** unless you change the SHIM itself (`install.js` / index.js / preload.js
  / the log filter).
- **Hot-reload (fs.watch → `webContents.executeJavaScript`) does NOT work for iteration.** The reinject
  runs in a context whose `console-message` is NOT captured to the log file, so you get zero feedback.
  Treat hot-reload as dead; **full restart is the only reliable loop.**
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

- Finding the FluxDispatcher reliably on 1.0.9239 — see `PROGRESS.md` for live status. Latest theory:
  per-key try/catch in the export scan was masking it. (Update this line with the outcome.)

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

## Performance (must stay light — user runs many servers)

- **Our self-overhead is ~0 at idle** (measured: interceptor ~0.7ms + observer ~0.7ms over 30s).
  The dominant long-task time in the log is Discord itself, not us. Keep it that way.
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

## Next work + corrected UX model → see PLAN.md

Panel buttons must be TOGGLES for persistent ambient outgoing modes (owoify-on, autoanimate-on,
visual-style), applied automatically at SEND time by wrapping `sendMessage` — NOT one-shot draft
rewrites (current transform buttons use the wrong model; repurpose them). Plus permtyping +
settings UI for server/channel IDs + localStorage persistence. Full plan + undocumented hooks
(MessageActions aggregate has sendMessage/editMessage; Slate box selector; double-boot guard
requirement; restart caveat) are in `PLAN.md`.

## Changelog (append one line per session)

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
