# Selfbot ↔ Client Mod — Feature Map & Migration Plan

Master reference tying together the two codebases and what should move from one to the other.

- **Selfbot** — `E:\Selfbot` (Python, discord.py-self). Headless, server-side, runs 24/7. Sees
  messages only *after* Discord's gateway broadcasts them. Acts on Discord's data (everyone sees).
- **Client mod** — `E:\DiscordMod` (JS, Electron-injected). Runs *inside* the user's client, on the
  path between keyboard/eyes and Discord's servers. Acts on the local view + the user's own input,
  **before** messages are sent. See `DiscordMod.md` / `AGENT_NOTES.md` for client internals.

They are **complementary**. The selfbot is best at background automation and reacting to others; the
client mod is best at UI, revealing hidden info, and **pre-send transforms with zero flash**.

---

## Why pre-send matters (the core thesis)

The selfbot's visual features all work the same way: **send a plain message, then edit it repeatedly**
to animate/style it. Two unavoidable costs:

1. **Flash** — the first thing everyone sees is the *plain, untransformed* text (and an `(edited)` tag
   appears once it starts editing).
2. **Rate limits** — every frame is a `PATCH` edit; long/fast animations get throttled.

The client mod can transform the message **before it ever leaves the client**:

- **Static effects** (vaporwave, zalgo, smallcaps, owoify, …) → the message is sent already styled.
  **Zero flash, zero edits, no `(edited)` tag, no rate limit.** Strictly better than the selfbot.
- **Animations** (typing, rainbow, matrix, …) → the **first sent frame is already the first animation
  frame** (no plain-text flash), then the client drives the edit loop. Still uses edits for subsequent
  frames, but the opening frame is correct instantly — exactly the user's goal: "the first message is
  the animated text."

This is why `autoanimate` is the flagship migration target.

---

## Selfbot feature inventory (complete)

Command prefix is `--`. Grouped by category. Source: `E:\Selfbot\features\*`, `core/selfbot/help_data.py`.

### Visuals / text (prime client-mod candidates)
| Feature | Command | What it does |
|---|---|---|
| **autoanimate** | `--autoanimate start <type>` / `stop` | Auto-animates every message you send in enabled channels |
| **animate** | `--animate <type> <text>` | One-off animation. Types: typing, progress, scroll, wave, rainbow, bounce, fade, matrix, vaporwave, glitch, neon, 3drotate, particle |
| **flash** | `--flash <text>` | Quick reveal animation |
| **glitch** | `--glitch <text> [mild\|extreme]` | Zalgo/glitch text |
| **vaporwave** | `--vaporwave <text>` | Fullwidth aesthetic |
| **spoilerify** | `--spoilerify <text>` | Wrap each char in `\|\| \|\|` |
| **bigtext** | `--bigtext <text>` | Regional-indicator emoji text |
| **smallcaps / doublestruck / script** | `--smallcaps`, `--ds`, `--script` | Unicode font transforms |
| **invis** | `--invis [count] [fade]` | Zero-width / invisible text |
| **split** | `--split <text> [--chunk] [--delay]` | Split long text into timed messages |
| **owoify** | `--owoify start [owo\|uwu\|uvu]`, `stutter`, `kaomoji` | Transforms your outgoing text to owo-speak |

### Animated identity
| Feature | Command | What it does |
|---|---|---|
| **animnick** | `--animnick set <frames…>` / `start` | Animates *your* nickname across frames; placeholders `{count}`,`{time}` |
| **othernick** | `--othernick <guild> <member> <frame>` | Animates *another member's* nickname (needs perms) |
| **msgcount** | `--msgcount quick <server> "<frame>"` | Live message-count nickname/label, `{count}` placeholder |

### Message ops / moderation (mostly stay selfbot)
| Feature | Command | What it does |
|---|---|---|
| **snipe** | `--snipe`, `--editsnipe`, `--snipesearch`, `--snipeexport`, `--snipestats`, `--snipeself` | Logs & retrieves deleted/edited messages (DB-backed) |
| **purge** | `--purge <limit> [@user\|links\|…]` | Bulk delete your messages by filter |
| **removeall** | `--removeall start [channel]` / `turbo` / `finddm` | Mass-delete your messages everywhere |
| **autodelete** | `--autodelete start` | Auto-deletes your messages after a delay |
| **bulk_delete** | (internal) | Bulk deletion engine |
| **ghostping** | `--ghostping start` | Detect/handle ghost pings |
| **slowmode** | (internal) | Slowmode handling |

