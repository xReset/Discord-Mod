# DiscordMod

Custom Discord client mod for Discord **Stable** (Windows). Injector + main-world renderer.
Goal: a client that's **strictly better than vanilla** — faster, lighter, no telemetry, plus QOL.

Features today:
- **Deleted-message viewer (snipe)** — messages deleted by *others* stay visible, painted **red**,
  instead of vanishing. Messages *you* delete still vanish normally. Shift+right-click a red one to drop it.
- **Telemetry blocking** — Discord analytics / metrics / Sentry crash-reports dropped at both the Flux
  `TRACK` dispatch and the network layer (fetch / XHR / sendBeacon). On by default.
- **Fast UI** — collapses Discord's transition tweens to ~instant (menus, channel switches, popouts).
  Snappier *and* fewer composited frames (less GPU). On by default.
- **Copy Avatar** — adds a native-looking item to the user context menu that copies a hi-res avatar PNG
  to your clipboard. In a server where they have a server-specific pfp you get both *Copy Server Avatar*
  and *Copy Avatar*.
- **Window-control fix** — on this frozen build Discord's own titlebar **minimize / maximize / close**
  buttons are dead (its renderer→main IPC for window controls no-ops). We route those clicks through
  our own bridge (preload `ipcRenderer` → shim `ipcMain` → `win.minimize()/maximize()/close()`) so they work.
- **Disable min size** — Discord Stable locks the main window at **940×500**. We zero constructor
  mins and no-op `setMinimumSize` so you can resize as small as the OS allows.

This is fully our own injector (not Vencord/BetterDiscord). It loads the original Discord app
untouched and adds a chained preload that injects our renderer script.

> **Working on the code?** Read `WORKFLOW.md` first (safe iterate/verify loop + scripts), then
> `AGENT_NOTES.md` (internals) and `PLAN.md` (next build plan / corrected UX model).

## How it works

```
app.asar (our shim)
  ├─ index.js    main process: loads _app.asar (original) + patches BrowserWindow preload
  └─ preload.js  renderer: runs Discord's real preload, then injects src/renderer/renderer.js
                 into the page's MAIN WORLD (where Discord's webpack lives)
_app.asar        untouched backup of the original Discord app
src/renderer/renderer.js   the actual features (edit freely, restart Discord to reload)
```

The renderer captures Discord's real webpack require (via a `Function.prototype.m` setter hook at
inject time — the chunk-push require misses the entrypoint modules), finds the **real** Flux
dispatcher (scored by internal `_`-fields, not a facade), and adds an `addInterceptor`: on
`MESSAGE_DELETE` it records the id and **blocks** the removal, so the message keeps rendering. A CSS
class + a lazy MutationObserver paint it red (the whole row, so gif/embed-only messages work too)
and re-apply on scroll/virtualization. Deletes **you** initiate are allow-listed (via a
`deleteMessage` hook) so they vanish normally. Retention is capped (500) to bound memory.

The same dispatcher hook also blocks `TRACK` analytics actions; a fetch/XHR/sendBeacon wrapper
(installed pre-webpack) drops telemetry network calls. A static stylesheet zeroes UI transitions
(`fastUI`). A capture-phase `contextmenu` listener parses the right-clicked user's avatar to inject
the **Copy Avatar** item, cloned from Discord's own "Copy User ID" item so styling matches exactly;
hi-res URLs come from UserStore / GuildMemberStore. A capture-phase `click` listener catches the
titlebar `winButton` min/maximize/close clicks and drives them through the `DCModNative` window-control
bridge (preload `ipcRenderer.send('DCMOD_WINCTL', …)` → shim `ipcMain` → the sender window's
`minimize()` / `maximize()` / `unmaximize()` / `close()`), because Discord's own window-control IPC is dead on
this build. Verified: main-process `win.maximize()` works while renderer `DiscordNative.window.maximize()`
no-ops, confirming the break is Discord's IPC, not the Electron window (which is fully maximizable).
DevTools are left off (Stable default) so docked inspector chrome does not raise the minimum window size;
verify boots via `logs/discord-console.log`.

