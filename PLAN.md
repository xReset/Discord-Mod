# DiscordMod — Plan & Roadmap (next agent starts here)

> **2026-07-22: `MAINTENANCE_PLAN.md` is the active work queue.** `ROADMAP.md` keeps historical
> long-term phases. This file is kept for Tier-1/2/3 feature detail + undocumented-hooks notes, which
> `ROADMAP.md` Phase 5 / `MAINTENANCE_PLAN.md` Phase E reference.

Updated 2026-07-22. Read alongside `AGENT_NOTES.md` (internals).

> **Direction:** make our Discord client **strictly better than vanilla** — faster, lighter, no
> telemetry — plus QOL features (snipe, copy-avatar, …). Optimizations must not cost system
> resources or anything the user notices in quality.

---

## ⛔ ABANDONED (do not resurrect)

The previous plan — a **UI panel** with **send-time text-transform toggles** (owoify/visual styles),
pre-send autoanimate, permtyping, settings UI — is **dropped**. The DC launcher button, the panel,
all transform code, and `DCMod.transforms`/`transform` were **removed** as dead weight. Don't rebuild
them. (Pre-send transforms are a *selfbot* concern; this mod's value is client speed + QOL.)

---

## ✅ DONE (today's state)

- **Snipe / deleted-message viewer** — others' deletes preserved red (row-based, gif/embed-safe);
  your own deletes vanish (`deleteMessage` hook); shift+right-click removes; retention cap 500.
- **Real FluxDispatcher** hooked via `Function.prototype.m` capture + score-pick.
- **Telemetry blocking** (`DCMod.noTrack`, default ON) — TRACK dispatch + fetch/XHR/sendBeacon.
- **Fast UI** (`DCMod.fastUI`, default ON) — instant transitions.
- **Copy Avatar** context-menu item — server-vs-default choice, hi-res PNG to clipboard.
- **Perf:** ~0 idle overhead (interceptor early-out + `_measuring` gate, `_rowCache`).

No UI panel exists anymore. Controls are automatic or via the context menu / `DCMod.*` console.

---

## ROADMAP (highest felt-impact first)

### Tier 1 — perceived speed (the stuff you feel)
1. **Hover-prefetch DMs & channels.** On sustained hover (~120ms intent), fire Discord's
   `loadMessages` action so messages are cached before the click → channel opens instantly. Recon:
   find the messages-fetch action module (`findByProps("fetchMessages"/"loadMessages")`). Bound it so
   it's a small eager fetch, not a storm.
2. **MessageStore retention across navigation.** Vanilla evicts a channel's message store on navigate
   → re-fetch on back. Pin the last N channels' stores so back/forward is instant. Recon: MessageStore.
3. **GIF-favorites instant render.** Cache the favorites list + thumbnail URLs (localStorage/IDB) on
   first load; paint from cache, revalidate in background. Kills the picker spinner.

### Tier 2 — resource-saving (lighter AND snappier)
4. **Spellchecker off** — saw `[Spellchecker]` churn per keystroke. Main-process toggle
   (`webContents.session.setSpellCheckerEnabled(false)`) → needs an `install.js` shim edit + repack.
   Trade: loses red-underline spell errors. Confirm the user wants it.
5. **Extend the dispatch block-list** to experiment-exposure / extra analytics action types (log what
   fires first, then add to the interceptor drop list).
6. **Throttle offscreen GIF/video autoplay** beyond Discord's defaults.

### Tier 3 — QOL (snipe family)
7. **Edit-snipe** — record pre-edit content on `MESSAGE_UPDATE` (we already intercept the dispatcher).
8. **Ghost-ping snipe** — catch a mention deleted before you read it.
9. **Copy message-link / raw content** via the shift+right-click menu we already own.

---

## IMPORTANT UNDOCUMENTED HOOKS / NOTES (keep)

- **MessageActions aggregate** = `findByPropsAll("deleteMessage","editMessage")` — also has
  `sendMessage`, `editMessage`, flux methods. Reuse it for any message-action hook.
- **UserStore discovery trap + Copy-Avatar internals** → see `AGENT_NOTES.md` (locale-store false
  match; capture-phase contextmenu requirement; ancestor-climb userId; clone-for-styling).
- **Telemetry / fast-UI internals** → `AGENT_NOTES.md`.
- **Double-boot artifact:** the shim's `fs.watch` reinjects the renderer on `src/renderer/` change
  (sets `window.__DCMOD_LOADED__=false` first). Idempotency guards are REQUIRED for any global hook
  (`__dcmodWrapped`, `__dcmodDelHook`, `__DCMOD_NOTRACK__`, `__DCMOD_AVATAR__`, `__DCMOD_CTX_INSTALLED__`).
- **Iteration loop:** edit `src/renderer/renderer.js` → restart Discord (hot-reload runs but its logs
  aren't captured). Restart via `tools/restart.ps1` or kill+relaunch through `Update.exe`. Watch
  `logs/discord-console.log`. Shim changes (`install.js`) need `node install.js` + repack.
- **Verify before commit:** `node --check src/renderer/renderer.js`. Run `/sign-off` to update docs + push.
