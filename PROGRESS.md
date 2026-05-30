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

## Current blocker

### Root cause: minified source, wrong search strategy

Confirmed via diag at `2026-05-29T10:35:44`:

```
diag url=https://discord.com/channels/@me         ← correct main window
diag chunkLen=562 pushes=9 lastPushAt=561          ← 562 chunks loaded
diag moduleCount=102 mCount=3144                   ← 102 executed, 3144 registered in wreq.m
diag wpGlobals=webpackChunkdiscord_app             ← only one webpack global
diag dispatcherFound=false
diag countDispatch=0 countInterceptor=0 countSubscribe=0
```

**The architecture:**
- Discord uses webpack 5. `wreq.c` = executed module cache (~102). `wreq.m` = all registered factories (3144).
- Most modules are lazy-loaded; they exist in `wreq.m` but haven't run yet.
- `findModuleBySource(wreq, "addInterceptor", "dispatch")` → 0 matches.
- `findModuleBySource(wreq, "waitFor", "dispatch")` → 0 matches.
- **Reason:** Discord's production build is minified. Method names like `dispatch`, `waitFor`, `subscribe`, `addInterceptor` are compiled to single-letter names (`e.a()`, `n.b()`, etc.). String searches for these method names find nothing.

**What DOES survive minification:**
- String literals used as action type names: `"MESSAGE_DELETE"`, `"MESSAGE_CREATE"`, `"CONNECTION_OPEN"`, etc.
- These are enum-style constants that cannot be mangled.

### Secondary blocker: hot-reload re-inject not working

`webContents.executeJavaScript(reinjectCode)` fires (logged), doesn't error, but:
- No `console-message` event fires from the injected code
- Old boot loop continues uninterrupted at old attempt numbers

Likely cause: `executeJavaScript` in the main process injects into a DIFFERENT execution context than the preload's `webFrame.executeJavaScript`. The console-message event capture on `webContents` may only fire for the initial page context, not for subsequent `executeJavaScript` calls.

**Workaround:** Not critical for now. The initial boot (via preload) is the working injection path. Re-inject via `executeJavaScript` is a nice-to-have for hot-reload. Since the INITIAL boot needs fixing first, restart-based iteration is fine.

---

## Next step

**Fix dispatcher search to use minification-resistant string patterns.**

In `findModuleBySource`, search for action type string literals instead of method names:

```js
// These survive minification — they're string constants in Discord's source
findModuleBySource(wreq, '"MESSAGE_DELETE"')
findModuleBySource(wreq, '"MESSAGE_CREATE"', '"MESSAGE_DELETE"')
```

A module whose factory source contains `"MESSAGE_DELETE"` is either:
- The message store (registers a handler for this action)
- The dispatcher itself (routes this action to stores)

Once the module is found, log its exported keys to identify what it is and which method to hook.

Then:
1. If it's a store — patch the `MESSAGE_DELETE` handler directly.
2. If it's the dispatcher — find the subscribe/intercept API (whatever survived under its minified name) by inspecting the exported object's methods.

**Alternative approach (no dispatcher needed):** Instead of intercepting at dispatcher level, intercept at the WebSocket level. Discord receives `MESSAGE_DELETE` as a gateway event. We can hook `WebSocket.prototype.onmessage` or find the gateway module and patch it there — before Flux even sees the event.

---

## Hard-won lessons (what broke and why)

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
└── src/renderer/
    └── renderer.js         the actual feature code — edit here, hot-reload applies in ~2s
```

---

## Planned features (post-foundation)

1. **Pre-send text transforms** (subscript, fonts, owoify with zero flash) — original motivation
2. **Inline deleted message viewer** (current test feature — nearly working)
3. **Inline edit history** — show original text on hover
4. **Custom UI toggles** — buttons to control selfbot features without `--` commands
5. **Local filters / keyword highlight**
