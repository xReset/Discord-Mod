/* Unit tests for DiscordMod's pure logic — the bits that silently rot when Discord
 * updates or someone tweaks a regex. Run: `node --test` (or `npm test`).
 *
 * Strategy: for regexes we assert the renderer.js SOURCE still contains the exact
 * literal we test (a drift guard) AND that the compiled regex behaves correctly. So
 * if someone edits the pattern in the renderer without updating the test, the drift
 * guard fails loudly instead of the test passing against a stale copy.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "renderer.js"), "utf8");

test("telemetry regex: blocks telemetry, allows functional API", () => {
  const literal = "\\/api\\/v\\d+\\/(science|metrics|track)\\b|\\/error-reporting|\\bsentry\\.io\\b|\\/observability(-relay)?\\b|\\/rtc\\/quality";
  assert.ok(SRC.includes(literal), "drift: _TELEMETRY_RE literal changed in renderer.js — update this test");
  const re = new RegExp(literal, "i");

  // BLOCK — known telemetry endpoints
  for (const u of [
    "https://discord.com/api/v9/science",
    "https://discord.com/api/v6/metrics",
    "https://discord.com/api/v9/track",
    "https://sentry.io/api/123/envelope",
    "https://discord.com/error-reporting/x",
    "https://discord.com/api/v9/rtc/quality",
    "https://discord.com/observability-relay/x",
  ]) {
    assert.ok(re.test(u), "should BLOCK telemetry url: " + u);
  }

  // ALLOW — functional API must never be dropped
  for (const u of [
    "https://discord.com/api/v9/users/@me",
    "https://discord.com/api/v9/channels/123/messages",
    "https://discord.com/api/v9/tracking-settings", // 'tracking' != 'track\\b'
    "https://cdn.discordapp.com/avatars/1/x.png",
    "https://discord.com/api/v9/guilds/1/members",
  ]) {
    assert.ok(!re.test(u), "should ALLOW functional url: " + u);
  }
});

test("avatar src parsing: guild vs global vs default", () => {
  // Mirrors _parseAvatarSrc in renderer.js
  const guildLit = "\\/guilds\\/(\\d+)\\/users\\/(\\d+)\\/avatars\\/";
  const globalLit = "\\/avatars\\/(\\d+)\\/";
  assert.ok(SRC.includes(guildLit), "drift: guild-avatar regex changed");
  assert.ok(SRC.includes(globalLit), "drift: global-avatar regex changed");
  const parse = (s) => {
    let m = s.match(new RegExp(guildLit));
    if (m) return { guildId: m[1], userId: m[2] };
    m = s.match(new RegExp(globalLit));
    if (m) return { userId: m[1] };
    return null;
  };
  assert.deepStrictEqual(
    parse("https://cdn.discordapp.com/guilds/111/users/222/avatars/abc.png"),
    { guildId: "111", userId: "222" }
  );
  assert.deepStrictEqual(
    parse("https://cdn.discordapp.com/avatars/222/hash.png?size=4096"),
    { userId: "222" }
  );
  assert.strictEqual(parse("https://cdn.discordapp.com/embed/avatars/3.png"), null); // default → no id
});

test("row-id → message-id: trailing 17-20 digits", () => {
  const lit = "\\/(\\d{17,20})$\\/"; // used as /(\\d{17,20})$/ in renderer
  assert.ok(SRC.includes("(\\d{17,20})$"), "drift: _idOfRow regex changed");
  const re = /(\d{17,20})$/;
  assert.strictEqual("chat-messages-123-456789012345678901".match(re)[1], "456789012345678901");
  assert.strictEqual("chat-messages___456789012345678901".match(re)[1], "456789012345678901");
  assert.strictEqual(re.test("no-digits-here"), false);
});

test("default-avatar index: discriminator vs new-username id-based", () => {
  // Mirrors _globalAvatarUrl's default branch
  const idx = (user) => {
    if (user.discriminator && user.discriminator !== "0") return parseInt(user.discriminator, 10) % 5;
    return Number((BigInt(user.id) >> 22n) % 6n);
  };
  assert.strictEqual(idx({ id: "1", discriminator: "1234" }), 4); // 1234 % 5
  assert.strictEqual(idx({ id: "1", discriminator: "0007" }), 2); // 7 % 5
  // new-username (discriminator "0") → (id >> 22) % 6, deterministic
  const v = idx({ id: "80351110224678912", discriminator: "0" });
  assert.ok(v >= 0 && v < 6);
});

test("retention/allow-list eviction: bounded, oldest-first", () => {
  // Mirrors the `while (set.size > CAP) set.delete(set.values().next().value)` guard.
  const CAP = 200;
  const s = new Set();
  for (let i = 0; i < 1000; i++) {
    s.add("id" + i);
    while (s.size > CAP) s.delete(s.values().next().value);
  }
  assert.strictEqual(s.size, CAP, "size must stay bounded at CAP");
  assert.ok(!s.has("id0"), "oldest must be evicted");
  assert.ok(s.has("id999"), "newest must be retained");
  assert.ok(s.has("id800"), "the last CAP entries are retained");
});

test("bulk-delete trim: mixed batch keeps blocked ids, deletes allowed", () => {
  // Mirrors the fixed MESSAGE_DELETE_BULK path: trim action.ids to only allow-listed.
  const allowDelete = new Set(["a", "c"]);
  const action = { type: "MESSAGE_DELETE_BULK", ids: ["a", "b", "c", "d"] };
  const block = action.ids.filter((x) => !allowDelete.has(x)); // ['b','d'] stay red
  let result = false;
  if (block.length === action.ids.length) result = true;
  else if (block.length > 0) {
    const blockSet = new Set(block);
    action.ids = action.ids.filter((x) => !blockSet.has(x)); // ['a','c'] delete
  }
  assert.strictEqual(result, false, "mixed batch must not block the whole action");
  assert.deepStrictEqual(action.ids, ["a", "c"], "only allow-listed ids delete");
  assert.deepStrictEqual(block, ["b", "d"], "others' ids preserved (stay red)");
});

test("bulk-delete: all blocked → result true; all allowed → pass-through; empty ids", () => {
  const run = (ids, allow) => {
    const allowDelete = new Set(allow);
    const action = { type: "MESSAGE_DELETE_BULK", ids: ids.slice() };
    const block = action.ids.filter((x) => !allowDelete.has(x));
    let result = false;
    if (block.length === action.ids.length) result = true;
    else if (block.length > 0) {
      const blockSet = new Set(block);
      action.ids = action.ids.filter((x) => !blockSet.has(x));
    }
    return { result, ids: action.ids, block };
  };
  assert.deepStrictEqual(run(["a", "b"], []), { result: true, ids: ["a", "b"], block: ["a", "b"] });
  assert.deepStrictEqual(run(["a", "b"], ["a", "b"]), { result: false, ids: ["a", "b"], block: [] });
  assert.deepStrictEqual(run([], []), { result: true, ids: [], block: [] }); // empty: block.length===ids.length
});

test("retention cap matches renderer RETENTION_CAP=500", () => {
  assert.ok(SRC.includes("const RETENTION_CAP = 500"), "drift: RETENTION_CAP changed");
  const CAP = 500;
  const s = new Set();
  for (let i = 0; i < 600; i++) {
    s.add("id" + i);
    while (s.size > CAP) s.delete(s.values().next().value);
  }
  assert.strictEqual(s.size, CAP);
  assert.ok(!s.has("id0"));
  assert.ok(s.has("id599"));
});

test("prefetch channel href parse", () => {
  const lit = "\\/channels\\/[^/]+\\/(\\d+)";
  assert.ok(SRC.includes("\\/channels\\/[^/]+\\/(\\d+)"), "drift: prefetch href regex changed");
  const re = /\/channels\/[^/]+\/(\d+)/;
  assert.strictEqual("/channels/@me/123456789012345678".match(re)[1], "123456789012345678");
  assert.strictEqual("/channels/111/222".match(re)[1], "222");
  assert.strictEqual(re.test("/channels/111"), false);
  assert.ok(SRC.includes("PREFETCH_INTENT_MS = 150"), "drift: prefetch intent ms changed");
});

test("clearDeleted cleanup contract present in source", () => {
  // Drift guards: clearDeleted must strip row attrs, clear deletedActions, stop observer.
  assert.ok(SRC.includes("clearDeleted()"), "clearDeleted missing");
  assert.ok(SRC.includes('querySelectorAll(".dcmod-deleted-row")'), "must strip dcmod-deleted-row");
  assert.ok(SRC.includes("deletedActions.clear()"), "must clear deletedActions");
  assert.ok(SRC.includes("stopObserverIfIdle()"), "must stop observer when idle");
  assert.ok(SRC.includes('delete el.dataset.dcmodId') || SRC.includes('removeAttribute("data-dcmod-id")'), "must clear data-dcmod-id");
});

test("close button bridged via DCModNative", () => {
  assert.ok(SRC.includes('label === "close"'), "close aria-label must be handled");
  assert.ok(SRC.includes("api.close()"), "must call api.close()");
});
