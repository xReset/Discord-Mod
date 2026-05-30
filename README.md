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
hi-res URLs come from UserStore / GuildMemberStore.

**Perf:** our hooks cost ~0 at idle (verified). The interceptor early-outs on non-delete actions before
any timing; perf timing is gated behind a `_measuring` flag (off unless benchmarking). See `AGENT_NOTES.md`.

## Install

> Requires Node.js. **Fully quit Discord first** (tray icon → Quit) or files are locked.

```powershell
cd E:\DiscordMod
npm install            # gets @electron/asar
node install.js
```

Then relaunch Discord. Open DevTools (`Ctrl+Shift+I`) → Console; you should see `[DCMod] ready`.

### Use it
- **Snipe:** have someone delete a message in a channel you're viewing → it turns **red** (no label)
  instead of disappearing. **Shift+right-click** a red message → removes it from your view (gifs/embeds too).
- **Copy Avatar:** right-click a user → *Copy Avatar* (and *Copy Server Avatar* when they have one) →
  paste the image straight into chat.
- Telemetry blocking + fast UI are **on by default** — nothing to click.
- There is **no UI panel / launcher button** anymore (removed). Everything is automatic or via the
  context menu; tuning is through the console.

Console controls:
- `DCMod.toggleDeleted()` — snipe on/off · `DCMod.clearDeleted()` — clear all red styling
- `DCMod.removeLocal(id)` — remove one preserved message
- `DCMod.noTrack(bool?)` — telemetry blocking on/off; returns `{enabled, blocked}` count
- `DCMod.fastUI(bool?)` — instant transitions on/off (A/B the feel)
- `DCMod.perf()` / `DCMod.autoBench()` — perf snapshot / scripted A/B benchmark

## Iterate

Edit `src/renderer/renderer.js`, then **fully restart Discord**. No re-install needed — the
preload reads the file fresh on every launch.

## Update / uninstall

- **After a Discord update** (new `app-<version>` folder), re-run `node install.js`.
- **Remove the mod:** quit Discord, `node uninstall.js`, restart.

## Caveats

- Blocking `MESSAGE_DELETE` is local-only and may skip some unread/ack side effects — fine for
  a personal viewer.
- Internal selectors (`message-content-<id>`, webpack shape) can change with Discord updates;
  if red styling stops, that's the first place to check.
- Client modding violates Discord ToS — same risk profile as the selfbot.
