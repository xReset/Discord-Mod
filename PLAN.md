# DiscordMod — Plan & Undocumented Notes (next agent starts here)

Written 2026-05-30. Read alongside `AGENT_NOTES.md` (internals) and `SELFBOT_AND_CLIENT.md`
(feature map). This file captures the **corrected UX model**, the **next build plan**, and
**important things not yet documented elsewhere**.

---

## CORRECTED UX MODEL (this changes the current UI)

The current panel's text-transform buttons rewrite the message-box draft (one-shot). **That is the
wrong model.** What the user actually wants:

> Buttons = **toggles that ENABLE/DISABLE persistent ambient modes**. Once a mode is on, it applies
> **automatically at send time** to every message — the user types normally and hits Enter; the mod
> transforms the outgoing message itself. No manual "click to rewrite the box" step.

Concretely, the panel should expose **stateful toggles**, not actions:
- **owoify: ON/OFF** — every message you send is owoified pre-send.
- **autoanimate: ON/OFF (+ type)** — every message you send is animated (first frame sent, then edited).
- **visual style: OFF / vaporwave / smallcaps / doublestruck / … ** — every message you send is
  rendered in the chosen static style pre-send.
- **permtyping: ON/OFF** — permanent typing indicator in configured channels.

Plus a **settings/config area** to fine-tune: target **server ID(s)**, **channel ID(s)**,
animation type, owoify intensity, etc. (At least manual ID entry for now.)

The **deleted-viewer toggle works correctly** and is the model to copy (stateful on/off).

### What to do with the current transform buttons
Repurpose them: instead of `applyTransformToInput(fn)` (rewrites the box), they should set a
persistent "outgoing style" mode that the send-hook applies. Keep the pure transform functions in
`transforms` (they're correct and reusable) — only change *when/where* they're applied
(send-time, not draft-time).

---

## NEXT BUILD PLAN (ordered)

### 1. Pre-send hook (foundation for all outgoing modes)
Wrap the outgoing **`sendMessage`**. We already locate the MessageActions object during boot
(`hookOutgoingDeletes` → `findByPropsAll("deleteMessage","editMessage")`). **That same object also
exposes `sendMessage` and `editMessage`** (confirmed: its keys include
`dispatch,subscribe,addInterceptor,wait,register,isDispatching,deleteMessage,editMessage`). So:
- `MA.sendMessage(channelId, message, ...)` — wrap it. `message.content` is the text. If an outgoing
  mode is enabled, transform `message.content` before calling the original. **Static modes
  (owoify/vaporwave/…) → zero flash, zero edits.**
- Guard with a `__dcmodSendHook` flag (boot runs twice via hot-reload; see note below).
- Verify the exact arg shape on build 1.0.9239 by logging the first call's args (cap the log).

### 2. Static outgoing styles (owoify + visual styles)
Once `sendMessage` is wrapped: `message.content = transforms[activeStyle](message.content)`.
Add a settings value `outgoingStyle` (none|owoify|vaporwave|smallcaps|…). Trivial after step 1.

### 3. Pre-send autoanimate (the flagship — see SELFBOT_AND_CLIENT.md deep dive)
- Port the selfbot frame generators from `E:\Selfbot\features\visuals\animations.py`
  (`generate_<type>_frames`): typing, progress, scroll, wave, rainbow, bounce, fade, matrix,
  vaporwave, glitch, neon, 3drotate, particle.
- On send (if autoanimate on): compute `frames = generate(content)`. Send `frames[0]` as the actual
  content (first thing anyone sees = first animation frame, **no plain-text flash**). Capture the
  returned message id, then drive `MA.editMessage(channelId, messageId, {content: frames[i]})` on a
  timer for the rest. Reuse the selfbot's adaptive delay logic
  (`compute_rate_adjusted_delay`) and respect Discord edit rate limits.
- `sendMessage` may be async / return a promise resolving to the created message — confirm and chain.

### 4. permtyping (client-side)
- Find the typing action (TypingActions / `startTyping`): try
  `findByPropsAll("startTyping","stopTyping")`. It hits `POST /channels/{id}/typing`.
- Loop `startTyping(channelId)` every ~7s per configured channel (Discord's indicator lasts ~10s;
  selfbot uses 7s — see `E:\Selfbot\features\permtyping\manager.py`). Cap channels (selfbot caps 50).
- Channels come from the settings panel (manual IDs for now).

### 5. Settings / config UI + persistence
- Add a settings sub-view to the panel: text inputs for server ID / channel IDs, selects for
  animation type + owoify intensity + outgoing style, toggles per mode.
- **Persistence:** the renderer runs in the page main world → use `localStorage` (namespace keys
  `dcmod:*`). No fs from the renderer. Load settings on boot, save on change. (Discord uses
  localStorage heavily; keep our keys namespaced and small.)

---

## IMPORTANT UNDOCUMENTED NOTES (capture before they're lost)

- **MessageActions object** found via `findByPropsAll("deleteMessage","editMessage")` is an aggregate
  that ALSO has `sendMessage`, `editMessage`, and flux methods. Use it for the send/edit hooks too —
  no need to find a separate module.
- **Slate message box** = `[data-slate-editor="true"]` (fallback `div[role="textbox"]`).
  `document.execCommand("insertText", false, text)` after selecting its contents DOES write into the
  Slate editor (used by the current — to-be-repurposed — transform buttons). Useful if a feature ever
  needs to set the draft, but **outgoing modes should hook `sendMessage`, not the box.**
- **Double-boot artifact:** the shim's `fs.watch` hot-reload reinjects the renderer via
  `executeJavaScript` whenever `src/renderer/` changes. That reinject re-runs `boot()` in a context
  whose `console` is NOT captured to the log, and sets `window.__DCMOD_LOADED__=false` first. Net
  effect: idempotency guards (`__dcmodWrapped`, `__dcmodDelHook`, and any future `__dcmodSendHook`)
  are REQUIRED — you will sometimes see "already hooked" on what looks like a first boot. This is
  expected, not a bug. Always guard new global hooks the same way.
- **`tools/restart.ps1` uses `Stop-Process` without `-Force`** (to avoid the logout risk). It usually
  restarts cleanly, but if Discord doesn't die within the 3s wait the relaunch may attach to the
  existing instance (no true restart). Confirm a fresh boot via the `diag url=…`/`chunkLen` line in
  the log, not just by assuming the restart worked.
- **Iteration loop reminder:** edit `src/renderer/renderer.js` → restart Discord (hot-reload runs but
  its logs aren't captured, so restart is the reliable path). Watch `logs/discord-console.log` via
  `tools/status.sh`. Full internals/perf rules in `AGENT_NOTES.md`.
- **Perf:** outgoing-mode hooks run on the send path (rare events) — cheap. Autoanimate's edit loop is
  the only sustained cost; cap frame count + respect edit rate limits, and stop the loop if the user
  navigates away. Keep the many-servers principle (`AGENT_NOTES.md` perf section).

---

## STATUS SNAPSHOT (what works today, commit 40b418c)

- ✅ Deleted-message viewer: others' deletes preserved red (row-based, gif/embed-safe); your own
  deletes vanish (`deleteMessage` hook); shift+right-click removes; retention cap 500.
- ✅ Real FluxDispatcher hooked via `Function.prototype.m` capture + score-pick.
- ✅ UI panel (black/white) with working deleted-viewer toggle/clear.
- ⚠️ Text-transform buttons exist but use the WRONG model (draft rewrite). **Repurpose to toggles.**
- ⛔ Not built yet: send-time outgoing styles, owoify-mode, autoanimate, permtyping, settings UI,
  persistence. ← this plan.
