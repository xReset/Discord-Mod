# DiscordMod — Active Maintenance Plan

**Created 2026-07-22.** This is the **active** work queue. Historical long-term phases live in
`ROADMAP.md` (kept for reference). Git flow: `maintenance/<phase-slug>` → PR → merge to `main`.

> **Prime directive (unchanged):** a Discord client strictly better than vanilla — faster, lighter,
> no telemetry — plus QOL. Verify per `WORKFLOW.md`. Prefer `logs/discord-console.log` over any
> in-app console (DevTools are intentionally disabled).

---

## Research verdicts (2026-07-22)

### DevTools → larger minimum window — validated (high confidence)

- The shim forced `webPreferences.devTools = true` and bound Ctrl+Shift+I → `toggleDevTools()`.
- Repo has no custom `setMinimumSize` / `minWidth` / `minHeight`.
- Chromium docked DevTools impose their own layout floor; with DevTools open the outer window must
  fit panel + content, so the practical minimize floor grows (~100–200px depending on dock/DPI).
- **Decision:** restore Stable behavior — do not force DevTools on; remove the hotkey. Verify via
  `logs/discord-console.log`.

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

## Phase E — Deferred (not in this pass)

- Spellchecker off (needs consent)
- MessageStore retention / GIF-favorites cache / offscreen autoplay throttle
- Copy message-link via shift+right-click

---

## Status

| Phase | Status |
|-------|--------|
| A DevTools + close | queued |
| B Bugfixes | queued |
| C Update + stamp + process guard | queued |
| D Tests + docs | queued |
| E Deferred features | deferred |
