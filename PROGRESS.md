# DiscordMod — Build Progress

**Last updated:** 2026-07-22
**Current status:** ✅ Snipe (deleted viewer), ✅ telemetry blocking, ✅ fast-UI, ✅ Copy-Avatar
context-menu item, ✅ window-control fix (min/maximize/**close**) all working on **build 1.0.9248**.
Auto-update **frozen** (icacls deny-folder on `%LOCALAPPDATA%\Discord`) so updates can't wipe the mod.
DevTools left off (Stable default) to preserve small minimize sizes. Active queue: `MAINTENANCE_PLAN.md`.

## 2026-07-22 — build stamp + install process guard + note 9248

- Installed Discord is **app-1.0.9248** (docs previously said 9243). Freeze may already be lifted /
  Squirrel advanced; re-freeze after next intentional update ritual.
- **Build-compat stamp:** `install.js` bakes the `app-<ver>` into `DCModNative.patchedBuild`; health
  line includes `build=…`; logs `build changed old→new` when stamp differs from last session.
- **Install/uninstall** abort if `Discord.exe` is running (avoid locked/corrupt asar).

## 2026-07-22 — correctness bugfixes (clearDeleted, prefetch, hot-reload)

- **`clearDeleted()`:** also strips `dcmod-deleted-row` / `data-dcmod-id`, clears `deletedActions`,
  calls `stopObserverIfIdle()` (was leaving observer live + shift+right-click able to replay deletes
  on untracked rows).
- **Hover-prefetch:** clear intent timer on `mouseout` so quick sidebar passes don't prefetch.
- **Ghost-ping log:** DEBUG-gated (was noisy in active servers).
- **Hot-reload reinject:** disabled in shim (broken/misleading); restart Discord to iterate.

## 2026-07-22 — DevTools off + titlebar close bridged

- **DevTools:** stopped forcing `webPreferences.devTools=true` and removed Ctrl+Shift+I →
  `toggleDevTools()`. Docked Chromium DevTools raise the practical min window size; verify boots via
  `logs/discord-console.log`.
- **Close button:** same dead DiscordNative window IPC as min/maximize — wired `aria-label=close` →
  `DCModNative.close()` → `win.close()`. Shim already had the IPC action; renderer was skipping it.
- Re-run `node install.js` after pulling (shim change). Fully quit Discord first.

## 2026-06-30 — Phase 5 features (edit-snipe, ghost-ping, hover-prefetch)

- **Edit-snipe:** interceptor captures pre-edit content on `MESSAGE_UPDATE` (reads old message from
  MessageStore before the update applies), stores old→new revisions (cap 300). Query `DCMod.editSnipe(id)`.
- **Ghost-ping snipe:** a deleted message that @mentioned you is detected (MessageStore + your user id),
  preserved with a distinct **orange** marker (over the red), logged (`GHOST PING preserved`), listed via
  `DCMod.ghostPings()`.
- **Hover-prefetch:** on ~150ms hover intent over a channel/DM, warm its messages via Discord's
  `fetchMessages({channelId, limit:50})` so the click opens instantly. Bounded (30s per-channel dedupe,
  skip current channel, guarded). Toggle `DCMod.prefetch`. **Fired live on 9243 with no error** (signature
  confirmed). Health line extended: `msgStore=ok prefetch=ok`. Idle self-overhead still 0.
- **Deferred (reasons):** MessageStore retention (stale/memory risk), GIF-favorites cache (complexity),
  spellchecker-off (needs consent — loses red-underline), offscreen-autoplay-throttle (playback risk).

## 2026-06-30 — update to 9243 + bugfix/hardening/test pass

- **Updated 9240→9243** (unfreeze→launch→install.js→freeze). Internals unchanged — dispatcher found as
  the real instance (score 21, `addInterceptor` present), all hooks + DOM ids identical. Clean boot,
  0 errors. Verified end-to-end via `logs/discord-console.log`.
- **Correctness bugfixes:**
  - Mixed `MESSAGE_DELETE_BULK` data loss — a batch containing *some* of your own deletes used to pass
    the whole action through (wiping the others' messages we'd preserved). Now trims `action.ids` to
    only the allow-listed subset; others' ids stay red.
  - Removed dead + dangerous `findModuleBySource` (it force-executed factories — the explicitly banned
    pattern) and unused `exportCandidates`.
  - Bounded `allowDelete` (cap 200, oldest-evict) so a failed/never-dispatched delete can't leak ids.
  - Per-window original-preload path via `additionalArguments` (was one `process.env` slot = multi-window race).
- **Maintainability (kept single-IIFE per WORKFLOW rule 2):** settings persist to `localStorage`
  (`noTrack`/`fastUI`/`enabled`/`debug`); DEBUG flag (default off) gates the chatty dev logs so a normal
  session is quiet (was accruing a `removeLocal` line every few seconds from retention-cap eviction).
- **Resilience:** boot **health line** (`health dispatcher=ok interceptor=… deleteHook=ok …`) = one grep
  target after an update; **safe source-fallback** dispatcher locator (single targeted require, not mass
  force-execution) for when the prop-scan misses.
- **Picker scroll-jank fix:** fastUI's open-flicker opacity fade was applied to every picker descendant,
  fading virtualized grid rows during scroll → jank on favorited GIFs/stickers/emoji. Scoped to the
  picker container. *(Needs an eyeball to confirm no open-flicker + smooth scroll.)*
- **Tests:** `test/pure.test.js` (`npm test`) — 6/6 (telemetry regex, avatar parsing, id regex,
  default-avatar index, eviction bound, bulk-delete trim).

## 2026-06-10 — window-control (min/maximize) fix

- Symptom: titlebar **minimize / maximize** buttons do nothing on build 9240.
- Diagnosed (temp probes piped to `logs/discord-console.log`): buttons exist, sized 32×32, inside a
  `no-drag` wrapper of the `drag` titlebar, not covered — so input layer is fine. `DiscordNative.window`
  exposes `minimize/maximize/restore` but calling `maximize()` from the renderer **no-ops** (720→720).
  Main-process `win.maximize()` **works** (720→1392, `isMaximized=true`). ⇒ Discord's renderer→main
  window-control IPC is dead on this frozen build; the Electron window itself is fully capable.
- Fix: own bridge. `preload.js` exposes `DCModNative` (`contextBridge`) →
  `ipcRenderer.send('DCMOD_WINCTL', action)`; shim `index.js` `ipcMain.on` runs
  `win.minimize()/maximize()/unmaximize()` on `BrowserWindow.fromWebContents(sender)`. Renderer
  `installWindowControls()` catches `winButton` min/maximize clicks (capture phase, no preventDefault)
  and calls the bridge. Close left to Discord. Verified end-to-end: bridge `toggleMaximize()` drove
  720→1392 and restored.
- No perf change needed: idle perf logs show `intN=0 obsN=0` (our hooks cost ~0); the main-thread
  blocking in the logs is Discord's own, not ours.

## 2026-06-04 — auto-update freeze

- Discord auto-updated `9239→9240` (Squirrel on-launch check after PC restart); new `app-<ver>`
  folder replaced the modded one → mod gone. Re-ran `node install.js` to patch 9240 (verified
  `dispatcherFound=true`, `hasAddInterceptor=true`, MESSAGE_DELETE intercepted).
- Froze future updates: `tools/freeze-version.ps1` = `icacls %LOCALAPPDATA%\Discord /deny <user>:(AD)`
  blocks new `app-<ver>` folder creation. `tools/unfreeze-version.ps1` reverts. Manual-update
  procedure documented in README / AGENT_NOTES.

## 2026-05-30 — feature working

- **Dispatcher discovery solved.** The chunk-push require only saw ~102 modules (missed the
  entrypoint's pre-populated modules where FluxDispatcher lives). Fixed by hooking
  `Function.prototype.m` (setter) at inject time to capture the real entrypoint require(s)
  (~6000-7700 modules), then scanning their caches for the live `dispatch`+`subscribe` object.
- **Picked the REAL dispatcher, not a facade.** Many objects expose `dispatch`+`subscribe`; we
  score candidates and pick the one with internal `_`-fields (`_actionHandlers`, `_interceptors`,
  `_subscriptions`, `_waitQueue`, `_currentDispatchActionType`, `isDispatching`).
- **Block via `addInterceptor`** (still exists on current Discord): returning `true` on
  MESSAGE_DELETE / MESSAGE_DELETE_BULK drops the action so the store keeps the message → it stays
  rendered. CSS + MutationObserver paint it red; hover ✕ replays a real delete to remove locally.
- See `AGENT_NOTES.md` for the full hard-won internals. Full detail there, not duplicated here.

---

## What's built and working

### Infrastructure
- **Injector** (`install.js`) — backs up `app.asar` → `_app.asar`, generates + packs a shim
- **Shim** (`index.js` in `app.asar`) — patches `BrowserWindow` to:
  - Force `devTools: true` (Stable disables it via `webPreferences`)
  - Bind `Ctrl+Shift+I` via `before-input-event`
  - Swap Discord's preload → our preload, stash original in env
  - Mirror renderer console lines → `logs/discord-console.log` (DCMod lines + errors only)
  - Watch `src/renderer/` directory; **re-inject** renderer via `executeJavaScript` on change (hot-reload without page reload)
- **Preload** (`preload.js` in `app.asar`) — chains Discord's real preload first, then injects `renderer.js` into the page main world via `webFrame.executeJavaScript` (bypasses CSP that blocks `<script>` tags)
- **Uninstaller** (`uninstall.js`) — restores original `app.asar`
- **Log file** — `logs/discord-console.log` written fresh each session; readable directly without DevTools pasting

### Renderer bootstrap
- Renderer injects successfully (`renderer injected ✓`)
- Webpack `webpackChunkdiscord_app` found
- Module scan working (try/catch per-module, safe against throwing getters)
- Diagnostic system (`diag()`) runs automatically 6s after boot + on ready/failure
- Chunk push capped at 12 attempts, gated on `chunk.length >= 5`
- Re-push logic: if `chunk.length` grows since last push AND `moduleCount < 500`, re-push to grab fresher `wreq`

---

## Dispatcher discovery — SOLVED (was the blocker)

The old blocker (couldn't find the FluxDispatcher) is solved. Short version: the chunk-push require
only saw ~102 modules (missed the entrypoint modules where the dispatcher lives), and force-executing
factories to compensate threw + corrupted modules. Fix: capture the real entrypoint require via a
`Function.prototype.m` setter hook at inject time (~6000-7700 modules), then score-pick the real
dispatcher instance (internal `_`-fields) and block via `addInterceptor`.

**Full, current internals live in `AGENT_NOTES.md` — do not rely on the historical notes below for
how to do things now (e.g. force-executing factories is now BANNED).** This file is kept as a record
of the build journey.

---

## Hard-won lessons (what broke and why)

> Historical record. Two rows are SUPERSEDED: the "search for `MESSAGE_DELETE`" and
> "force-execute `wreq(id)`" dispatcher strategies were dead ends — the real fix is the
> `Function.prototype.m` require capture (see `AGENT_NOTES.md`); **force-executing factories is now
> banned.** Also: we now iterate by **restarting** Discord (`tools/restart.ps1`, no `-Force`), not by
> relying on hot-reload (its logs aren't captured).

| Problem | Root cause | Fix |
|---|---|---|
| `<script>` injection blocked | Discord's CSP with nonce blocks inline scripts | Use `webFrame.executeJavaScript` in preload |
| DevTools wouldn't open on Stable | `webPreferences.devTools = false` forced by Discord | Override in our `PatchedBrowserWindow` constructor |
| `settings.json` flag wiped | Discord holds settings in memory, rewrites on exit | Don't use `settings.json`; bake it in the shim |
| Account logged out (×3) | `Stop-Process -Force` kills Discord mid-session-DB-write | Hot-reload (re-inject only) — never kill the process |
| Logout from chunk-push spam | `webpackChunkdiscord_app.push()` called ~100× during login/auth handshake | Cap at 12 pushes, gate on `chunk.length >= 5` |
| `diag()` printed `[object Object]` | Raw `console.log(obj)` → shim captures as string | Use `log()` wrapper that `JSON.stringify`s args; then switched to flat `key=value` log strings |
| `fs.watch` lost after first edit | Editor replaces file (new inode); single-file watch breaks | Watch the directory instead; filter by filename |
| Hot-reload only hit one window | Attached watcher to a single `webContents` | Use `BrowserWindow.getAllWindows()` to reload all |
| Shim `SyntaxError` after hot-reload fix | `\n` inside double-quoted string inside backtick template literal gets evaluated to real newline | Use `" "` (space) instead of `"\n"` as statement separator in template |
| `webContents.reload()` silently did nothing | Discord's page blocked unload; old boot loop continued uninterrupted | Switch to `executeJavaScript` re-injection instead of full page reload |
| Source search for "dispatch" finds 0 results | Production build minifies method names | Search for action type string literals like `"MESSAGE_DELETE"` instead |
| moduleCount stuck at 102 forever | webpack 5: `wreq.c` = executed modules only; most of 3144 are lazy in `wreq.m` | Search `wreq.m` factory sources, execute matching module via `wreq(id)` |

---

## File map

```
E:\DiscordMod\
├── install.js              injector/packer (run once + after Discord updates)
├── uninstall.js            restore original app.asar
├── package.json            @electron/asar dep
├── DiscordMod.md           project overview (mirrored to Obsidian vault)
├── PROGRESS.md             this file
├── logs/
│   └── discord-console.log fresh each session; DCMod lines + errors
├── tools/                  helper scripts (check / iterate / restart / wait-ready / status)
└── src/renderer/
    └── renderer.js         the feature code — edit here, then RESTART Discord to apply
```
(More docs exist: `AGENT_NOTES.md`, `PLAN.md`, `WORKFLOW.md`, `SELFBOT_AND_CLIENT.md`.)

---

## 2026-05-30 — optimization + telemetry + Copy Avatar; UI/transforms removed

- **Perf pass (verified ~0 idle overhead):** interceptor early-outs on non-delete actions *before* any
  timing; perf timing gated behind `_measuring` (off unless benchmarking). Row-resolve cache for the
  scroll re-apply (`_rowCache`, validated by `isConnected`). Suffix `[id$=]` selector instead of `[id*=]`.
  Async/batched console log flush in the shim (was sync `appendFileSync` per line). Boot poll backoff
  (150ms early → 500ms).
- **Telemetry blocking (`DCMod.noTrack`, default ON):** blocks Flux `TRACK`/`ANALYTICS_TRACK_EVENT`
  at the interceptor **and** drops science/metrics/track/error-reporting/sentry/observability requests
  via wrapped fetch/XHR/sendBeacon (installed pre-webpack). Verified: ~1 telemetry req/sec dropped.
- **Fast UI (`DCMod.fastUI`, default ON):** static stylesheet zeroes UI *transitions* (not keyframe
  animations, so spinners survive). Snappier + less GPU. Felt, not measurable in the longtask harness.
- **Copy Avatar context-menu item:** clones Discord's "Copy User ID" item (identical styling), injects
  *Copy Avatar* (+ *Copy Server Avatar* when a guild avatar exists). Copies a `?size=4096` PNG to clipboard.
  **Listener MUST be CAPTURE phase** — Discord stopsPropagation on user rows so bubble never reaches us
  (this was the "button doesn't appear" bug). userId parsed by climbing ancestors from the click target
  to the first enclosing avatar `<img>` (robust to where on the row you click).
- **Removed:** DC launcher button + panel + its CSS; text transforms + Slate message-box rewrite +
  `DCMod.transforms`/`transform`. The `PLAN.md` send-time-transform roadmap is abandoned.

## Planned features → see PLAN.md (authoritative)

- ✅ Snipe / deleted-message viewer.
- ✅ Telemetry blocking · ✅ fast-UI · ✅ Copy-Avatar context item.
- ⛔ Removed: UI panel, text transforms, the send-time-outgoing-styles plan.
- Next: hover-prefetch DMs/channels, message-store retention across navigation, GIF-favorites cache,
  spellchecker-off, edit-snipe / ghost-ping snipe. See `PLAN.md`.
