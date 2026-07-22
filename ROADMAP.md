# DiscordMod — Long-Term Roadmap (perfect + maintainable)

**Created 2026-06-30.** Historical long-term plan (direction + completed phases below).
**Active work queue:** [`MAINTENANCE_PLAN.md`](MAINTENANCE_PLAN.md) (2026-07-22 onward).
`PLAN.md`'s Tier-1/2/3 feature list is folded into **Phase 5** below. Read `WORKFLOW.md` +
`AGENT_NOTES.md` before executing any phase.

> **Prime directive (unchanged):** a Discord client **strictly better than vanilla** — faster,
> lighter, no telemetry — plus QOL (snipe, copy-avatar, …). Optimizations must never cost anything
> the user notices. Every change verified per `WORKFLOW.md` (syntax check → boot clean → feature
> works in the log → user confirms UI). No change is "done" until it passes its stated check.

Current state: build **1.0.9243** (frozen). See `PROGRESS.md` and `MAINTENANCE_PLAN.md`.

---

## Status (2026-06-30) — historical; active queue is MAINTENANCE_PLAN.md

- **Phase 0 — DONE.** Updated 9240→9243, verified clean (internals unchanged).
- **Phase 1 — DONE.** Mixed-bulk data loss, dead/dangerous `findModuleBySource`, `allowDelete` leak,
  preload-race all fixed + verified (0 boot errors). Picker scroll-jank fix shipped (item 5) — *needs an
  eyeball to confirm no open-flicker + smooth scroll.*
- **Phase 2 — DONE.** Dead code removed; dev logs DEBUG-gated (quiet sessions).
- **Phase 3 — DONE (in-file, single-IIFE).** Settings persist (localStorage); constants already named
  consts. (Multi-file split dropped — see below.)
- **Phase 4 — DONE.** Health line + safe source-fallback locator + `test/pure.test.js` (6/6).
- **Phase 5 — PARTIAL.** Built + verified: **edit-snipe** (`DCMod.editSnipe`), **ghost-ping snipe**
  (orange style, `DCMod.ghostPings`), **hover-prefetch** (`DCMod.prefetch` — fired live on 9243, fetch
  signature confirmed, 0 errors). Deferred (reasons): MessageStore-retention (stale/memory risk),
  GIF-favorites cache (complexity), spellchecker-off (needs consent — loses red-underline),
  offscreen-autoplay-throttle (playback risk). Extend-telemetry-blocklist skipped (needs live observation
  first — blind additions risk dropping functional dispatches).

Idle self-overhead held at **0** across every restart (see the benchmark discipline: `intN/obsN/intMs/obsMs`
stay 0 in every `perf baseline`). Snipe/telemetry/copy-avatar/winctl all report `ok` on the boot health line.

## How to read this file

Phases are ordered by **risk-adjusted value**: update first (the ask), then correctness bugs,
then remove dead weight, then the architecture that makes everything after cheap, then resilience,
then new features. Each item: **what → why → touch → done-check**. Do phases in order; inside a
phase, top-to-bottom. Don't start a later phase until the earlier one's done-checks pass.

---

## Phase 0 — Update to latest Discord, verify nothing broke  *(the immediate ask)*

**Delta is small (9240 → 9243, 3 builds) → internals almost certainly unchanged → low risk.**
This is an interactive, logout-capable operation (documented ×3 logout history) and needs a
**visual** confirmation of snipe that only the user can give. Drive it with the user present.

Steps (from README / AGENT_NOTES, exact):
1. `tools\unfreeze-version.ps1`  — lift the folder-create deny.
2. Launch Discord, let it self-update to `app-1.0.9243`, then **fully quit** (tray → Quit).
3. `node install.js`  — re-detects newest `app-<ver>`, re-patches the shim.
4. `tools\freeze-version.ps1`  — re-block auto-update.
5. Restart Discord → `Ctrl+Shift+I` → console.

**Done-check (all must hold):**
- `bash tools/wait-ready.sh` → `dispatcher hook installed` + `ready ✓`.
- Log shows `diag dispatcherFound=true hasAddInterceptor=true`.
- Someone else deletes a message in a viewed channel → row turns **red** (user confirms visually).
- Your own delete still vanishes; **shift+right-click** a red row removes it.
- No `interceptor error` / `scan threw` / `wrap error` lines.
- Copy-Avatar, fast-UI, min/maximize buttons still work (quick visual pass).