### Mimicry / reactions
| Feature | Command | What it does |
|---|---|---|
| **mimic** | `--mimic add <channel> [cd]` / `start` | Re-posts channel messages (channel mirror) |
| **usermimic** | `--usermimic add @user <channel>` | Mimics a specific user |
| **autoreact** | `--autoreact <channel> <emoji>` | Auto-reacts in a channel (chance configurable) |
| **selfreact** | `--selfreact start <emoji>` | Auto-reacts to your own messages |
| **gifrelay** | `--gifrelay start` | Relays GIFs from any channel to a fixed relay channel |

### Presence / activity
| Feature | Command | What it does |
|---|---|---|
| **permtyping** | `--permtyping start [channels]` | Permanent typing indicator (≤50 channels); 7s re-trigger loop |
| **xpfarm** | `--xpfarm start [channel] [--threshold] [--cooldown]` | Auto-sends to farm leveling XP |
| **counting** | `--counting start` | Auto-plays counting-channel games |
| **restdetection** | `--restdetection start` | Detects "rest" events; webhook + auto-react |

### Data / ops / infra
| Feature | Command | What it does |
|---|---|---|
| **export** | `--export <channel> [ai\|jsonl\|md\|text\|csv] [limit]` | Channel export, auto-chunked at 1.5MB |
| **channelscan** | `--channelscan <server> [--detailed] [--export]` | Scan/enumerate a server's channels |
| **msglog / weblog** | `--msglog start` / `webhook <url>` | Mirror messages to a webhook |
| **webhook_logger** | (internal) | Webhook logging engine |
| **channel_stats / stats_commands / msgcount** | `--msgcount`, stats | Message/channel statistics |
| **memory** | `--memory stats\|cleanup\|history` | Selfbot memory monitor |
| **health** | `--health` | Health check |
| **spam** | `--spam <channel> <text[,..]> [delay]` | Timed multi-message sender |
| **persistence / reloadconfig / vacuum** | `--rcfg`, `--vacuum` | State persistence & maintenance |

---

## Transferability matrix

Legend: **CLIENT-WIN** = client does it strictly better (pre-send, no flash) · **CLIENT-OK** = works
client-side, comparable · **BOTH** = useful in both, different scope · **STAY** = keep on selfbot
(needs 24/7/headless/background) · **N/A** = doesn't fit the client.

| Feature | Verdict | Notes |
|---|---|---|
| autoanimate | **CLIENT-WIN** | Flagship. Pre-send first frame = no plain-text flash. See deep dive below. |
| animate / flash | **CLIENT-WIN** | Same engine, triggered on your outgoing message. |
| vaporwave / zalgo(glitch) / bigtext / smallcaps / doublestruck / script / spoilerify | **CLIENT-WIN** | Pure string transforms → zero-flash, zero-edit pre-send. Easiest first wins. |
| owoify | **CLIENT-WIN** | Pure transform of *your* outgoing text → pre-send, no edit/flash. |
| invis / split | **CLIENT-OK** | Pre-send rewrite; split = client sends N messages. |
| permtyping | **CLIENT-OK** | Client can drive the typing indicator directly while open. Selfbot keeps it when client closed. **BOTH** really. |
| animnick / othernick / msgcount(nick) | **BOTH** | Client can animate nick while open; selfbot persists 24/7. |
| snipe (deleted/edited viewer) | **CLIENT-WIN (partial)** | We already do live deleted-message view client-side (better UX than `--snipe` retrieval). Selfbot's DB/history/search stays. |
| autoreact / selfreact | **CLIENT-OK** | Doable client-side while open; selfbot for 24/7. |
| mimic / usermimic / gifrelay / counting / xpfarm / restdetection | **STAY** | Background automation; must run when client is closed. |
| purge / removeall / autodelete / bulk_delete | **STAY** | Bulk/background ops; selfbot's job. (Client could trigger UI, low value.) |
| export / channelscan / msglog / stats / memory / health | **STAY** | Infra/ops, headless. |
| spam | **STAY** | Background sender. |