**Perf:** our hooks cost ~0 at idle (verified). The interceptor early-outs on non-delete actions before
any timing; perf timing is gated behind a `_measuring` flag (off unless benchmarking). See `AGENT_NOTES.md`.

## Install

> Requires Node.js. **Fully quit Discord first** (tray icon → Quit) or files are locked.

```powershell
cd E:\DiscordMod
npm install            # gets @electron/asar
node install.js
```

Then relaunch Discord. Check `logs/discord-console.log` — you should see `[DCMod] ready`.

### Use it
- **Snipe:** have someone delete a message in a channel you're viewing → it turns **red** (no label)
  instead of disappearing. **Shift+right-click** a red message → removes it from your view (gifs/embeds too).
- **Copy Avatar:** right-click a user → *Copy Avatar* (and *Copy Server Avatar* when they have one) →
  paste the image straight into chat.
- Telemetry blocking + fast UI are **on by default** — nothing to click.
- There is **no UI panel / launcher button** anymore (removed). Everything is automatic or via the
  context menu; tuning is through `DCMod.*` (logged to `logs/discord-console.log` — in-app DevTools are off).

Console controls (appear in the session log when invoked — typically via a one-off debug session):
- `DCMod.toggleDeleted()` — snipe on/off · `DCMod.clearDeleted()` — clear all red styling
- `DCMod.removeLocal(id)` — remove one preserved message
- `DCMod.noTrack(bool?)` — telemetry blocking on/off; returns `{enabled, blocked}` count
- `DCMod.fastUI(bool?)` — instant transitions on/off (A/B the feel)
- `DCMod.perf()` / `DCMod.autoBench()` — perf snapshot / scripted A/B benchmark
- `DCMod.debug(bool?)` — chatty dev logs on/off (per-delete dump, 5-min perf sampler, eviction lines)
- `DCMod.editSnipe(id)` — pre-edit revisions captured for a message (edit-snipe)
- `DCMod.ghostPings()` — ids of deleted messages that @mentioned you this session (styled **orange**)
- `DCMod.prefetch(bool?)` — hover-prefetch on/off (warms a channel's messages on hover → instant open)
- `DCMod.spellcheck(bool?)` — Chromium spellchecker on/off (default OFF — no red underlines; lighter)

Settings (`noTrack` / `fastUI` / deleted-viewer on-off / `prefetch` / `spellcheck` / `debug`) **persist across restarts**
(`localStorage` key `dcmod:settings`) — set once and it sticks.

**Shift+right-click** a message: copy message link · **Alt+shift+right-click**: copy raw content ·
shift+right-click a **red deleted** row: remove it locally.

On boot the log prints a **health line** — `health dispatcher=ok interceptor=… deleteHook=ok …` —
one glance confirms every subsystem hooked (check it first if something seems off after a Discord update).

## Iterate

Edit `src/renderer/renderer.js`, then **fully restart Discord**. No re-install needed — the
preload reads the file fresh on every launch.

## Auto-update is frozen

Discord's Squirrel updater installs each update as a new `app-<version>` folder and deletes the old
one — which wipes the patched `app.asar`. `tools/freeze-version.ps1` denies the user the
create-folder right on `%LOCALAPPDATA%\Discord`, so updates can't land and Discord keeps launching
the modded build. Current frozen build: `app-1.0.9248` (observed 2026-07-22).

**To update on purpose (the only way it updates):**
1. `tools\unfreeze-version.ps1`
2. Launch Discord, let it update; then fully quit.
3. `node install.js` (re-patch the new version).
4. `tools\freeze-version.ps1` (re-block).

## Uninstall

- Quit Discord, `tools\unfreeze-version.ps1` (lift the freeze), `node uninstall.js`, restart.

## Caveats

- Blocking `MESSAGE_DELETE` is local-only and may skip some unread/ack side effects — fine for
  a personal viewer.
- Internal selectors (`message-content-<id>`, webpack shape) can change with Discord updates;
  if red styling stops, that's the first place to check.
- Client modding violates Discord ToS — same risk profile as the selfbot.