**If something broke** (unlikely at this delta): the dispatcher prop-scan or a DOM id changed —
that's exactly what **Phase 4** hardens against. Fall back to the minify-stable source locators in
`AGENT_NOTES.md`.

---

## Phase 1 — Correctness bugfixes (small, surgical, high-confidence)

Do these as isolated edits, each verified before the next.

1. **Mixed bulk-delete data loss** — `renderer.js:698-702`.
   - *Bug:* on `MESSAGE_DELETE_BULK`, if only *some* ids are allow-listed, `result` stays `false`,
     Discord runs the full bulk delete, and the ids we `markDeleted` get wiped from the store.
   - *Fix:* when `block.length` is between 1 and `ids.length-1`, don't pass the original action
     through. Rewrite `action.ids` in place to only the allow-listed ids (let those delete), keep the
     blocked ones preserved, and return `false` so the trimmed delete proceeds. Or block the whole
     action and re-dispatch a delete only for the allowed subset. Prefer the in-place trim.
   - *Done:* self-delete 1 of N in a bulk-deleted set → your one vanishes, the other N-1 stay red.

2. **Remove `findModuleBySource`** — `renderer.js:316-328`.
   - *Why:* it force-executes `wreq(id)`, the one thing AGENT_NOTES bans (corrupts modules, can hide
     the dispatcher). It's currently **unreferenced** → pure landmine.
   - *Fix:* delete the function. If a source-string locator is ever needed, Phase 4 adds a **safe**
     one that scans `wreq.m[id].toString()` WITHOUT executing.
   - *Done:* `node --check` passes; grep confirms no caller; boot still finds dispatcher.

3. **`allowDelete` leak guard** — `renderer.js:652` (+ hook at `638`).
   - *Fix:* cap the Set (e.g. 200) with oldest-eviction, or stamp each id with a timestamp and sweep
     entries older than ~60s on insert. Consumed-on-dispatch stays the common path; this just bounds
     the failure case.
   - *Done:* rapid self-deletes that never dispatch don't grow the Set unbounded (log its size).

