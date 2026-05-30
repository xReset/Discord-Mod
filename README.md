# DiscordMod

Custom Discord client mod for Discord **Stable** (Windows). Injector + main-world renderer
plugins. First feature: **deleted-message viewer** — messages deleted by *others* stay visible,
painted **red**, instead of vanishing. Messages *you* delete still vanish normally.

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

## Install

> Requires Node.js. **Fully quit Discord first** (tray icon → Quit) or files are locked.

```powershell
cd E:\DiscordMod
npm install            # gets @electron/asar
node install.js
```

Then relaunch Discord. Open DevTools (`Ctrl+Shift+I`) → Console; you should see `[DCMod] ready`.

### Use it
- A floating **`DC`** button (bottom-right) opens the UI panel (deleted-viewer toggle/clear; the
  text-transform buttons are present but use a draft-rewrite model that is being repurposed to
  send-time toggles — see `PLAN.md`).
- Have someone (or an alt) delete a message in a channel you're viewing → it turns **red** (no
  label) instead of disappearing.
- **Shift+right-click** a red message → removes it from your view (works for gifs/embeds).

Console controls:
- `DCMod.toggleDeleted()` — viewer on/off · `DCMod.clearDeleted()` — clear all red styling
- `DCMod.removeLocal(id)` — remove one preserved message
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
