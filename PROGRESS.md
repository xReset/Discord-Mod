# DiscordMod — Build Progress

**Last updated:** 2026-05-30
**Current status:** ✅ **Deleted-message viewer WORKING.** Dispatcher found, MESSAGE_DELETE
intercepted, deleted messages persist. Next: performance benchmarking + optimization.

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

## Planned features → see PLAN.md (authoritative)

- ✅ Inline deleted-message viewer (done — see top of this file).
- ✅ Custom UI panel (done; transform buttons need repurposing to send-time toggles).
- ⛔ Pre-send outgoing styles (owoify/visual), pre-send autoanimate, permtyping, settings UI +
  persistence — the next build, fully specced in `PLAN.md`.
- Ideas: inline edit history, local filters/keyword highlight.
