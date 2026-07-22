# DiscordMod — Active Maintenance Plan

**Created 2026-07-22.** This is the **active** work queue. Historical long-term phases live in
`ROADMAP.md` (kept for reference). Git flow: `maintenance/<phase-slug>` → PR → merge to `main`.

> **Prime directive (unchanged):** a Discord client strictly better than vanilla — faster, lighter,
> no telemetry — plus QOL. Verify per `WORKFLOW.md`. Prefer `logs/discord-console.log` over any
> in-app console (DevTools are intentionally disabled).

---

## Research verdicts (2026-07-22)

### DevTools → larger minimum window — **partial / revised**

- DevTools dock *can* raise the practical floor when open; we still leave Stable's `devTools=false`.
- **User follow-up (confirmed):** the shrink limit was **not** DevTools. Vanilla Discord
  (`discord_desktop_core`) defaults **`MIN_WIDTH=940` / `MIN_HEIGHT=500`**.
- **Fix shipped:** shim zeros ctor mins + no-ops `setMinimumSize` (see AGENT_NOTES § Window minimum size).

### Titlebar X / close does nothing — confirmed bug

- Same dead renderer→main window IPC that broke min/maximize on this frozen build
  (`AGENT_NOTES.md` § Window-control).
- Bridge already had `DCMOD_WINCTL` → `win.close()`, but the renderer left close to Discord’s inert
  handler.
- **Decision:** call `DCModNative.close()` when `aria-label` is `close`.

---

## Bug inventory (review pass)

| Sev | Issue | Phase |
|-----|--------|-------|
| High | Close button not bridged | A |
| High | `clearDeleted()` leaves row classes/`data-dcmod-id`, skips `deletedActions` + observer stop | B |
| Med | Prefetch intent timer not cleared on mouseout | B |
| Med | Ghost-ping log not DEBUG-gated | B |
| Med | Hot-reload reinject broken / misleading | B |
| Med | No Discord-running guard on install/uninstall | C |
| Med | Build-compat stamp missing | C |
| Med | Test coverage gaps for cleanup / bulk / prefetch | D |

---

## Phase A — DevTools off + close bridged

**Branch:** `maintenance/devtools-and-close`

1. Stop forcing `devTools: true`; remove Ctrl+Shift+I handler (keep console→log mirror).
2. Wire titlebar close → `api.close()`.
3. Docs/install text: verify via log file, not DevTools.
4. Re-run `node install.js` after shim change (Discord fully quit).

**Done-check:** log shows ready/health; X closes window; smaller minimize floor; min/max still work.

## Phase B — Correctness bugs

**Branch:** `maintenance/bugfixes`

1. Fix `clearDeleted()` (row attrs, `deletedActions`, `stopObserverIfIdle`).
2. Clear prefetch timer on mouseout.
3. DEBUG-gate ghost-ping logs.
4. Disable broken hot-reload reinject; document full restart for iterate.

**Done-check:** `npm test` + `npm run check`; clearDeleted leaves no stale rows; observer idle.

## Phase C — Discord currency + resilience

**Branch:** `maintenance/discord-update`

1. Check frozen `app-*` vs current Stable; update ritual if behind (user present).
2. Build-compat stamp in shim; renderer warns on drift.
3. Install/uninstall abort if Discord.exe is running.

**Done-check:** health green; stamp matches build; install refuses when Discord is live.

## Phase D — Tests + doc hygiene

**Branch:** `maintenance/tests-docs`

1. Extend `test/pure.test.js` (clearDeleted contract, prefetch href, retention/bulk edges).
2. Align stale AGENT_NOTES / README / PROGRESS / DiscordMod with code.
3. Sign-off style doc audit.

## Phase E — Deferred features → now shipping

**Branch prefix:** `maintenance/<feature-slug>`

1. **Copy message-link / raw content** via shift+right-click (non-deleted messages).
   Deleted preserved rows keep removeLocal. Alt+shift+right-click → raw content.
2. Spellchecker off (needs consent) — see status.
3. MessageStore retention / GIF-favorites cache / offscreen autoplay throttle — see status.

---

## Status

| Phase | Status |
|-------|--------|
| A DevTools + close | done (2026-07-22) |
| B Bugfixes | done (2026-07-22) |
| C Update + stamp + process guard | done (2026-07-22) — live build **1.0.9248**; stamp + process guard shipped; re-run `node install.js` after quit to apply shim |
| D Tests + docs | done (2026-07-22) |
| E Copy message-link/raw | done (2026-07-22) |
| E Spellchecker off + toggle | in progress (2026-07-22) |
| E MessageStore retention / GIF / autoplay | pending |