4. **Multi-window preload race** — `install.js:141`.
   - *Fix:* stop stashing the original preload in a single `process.env` slot. Key it per-window
     (map window id → original preload) or resolve the original preload path once at shim build time
     (it's stable) and bake it in. Removes the "last window wins" hazard for popouts.
   - *Done:* open a popout (e.g. a call/voice popup) → both it and the main window inject cleanly.

5. **Picker scroll jank (GIF-favorites / stickers / emoji)** — `renderer.js:486-491` (fastUI
   picker exception). **Reported symptom:** scrolling favorited GIFs / stickers / the expression
   picker feels buggy / jittery / ghosting.
   - *Leading cause (our code):* the open-flicker fix restores `transition-property: opacity;
     duration: .15s` on **`[class*="expressionPicker"] *`** — *every descendant, permanently*. The
     picker grid is **virtualized**: rows mount/unmount continuously as you scroll, so each newly
     mounted row runs a .15s opacity fade-in → continuous ghosting on fast scroll. The fade was only
     ever meant to mask the **open** pop, not to run on every row during scroll.
   - *First step — confirm ownership (A/B, ~10s, no code):* open the picker → `DCMod.fastUI(false)`
     → scroll. **Smooth ⇒ it's us** (fix below). **Still janky ⇒ it's Discord's virtualized scroller
     / GIF autoplay**, not fastUI → route to Tier-2 #6 (offscreen-autoplay throttle) or accept as
     out-of-scope Discord behavior.
   - *Fix (if ours):* stop applying the opacity fade to the virtualized grid rows. Options, best
     first:
     1. Scope the fade to the picker **root/container** only (the element that actually fades in on
        open), NOT `[class*=expressionPicker] *`. Target the wrapper class, not every descendant.
     2. Or time-box it: only honor the fade for ~200ms after the picker opens (add/remove a
        `dcmod-picker-opening` class on open), so scroll-mounted rows never fade.
     3. Or explicitly exclude the scroller + its row children from the opacity restore
        (`:not([class*=scroller]) :not([class*=list])`-style carve-out) so only the picker chrome
        fades, not the grid.
   - *Guardrails from `AGENT_NOTES.md` (do not regress):* the ORIGINAL open-flicker bug came from
     the `*` transition-kill collapsing Discord's grid fade to ~0. Whatever the new scope, re-verify
     the picker still **opens without flicker** AND scrolls smoothly. **Never restore `transform`/`all`
     transitions on the grid** — that animates virtualized row repositioning = worse jitter (this is
     exactly why the current fix is opacity-only). Diagnose the same way the flicker was
     (`--remote-debugging-port=9222` CDP, measure which picker els have which transitions on open vs
     during scroll).
   - *Done:* GIF-favorites / sticker / emoji picker (a) opens with no flicker, (b) scrolls smoothly
     with fastUI ON — user confirms both visually. Add an `AGENT_NOTES.md` entry recording the
     picker's virtualized-scroller class + the final scope that fixed it.

---

## Phase 2 — Delete dead weight (lighter ship, less to maintain)

Nothing here changes behavior; it removes code that only costs reading time and bundle size.

1. **Remove `exportCandidates`** (`renderer.js:333`) — defined, never called.
2. **Quiet dev logging** — gate `_msgActionLog` first-80 delete dump (`renderer.js:686-689`) and the
   5-min `perf interval` sampler (`renderer.js:1271`) behind a single `DEBUG` flag (default off) so
   normal sessions don't accrue log lines for hours.
3. **Split the benchmark harness out of the hot path.** `bench`/`autoBench`/`scrollFor`/`findScroller`/
   `perfSnapshot`/`perfReset`/`_perf` (~180 lines, `renderer.js:99-199, 1126-1204`) are dev-only A/B
   tooling shipped to every user. Move them into a separate `src/renderer/debug.js` that's only
   injected when `DEBUG` is set (or loaded on first `DCMod.autoBench()` call). Keep `DCMod.perf()` as
   a thin always-on snapshot.
   - *Done:* renderer boots + all features work with the harness excluded; `DCMod.autoBench()` still
     works when DEBUG on.

---

## Phase 3 — Maintainability, IN-FILE  *(respect the single-IIFE rule)*

**Decision (2026-06-30):** `WORKFLOW.md` rule 2 mandates the renderer stay **one IIFE**. A multi-file
split + bundler would contradict the project's own contract AND is the change least verifiable without
a screen. So maintainability is delivered *inside* the single file — same payoff, far less risk. (The
old "split into ES modules + esbuild" plan is dropped.)

1. **`CONFIG` block at the top of the IIFE** — hoist every magic constant into one object:
   `RETENTION_CAP`, `ALLOW_DELETE_CAP`, `MAX_PUSHES`, poll delays, `PERF_INTERVAL_MS`, telemetry regex
   source, `DEBUG`. One place to tune; no more numbers scattered across 1300 lines.
2. **Persist settings** to `localStorage` (`dcmod:settings`): `noTrack`, `fastUI`, `enabled`, `DEBUG`.
   Read at boot (defaults preserved), write on every `DCMod.*` toggle. So `DCMod.fastUI(false)` and
   friends survive a restart instead of resetting to default each launch.
3. **Clear section banners** — the file is already sectioned; ensure each feature block has a header
   comment so navigation stays easy. No logic moves. (Surgical: comments only.)

**Done-check:** identical boot log to pre-change; a toggled setting (e.g. `fastUI(false)`) persists
across a restart (verify via the boot log reading the stored value). Ships **no behavior change** for
default settings.

---

## Phase 4 — Resilience against Discord updates  *(kills the main ongoing cost)*

The docs name maintenance-vs-Discord-updates as the #1 cost. Make breakage **loud and localized**
instead of silent.

1. **Fallback locators (safe, no force-execute).** Today the dispatcher is found only by live-prop
   scan; if that ever returns 0, the mod silently half-boots. Add source-string fallbacks scanning
   `wreq.m[id].toString()` **without executing** (only execute the ONE matched id, which is safe):
   - FluxDispatcher: `"Dispatch.dispatch(...) called without an action type"` / `"_dispatchWithDevtools("`
   - MessageStore: `'"MessageStore"'`  (already listed in AGENT_NOTES).
   Use these only when the prop-scan yields nothing.
2. **Boot self-check / health line.** After boot, log a single structured health line:
   `health dispatcher=ok interceptor=ok deleteHook=ok userStore=ok avatarMenu=ok winctl=ok build=<ver>`.
   Any `=fail` is the first thing to grep after a Discord update. Cheap, one line, huge triage win.
3. **Build-compat stamp.** `install.js` writes the patched Discord build (`1.0.9243`) into the shim;
   renderer logs `build changed <old>→<new>` if the running build differs from the last-validated one
   → instant "internals may have moved" signal instead of mystery breakage.
4. **Unit tests for pure logic.** Extract and test (plain `node --test`, no Discord needed):
   `_parseAvatarSrc`, `_globalAvatarUrl`/`_guildAvatarUrl`, `_channelOf`/`_idOfRow` regexes,
   retention eviction, telemetry regex (matches known telemetry URLs, rejects functional API URLs).
   - *Done:* `npm test` green; these are the bits that silently rot on updates.

**Done-check:** simulate a locator miss (temporarily break the prop-scan) → source fallback finds the
dispatcher; health line reports each subsystem; tests pass.

---

## Phase 5 — Feature roadmap (only after 1–4; from `PLAN.md`, highest felt-impact first)

Each is now cheap to add because it's a `features/*.js` module with a health entry + persisted toggle.

**Tier 1 — perceived speed:**
1. **Hover-prefetch DMs/channels** — on ~120ms intent hover, fire Discord's `loadMessages` so the
   channel opens instantly. Recon: `findByProps("fetchMessages"/"loadMessages")`. Bound it (small
   eager fetch, not a storm; debounce, cap in-flight).
2. **MessageStore retention across navigation** — pin last N channels' stores so back/forward is
   instant. Recon: MessageStore (use the Phase-4 source locator).
3. **GIF-favorites instant render** — cache favorites list + thumb URLs (localStorage/IDB), paint
   from cache, revalidate in background. Kills the picker spinner.

**Tier 2 — resource-saving:**
4. **Spellchecker off** (`webContents.session.setSpellCheckerEnabled(false)`) — main-process shim
   edit + repack. Trade: loses red-underline. Confirm with user first.
5. **Extend dispatch block-list** to experiment-exposure / extra analytics types (log what fires,
   then add to the drop list).
6. **Throttle offscreen GIF/video autoplay** beyond Discord's defaults.

**Tier 3 — QOL (snipe family):**
7. **Edit-snipe** — record pre-edit content on `MESSAGE_UPDATE` (dispatcher already intercepted).
8. **Ghost-ping snipe** — catch a mention deleted before you read it.
9. **Copy message-link / raw content** via the shift+right-click menu we already own.

> **Out of scope (abandoned, do not resurrect):** UI panel, send-time text transforms. Those are a
> selfbot concern (see `SELFBOT_AND_CLIENT.md`); this mod's value is client speed + QOL.

---

## Definition of "perfect + maintainable" (the finish line)

- ✅ Runs on the current Discord stable; updates are a documented 5-step ritual with a health-check
  that instantly says what (if anything) moved.
- ✅ Zero dead/dangerous code; zero force-execution; dev tooling excluded from normal sessions.
- ✅ Modular source + one-command build/watch; pure logic unit-tested.
- ✅ Settings persist; constants centralized; no magic numbers.
- ✅ Every feature is an isolated module with a toggle + a health line — new features don't touch the
  core, and a broken feature can't silently take down snipe.
- ✅ Idle self-overhead stays ~0 (the existing bar; re-verify with `autoBench` after Phase 3).

---

## Execution order summary

`Phase 0 (update+verify)` → `Phase 1 (bugfixes)` → `Phase 2 (dead code)` → `Phase 3 (modularize+build+persist)`
→ `Phase 4 (resilience+tests)` → `Phase 5 (features)`.

Each phase ends with its done-check + a one-line `AGENT_NOTES.md` changelog entry. Commit per phase
(user asks). `/sign-off` to audit docs + push.
