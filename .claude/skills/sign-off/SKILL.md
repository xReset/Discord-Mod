---
name: sign-off
description: End-of-session wrap-up for the DiscordMod repo. Audits and updates every .md doc so it matches the current code, then git commits and pushes. Trigger when the user says "sign off", "/sign-off", "wrap up", "update the docs and push", or finishes a work session in E:\DiscordMod.
---

# Sign Off — DiscordMod session wrap-up

Run this when finishing work in `E:\DiscordMod`. Goal: leave the repo with **accurate docs** and a
**pushed commit** so the next session (or model) starts from truth, not stale notes.

## Steps

1. **Diff the session.** `git status` + `git diff` (and recall what changed this session). Build a
   short mental list of what actually changed in code/behavior.

2. **Audit every `.md` against the code — do not trust existing prose.** For each doc below, read it
   and fix anything the session made false. Common drift: removed features still described, renamed
   `DCMod.*` console controls, changed install/iterate steps, the current Discord build number.
   - `README.md` — user-facing: features, controls (`DCMod.*`), install/iterate, caveats.
   - `PROGRESS.md` — status line at top + append a dated entry; fix the "planned/done" list.
   - `AGENT_NOTES.md` — hard-won internals + perf rules + **append one changelog line** (bottom).
   - `PLAN.md` — next-build plan; delete abandoned plans, add the real roadmap.
   - `DiscordMod.md` — overview/status/roadmap (this file is mirrored to the Obsidian vault).
   - `WORKFLOW.md`, `SELFBOT_AND_CLIENT.md` — touch only if the session invalidated them.
   Keep entries terse and factual. Quote exact error strings. Note the Discord `app-<version>` a
   fact was observed on. **Update dates to absolute** (today's date).

3. **Verify the renderer still parses** before committing: `node --check src/renderer/renderer.js`.

4. **Commit + push.**
   - If on a feature branch, commit there. If on `main`/default and the user hasn't said to commit to
     it, that's fine for this personal repo — `main` is the working branch here.
   - Stage the doc changes + any code changed this session.
   - Conventional Commits subject (≤50 chars). Body only if the "why" isn't obvious.
   - End the commit message with the Co-Authored-By line.
   - `git push`.

## Notes / guardrails
- This repo's default working branch is `main`; pushing to it is expected.
- Never commit secrets, tokens, or anything under `logs/` (session logs are regenerated each launch).
- If a doc claim references a file/function/flag, confirm it still exists in the code before keeping it.
- Don't invent progress. If something was attempted-but-not-verified, say so in `PROGRESS.md`.