**Migration priority (recommended order):**
1. Static text transforms (vaporwave, smallcaps, owoify, …) — trivial, immediate "no flash" payoff.
2. Pre-send **autoanimate** (first frame correct on send, client drives edits).
3. permtyping (client-side while open).
4. Inline edit-history / richer deleted view (extends the snipe idea).

---

## Deep dive: pre-send autoanimate migration

### How the selfbot does it today
`features/visuals/animations.py` + `commands.py`:
- Each animation has a `generate_*_frames(text)` producing a list of string frames, and a
  `get_*_first_frame(text)` helper.
- `autoanimate` listens for *your own* `MESSAGE_CREATE`, then calls `flash_message_effect` /
  `*_animation(message, text)` which **edits the already-sent message** frame by frame
  (`rate_limited_edit`). `skip_first=True/False` controls whether the first frame is the original
  text (because the plain message was already sent).
- Net effect: **plain text appears first**, then animates via edits. Visible flash + `(edited)` tag.

Frame generators worth porting (pure functions, no Discord coupling):
`typing, progress, scrolling, wave, rainbow, bounce, fade, matrix, vaporwave, glitch, neon,
3d_rotate, particle, enhanced_vaporwave, thinking_reveal`. Static: `zalgo, vaporwave, spoiler,
bigtext, smallcaps, doublestruck, script` + owoify transformer.

### How the client mod should do it
The client sits **before** the send. Two cases:

**A. Static transforms (no animation)** — the simplest and biggest win:
1. Intercept the outgoing send (patch Discord's `sendMessage`-style module; find via a code-string
   like `findByCode("sendMessage")` / the action carrying `sendMessageOptions` we already observed in
   `MESSAGE_CREATE keys=[…,message,optimistic,sendMessageOptions,…]`).
2. Replace `content` with `transform(content)` (port the Python transformer to JS).
3. Send proceeds normally → the message is **born styled**. No edit, no flash, no `(edited)`, no rate
   limit.

**B. Animations (multi-frame)**:
1. On send, compute `frames = generate_<type>_frames(content)`.
2. **Send `frames[0]` as the actual message content** (not the plain text) → first thing anyone sees
   is already the first animation frame. No plain-text flash.
3. Then drive the edit loop client-side for `frames[1..n]` (same cadence logic as the selfbot's
   `compute_rate_adjusted_delay`). Edits still happen, but the *opening* is correct instantly.
4. Optionally: since we already hold the FluxDispatcher, the client can be smarter about pacing than
   the headless bot (it knows render/visibility state).

### Implementation hooks we already have
- **Webpack require + module access** — via the `Function.prototype.m` capture (see `AGENT_NOTES.md`).
  Use it to `findByCode`/`findByProps` the message-send module.
- **FluxDispatcher** — found & wrapped; we can observe/redirect message actions.
- **Outgoing message shape** — confirmed live: `MESSAGE_CREATE` with
  `{type, channelId, message, optimistic, sendMessageOptions, isPushNotification}` and
  `LOCAL_MESSAGE_CREATE {type, message}`. The real send is an HTTP POST in the messages module —
  patch the function that builds/sends it to rewrite `content` pre-send.

### Open questions to resolve when building it
- Exact send module + minify-stable code string on build 1.0.9239 (use moonlight-style `findByCode`).
- Per-channel enable + a UI toggle (client can render real UI — no more `--` commands).
- Edit-driven animations must respect Discord's edit rate limits; reuse the selfbot's adaptive delay.

---

## Cross-references
- Client internals, dispatcher discovery, perf notes: `AGENT_NOTES.md`
- Client overview & roadmap: `DiscordMod.md`
- Selfbot architecture: `E:\Selfbot\docs\ARCHITECTURE.md`, feature help: `core/selfbot/help_data.py`
