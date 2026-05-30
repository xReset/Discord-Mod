# DiscordMod

Custom Discord client mod for Discord **Stable** (Windows). Injector + main-world renderer
plugins. First feature: **deleted-message viewer** — deleted messages stay visible, painted red
with a `(deleted)` tag instead of vanishing.

This is fully our own injector (not Vencord/BetterDiscord). It loads the original Discord app
untouched and adds a chained preload that injects our renderer script.

## How it works

```
app.asar (our shim)
  ├─ index.js    main process: loads _app.asar (original) + patches BrowserWindow preload
  └─ preload.js  renderer: runs Discord's real preload, then injects src/renderer/renderer.js
                 into the page's MAIN WORLD (where Discord's webpack lives)
_app.asar        untouched backup of the original Discord app
src/renderer/renderer.js   the actual features (edit freely, restart Discord to reload)
```

The renderer grabs Discord's Flux dispatcher and adds an interceptor: on `MESSAGE_DELETE`
it records the id and **blocks** the removal, so the message keeps rendering. A small CSS
class + MutationObserver paint it red and re-apply on scroll/virtualization.

## Install

> Requires Node.js. **Fully quit Discord first** (tray icon → Quit) or files are locked.

```powershell
cd E:\DiscordMod
npm install            # gets @electron/asar
node install.js
```

Then relaunch Discord. Open DevTools (`Ctrl+Shift+I`) → Console; you should see `[DCMod] ready`.

### Test the feature
Have someone (or an alt) delete a message in a channel you're viewing. It should turn red and
show `(deleted)` instead of disappearing.

Console controls:
- `DCMod.toggleDeleted()` — turn the viewer on/off
- `DCMod.clearDeleted()` — drop tracked deletions / clear red styling

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
