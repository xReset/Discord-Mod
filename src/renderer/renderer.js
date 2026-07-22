/* DiscordMod renderer bundle — runs in Discord's MAIN WORLD (page context).
 * Injected by preload as a <script> element so it can reach window.webpackChunkdiscord_app.
 * Edit this file freely; just fully restart Discord to reload (no repack needed).
 */
(function () {
  "use strict";

  if (window.__DCMOD_LOADED__) {
    console.log("[DCMod] already loaded, skipping");
    return;
  }
  window.__DCMOD_LOADED__ = true;

  const _fmt = (a) =>
    a.map((x) => {
      if (typeof x === "string") return x;
      try {
        return JSON.stringify(x);
      } catch (e) {
        return String(x);
      }
    });
  const log = (...a) => console.log("[DCMod]", ..._fmt(a));
  const warn = (...a) => console.warn("[DCMod]", ..._fmt(a));

  log("renderer injected ✓ — booting");

  // ---------------------------------------------------------------------------
  // Persisted settings — survive restarts via the page's localStorage. Toggles
  // (DCMod.noTrack/fastUI/toggleDeleted/debug) write here so a choice sticks
  // instead of resetting to the default every launch.
  // ---------------------------------------------------------------------------
  const _SETTINGS_KEY = "dcmod:settings";
  const _settings = (function () {
    const defaults = { noTrack: true, fastUI: true, enabled: true, prefetch: true, debug: false };
    try {
      const raw = localStorage.getItem(_SETTINGS_KEY);
      if (raw) return Object.assign(defaults, JSON.parse(raw));
    } catch (e) {}
    return defaults;
  })();
  function _saveSettings() {
    try {
      localStorage.setItem(_SETTINGS_KEY, JSON.stringify(_settings));
    } catch (e) {}
  }
  // DEBUG gates the chatty dev-only logs (per-delete dump, 5-min perf sampler,
  // per-eviction removeLocal line) so a normal multi-hour session stays quiet.
  let DEBUG = !!_settings.debug;

  // ---------------------------------------------------------------------------
  // Telemetry blocker — drop Discord's analytics/metrics/crash-reporting at the
  // network layer. Installed immediately (these globals exist before webpack
  // boots) so we catch early beacons too. Pairs with the TRACK interceptor block.
  // Narrow, anchored patterns — only known telemetry endpoints, no functional API.
  // ---------------------------------------------------------------------------
  const _TELEMETRY_RE =
    /\/api\/v\d+\/(science|metrics|track)\b|\/error-reporting|\bsentry\.io\b|\/observability(-relay)?\b|\/rtc\/quality/i;
  function _isTelemetryUrl(u) {
    try {
      return _noTrack && _TELEMETRY_RE.test(String(u));
    } catch (e) {
      return false;
    }
  }
  (function installTelemetryBlocker() {
    if (window.__DCMOD_NOTRACK__) return;
    window.__DCMOD_NOTRACK__ = true;
    try {
      const _fetch = window.fetch;
      if (_fetch) {
        window.fetch = function (input, init) {
          const url = (input && typeof input === "object" && input.url) || input;
          if (_isTelemetryUrl(url)) {
            _telBlocked++;
            return Promise.resolve(new Response("", { status: 204, statusText: "No Content" }));
          }
          return _fetch.apply(this, arguments);
        };
      }
    } catch (e) {}
    try {
      const _open = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        if (_isTelemetryUrl(url)) {
          this.__dcmodBlocked = true;
          _telBlocked++;
        }
        return _open.apply(this, arguments);
      };
      const _send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function () {
        if (this.__dcmodBlocked) return; // swallow — never hits the network
        return _send.apply(this, arguments);
      };
    } catch (e) {}
    try {
      if (navigator.sendBeacon) {
        const _beacon = navigator.sendBeacon.bind(navigator);
        navigator.sendBeacon = function (url) {
          if (_isTelemetryUrl(url)) {
            _telBlocked++;
            return true; // pretend it queued
          }
          return _beacon.apply(navigator, arguments);
        };
      }
    } catch (e) {}
    log("telemetry blocker installed (fetch/XHR/sendBeacon)");
  })();

  // ---------------------------------------------------------------------------
  // Capture the REAL webpack require(s).
  //
  // Discord's entrypoint PRE-POPULATES module factories on a require whose `.m`
  // is assigned once at boot. The chunk-push trick (below) returns a require whose
  // `.c` MISSES those entrypoint modules — so wreq.c stays tiny (~102) and the
  // FluxDispatcher (an entrypoint module) is never seen. Fix (moonlight/Vencord):
  // hook `Function.prototype.m`'s setter to grab every require as Rspack assigns
  // its module table. MUST run synchronously at inject time, before webpack boots.
  // ---------------------------------------------------------------------------
  let _msgActionLog = 0;
  let _loggedCandidates = false;
  let _hookMode = "";
  let _hooksActive = true; // A/B switch for benchmarking (DCMod.setActive)
  let _measuring = false; // when false, interceptor/observer skip perf timing (zero overhead)
  let _noTrack = _settings.noTrack; // block Discord analytics/telemetry (TRACK dispatches + network)
  let _telBlocked = 0; // count of telemetry requests/events we dropped

  // ---------------------------------------------------------------------------
  // Perf harness — measures OUR self-imposed overhead so optimizations are
  // verifiable. longtask = main-thread task >50ms (Chromium). int* = our
  // interceptor; obs* = our mutation-observer apply pass.
  // ---------------------------------------------------------------------------
  const _perf = { intMs: 0, intN: 0, obsMs: 0, obsN: 0, ltN: 0, ltMs: 0, since: 0 };
  let _perfInterval = 0; // handle for the long-session perf sampler
  const _PERF_INTERVAL_MS = 5 * 60 * 1000; // sample every 5min
  try {
    _perf.since = performance.now();
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        _perf.ltN++;
        _perf.ltMs += e.duration;
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch (e) {}

  function perfSnapshot() {
    const dt = Math.max(0.001, (performance.now() - _perf.since) / 1000);
    return {
      sec: +dt.toFixed(1),
      hooks: _hooksActive ? "ON" : "OFF",
      longtasks: _perf.ltN,
      longtaskMs: +_perf.ltMs.toFixed(0),
      ltPerMin: +((_perf.ltN / dt) * 60).toFixed(1),
      blockMsPerMin: +((_perf.ltMs / dt) * 60).toFixed(0),
      intN: _perf.intN,
      intMs: +_perf.intMs.toFixed(1),
      obsN: _perf.obsN,
      obsMs: +_perf.obsMs.toFixed(1),
    };
  }

  function perfReset() {
    _perf.intMs = _perf.intN = _perf.obsMs = _perf.obsN = _perf.ltN = _perf.ltMs = 0;
    _perf.since = performance.now();
  }

  // Locate the chat message scroller (the scrollable element that contains
  // message-content nodes). Used by the scripted scroll benchmark.
  function findScroller() {
    const msgs = document.querySelectorAll('[id^="message-content-"]');
    if (!msgs.length) {
      log("findScroller: 0 message-content nodes (not in a channel?)");
      return null;
    }
    // Walk up from a message node to the nearest actually-scrollable ancestor.
    let node = msgs[msgs.length - 1].parentElement;
    let best = null,
      bestH = 0;
    while (node && node !== document.body) {
      try {
        const oy = getComputedStyle(node).overflowY;
        const scrollable = oy === "auto" || oy === "scroll";
        if (scrollable && node.scrollHeight > node.clientHeight + 20 && node.scrollHeight > bestH) {
          bestH = node.scrollHeight;
          best = node;
        }
      } catch (e) {}
      node = node.parentElement;
    }
    if (!best) {
      // Fallback: largest scrollable div anywhere that contains a message node.
      for (const el of document.querySelectorAll("div")) {
        try {
          if (el.scrollHeight > el.clientHeight + 20 && el.querySelector('[id^="message-content-"]') && el.scrollHeight > bestH) {
            bestH = el.scrollHeight;
            best = el;
          }
        } catch (e) {}
      }
    }
    log("findScroller: msgNodes=" + msgs.length + " chosenScrollH=" + bestH);
    return best;
  }

  // Drive a deterministic triangle-wave scroll for `secs` so both A/B phases see
  // the IDENTICAL workload (manual scrolling is not reproducible).
  function scrollFor(scroller, secs, done) {
    const start = performance.now();
    const dur = secs * 1000;
    function step() {
      const t = performance.now() - start;
      const max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
      const phase = (t % 4000) / 4000;
      const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
      scroller.scrollTop = tri * max;
      if (t < dur) requestAnimationFrame(step);
      else done();
    }
    requestAnimationFrame(step);
  }
  const _wreqs = new Set();
  (function captureRequires() {
    try {
      const proto = Function.prototype;
      if (proto.__dcmodMHooked) return;
      Object.defineProperty(proto, "m", {
        configurable: true,
        enumerable: false,
        set(modules) {
          // Restore a normal own data property so webpack behaves unchanged.
          Object.defineProperty(this, "m", { value: modules, configurable: true, writable: true, enumerable: true });
          try {
            if (modules && typeof modules === "object") _wreqs.add(this);
          } catch (e) {}
        },
        get() {
          return undefined;
        },
      });
      proto.__dcmodMHooked = true;
      log("Function.prototype.m capture installed");
    } catch (e) {
      warn("m-capture failed", String(e));
    }
  })();

  // Remove our Function.prototype.m accessor once we no longer need to capture
  // new requires (we have the dispatcher). Requires that already set own `.m`
  // keep their data property; this just stops taxing every `.m` read globally.
  function restoreM() {
    try {
      delete Function.prototype.m;
    } catch (e) {}
  }

  // All candidate requires (captured entrypoint requires + the push-grabbed one).
  function allRequires() {
    const out = [];
    _wreqs.forEach((r) => {
      try {
        if (r && r.c) out.push(r);
      } catch (e) {}
    });
    if (_wreq && _wreq.c && !out.includes(_wreq)) out.push(_wreq);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Webpack access
  //
  // IMPORTANT: pushing a chunk into webpackChunkdiscord_app is only safe ONCE.
  // Spamming it (e.g. on a retry loop) during the login/remote-auth phase can
  // corrupt the session and log the user out. So we memoize the require and
  // push at most a single time, ever.
  // ---------------------------------------------------------------------------
  let _wreq = null;
  let _pushCount = 0;
  let _lastPushChunkLen = 0;
  const MAX_PUSHES = 12;

  function getWebpackRequire() {
    const key = "webpackChunkdiscord_app";
    const chunk = window[key];
    if (!Array.isArray(chunk) || typeof chunk.push !== "function") return null;
    // Only push once webpack has clearly booted (many chunks loaded). This keeps
    // us off the early login/auth phase, where pushing chunks can log the user out.
    if (chunk.length < 5) return null;

    const currentModules = _wreq && _wreq.c ? Object.keys(_wreq.c).length : 0;
    // Already have a fully-loaded require — reuse it.
    if (_wreq && currentModules >= 500) return _wreq;
    // Chunk array hasn't grown since last push — nothing new to grab.
    if (_wreq && chunk.length <= _lastPushChunkLen) return _wreq;
    if (_pushCount >= MAX_PUSHES) return _wreq || null;

    _pushCount++;
    _lastPushChunkLen = chunk.length;
    let req;
    try {
      chunk.push([[Symbol("dcmod")], {}, (r) => (req = r)]);
    } catch (e) {
      return _wreq || null;
    }
    if (req) {
      const newCount = req.c ? Object.keys(req.c).length : 0;
      if (newCount >= currentModules) _wreq = req;
    }
    return _wreq || null;
  }

  function findModule(wreq, predicate) {
    const cache = wreq.c || {};
    for (const id in cache) {
      let mod;
      try {
        mod = cache[id] && cache[id].exports;
      } catch (e) {
        continue;
      }
      if (!mod) continue;
      try {
        if (predicate(mod)) return mod;
      } catch (e) {}
      try {
        if (mod.default && predicate(mod.default)) return mod.default;
      } catch (e) {}
    }
    return null;
  }

  function findByProps(wreq, ...props) {
    return findModule(wreq, (m) => props.every((p) => m[p] !== undefined));
  }

  // Vencord-proven: the FluxDispatcher *instance* exposes runtime props `dispatch`
  // and `subscribe` (public flux API — these survive minification). Internals like
  // `_actionHandlers`/`_subscriptions`/`addInterceptor` also survive. We must scan
  // NATURALLY-executed exports — never force-execute factories (out-of-order requires
  // throw and corrupt the dispatcher's cache entry, which is what broke earlier).
  function isFlux(m) {
    try {
      return m && typeof m.dispatch === "function" && typeof m.subscribe === "function";
    } catch (e) {
      return false;
    }
  }

  // The REAL FluxDispatcher instance has internal underscore fields. A facade
  // ({dispatch,subscribe,addInterceptor} only) is NOT what Discord dispatches
  // through — wrapping its .dispatch does nothing. Score candidates accordingly.
  function fluxScore(o) {
    try {
      let s = 0;
      const keys = Object.keys(o);
      for (const k of keys) if (k[0] === "_") s += 2; // _actionHandlers, _subscriptions…
      if (typeof o.addInterceptor === "function") s += 1;
      if (typeof o.wait === "function") s += 1;
      if (typeof o.register === "function") s += 1;
      if (typeof o.isDispatching === "function") s += 2;
      return s;
    } catch (e) {
      return 0;
    }
  }

  function collectFlux(cache, into) {
    for (const id in cache) {
      let ex;
      try {
        ex = cache[id] && cache[id].exports;
      } catch (e) {
        continue;
      }
      if (!ex) continue;
      if (isFlux(ex)) into.push(ex);
      if (typeof ex !== "object") continue;
      for (const k in ex) {
        let v;
        try {
          v = ex[k];
        } catch (e) {
          continue;
        }
        if (isFlux(v) && !into.includes(v)) into.push(v);
      }
    }
  }

  // SAFE fallback locator. If the live-cache prop-scan finds nothing (e.g. a Discord
  // update moved the dispatcher and it isn't naturally executed yet), find the
  // FluxDispatcher module by a minify-stable SOURCE string and execute ONLY that one
  // module. This is NOT the banned mass force-execution (that ran ALL ~3100 factories
  // out of dependency order and corrupted modules) — it's a single targeted require of
  // the dispatcher's own factory, which is self-contained. Locators from AGENT_NOTES.
  const _DISPATCHER_SRC = ["Dispatch.dispatch(...) called without an action type", "_dispatchWithDevtools"];
  function findDispatcherBySource() {
    for (const r of allRequires()) {
      if (!r.m) continue;
      for (const id in r.m) {
        let src;
        try {
          src = r.m[id].toString();
        } catch (e) {
          continue;
        }
        if (!_DISPATCHER_SRC.some((s) => src.includes(s))) continue;
        try {
          const ex = r(id); // single targeted execution — safe (self-contained module)
          const cands = [];
          if (ex) {
            if (isFlux(ex)) cands.push(ex);
            if (typeof ex === "object") for (const k in ex) {
              try {
                if (isFlux(ex[k])) cands.push(ex[k]);
              } catch (e) {}
            }
          }
          if (cands.length) {
            cands.sort((a, b) => fluxScore(b) - fluxScore(a));
            log("dispatcher found via SOURCE fallback (prop-scan missed) — Discord internals may have shifted");
            return cands[0];
          }
        } catch (e) {}
      }
    }
    return null;
  }

  function findDispatcher(wreq) {
    const reqs = allRequires();
    if (wreq && wreq.c && !reqs.includes(wreq)) reqs.push(wreq);
    const candidates = [];
    let maxCache = 0;
    for (const r of reqs) {
      try {
        maxCache = Math.max(maxCache, Object.keys(r.c).length);
      } catch (e) {}
      collectFlux(r.c || {}, candidates);
    }
    if (!candidates.length) return findDispatcherBySource(); // prop-scan missed → safe source fallback
    // Pick the highest-scoring (real instance with internal fields).
    candidates.sort((a, b) => fluxScore(b) - fluxScore(a));
    if (!_loggedCandidates) {
      _loggedCandidates = true;
      log("flux candidates=" + candidates.length + " maxCache=" + maxCache);
      candidates.slice(0, 6).forEach((c, i) => {
        let keys = "";
        try {
          keys = Object.keys(c).slice(0, 18).join(",");
        } catch (e) {}
        log("  cand[" + i + "] score=" + fluxScore(c) + " keys=[" + keys + "]");
      });
    }
    return candidates[0];
  }

  // ---------------------------------------------------------------------------
  // Styling
  // ---------------------------------------------------------------------------
  function injectStyle() {
    if (document.getElementById("dcmod-style")) return;
    const style = document.createElement("style");
    style.id = "dcmod-style";
    // Red text + a red marker on the whole row (so embed/gif-only messages, which
    // have no text in message-content, are still visibly preserved + targetable).
    // Shift+right-click a red row to remove it locally (see installContextMenu).
    style.textContent = `
      .dcmod-deleted,
      .dcmod-deleted * {
        color: #f04747 !important;
      }
      .dcmod-deleted-row {
        box-shadow: inset 2px 0 0 #f04747 !important;
        background: rgba(240, 71, 71, 0.06) !important;
      }
      /* Ghost ping (deleted message that mentioned you) — orange, stronger marker. */
      .dcmod-ghostping-row {
        box-shadow: inset 3px 0 0 #faa61a !important;
        background: rgba(250, 166, 26, 0.10) !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Speed CSS — collapse Discord's UI *transitions* (state-change tweens: menu/
  // popout opens, channel switches, hovers, fade-ins) to near-instant. We touch
  // transitions ONLY, never keyframe `animation`, so spinners / loading / voice
  // indicators keep working. Net effect: clicks resolve with no artificial delay
  // AND fewer composited frames (less GPU). Toggle: DCMod.fastUI(bool).
  // ---------------------------------------------------------------------------
  let _fastUI = _settings.fastUI;
  function injectSpeedStyle() {
    let el = document.getElementById("dcmod-speed-style");
    if (!el) {
      el = document.createElement("style");
      el.id = "dcmod-speed-style";
      document.head.appendChild(el);
    }
    el.textContent = _fastUI
      ? `*, *::before, *::after {
           transition-duration: 0.001s !important;
           transition-delay: 0s !important;
         }
         /* The emoji/sticker/gif picker lazily renders its grid; Discord fades
            content in to mask the pop. The * rule above collapses that fade to
            ~0, so the grid visibly flickers on open. Restore a real opacity fade
            — but ONLY on the picker CONTAINER elements, NOT every descendant.
            Previously this covered every descendant, which put a
            0.15s opacity fade on the VIRTUALIZED grid rows too: as you scroll,
            rows mount/unmount continuously and each one faded in → ghosting /
            jank on fast scroll (favorited GIFs, stickers, emoji). Scoping to the
            container keeps the open-fade (the container is what fades in) while
            leaving scrolled-in rows instant. OPACITY ONLY — never transform/all,
            so virtualized row repositioning never animates (that jitters scroll). */
         [class*="expressionPicker"] {
           transition-property: opacity !important;
           transition-duration: 0.15s !important;
           transition-delay: 0s !important;
         }`
      : ``;
  }

  // ---------------------------------------------------------------------------
  // Deleted-message viewer
  // ---------------------------------------------------------------------------
  const deletedIds = new Set();
  const deletedActions = new Map(); // id -> original MESSAGE_DELETE action (for replay)
  let enabled = _settings.enabled;
  let _dispatcher = null;

  // Edit-snipe: pre-edit content captured on MESSAGE_UPDATE (id -> [{t,from,to}]).
  // Ghost-ping: ids of deleted messages that mentioned YOU (styled distinctly).
  const editHistory = new Map();
  const ghostPings = new Set();
  const EDIT_CAP = 300; // bound the edit-history map over long sessions

  // MessageStore + current-user id — resolved lazily (used by edit-snipe/ghost-ping).
  let _MessageStore = null;
  function _msgStore() {
    if (!_MessageStore || typeof _MessageStore.getMessage !== "function") {
      _MessageStore = findByPropsAll("getMessage", "getMessages");
    }
    return _MessageStore;
  }
  function _selfId() {
    try {
      const u = _stores().U;
      const cu = u && u.getCurrentUser && u.getCurrentUser();
      return cu && cu.id;
    } catch (e) {
      return null;
    }
  }
  function _msgFromStore(channelId, id) {
    try {
      const s = _msgStore();
      return s && s.getMessage ? s.getMessage(channelId, id) : null;
    } catch (e) {
      return null;
    }
  }

  // Capture pre-edit content BEFORE the MESSAGE_UPDATE applies (interceptor runs
  // before the store mutates). Store the old→new pair. Skips embed-only updates
  // (same content) so it only records real user edits.
  function captureEdit(action) {
    try {
      const m = action && action.message;
      if (!m || !m.id) return;
      const chan = m.channel_id || m.channelId;
      const oldMsg = _msgFromStore(chan, m.id);
      const oldContent = oldMsg && oldMsg.content;
      const newContent = m.content;
      if (oldContent == null || newContent == null || oldContent === newContent) return;
      const arr = editHistory.get(m.id) || [];
      arr.push({ t: Date.now(), from: oldContent, to: newContent, channelId: chan });
      editHistory.set(m.id, arr);
      while (editHistory.size > EDIT_CAP) editHistory.delete(editHistory.keys().next().value);
      if (DEBUG) log("editSnipe captured id=" + m.id + " revs=" + arr.length);
    } catch (e) {}
  }

  // Ghost ping = a message that @mentioned YOU, deleted before you (may have) read it.
  // Read the message from the store BEFORE the delete drops it; check self-mention.
  function _isGhostPing(id, channelId) {
    try {
      const msg = _msgFromStore(channelId, id);
      if (!msg) return false;
      const me = _selfId();
      if (!me) return false;
      if (Array.isArray(msg.mentions) && msg.mentions.some((u) => (u && u.id ? u.id : u) === me)) return true;
      if (msg.mentioned === true) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  // Locate the text node AND the message row for a message id. Gif/embed-only
  // messages may have no message-content text node, so we also find the row by id.
  const _rowCache = new Map(); // id -> last-resolved <li> (validated by isConnected)
  // full=true permits the costly full-DOM suffix scan (one-shot at mark/remove
  // time). The per-frame applyAll path passes full=false so it NEVER scans the
  // whole DOM — discovery of off-screen rows scrolling back in is handled by the
  // observer's addedNodes (see scheduleApply). This is what keeps long sessions
  // cheap: per-frame cost is O(tracked) indexed getElementById, not O(tracked)
  // full-DOM attribute scans.
  function elsFor(id, full) {
    const content = document.getElementById("message-content-" + id);
    let row = content ? content.closest("li") : null;
    if (!row) {
      const cached = _rowCache.get(id);
      if (cached && cached.isConnected) {
        row = cached;
      } else if (full) {
        try {
          // Discord message rows carry the message id in their element id
          // (e.g. chat-messages-<channelId>-<id> / chat-messages___<id>).
          // Row ids end with the message id; anchored suffix match.
          row = document.querySelector('li[id$="' + id + '"]');
        } catch (e) {}
      }
    }
    if (row) _rowCache.set(id, row);
    return { content, row };
  }

  function applyOne(id, full) {
    const { content, row } = elsFor(id, full);
    if (content) content.classList.add("dcmod-deleted");
    if (row && !row.classList.contains("dcmod-deleted-row")) {
      row.classList.add("dcmod-deleted-row");
      try {
        row.dataset.dcmodId = id;
      } catch (e) {}
    }
    // Ghost pings (deleted messages that @mentioned you) get a distinct orange marker.
    if (row && ghostPings.has(id) && !row.classList.contains("dcmod-ghostping-row")) {
      row.classList.add("dcmod-ghostping-row");
    }
  }

  function applyAll() {
    if (!enabled) return;
    // Cheap pass: full=false → no full-DOM scans. Off-screen rows resolve via
    // scheduleApply's addedNodes inspection when they scroll back in.
    deletedIds.forEach((id) => applyOne(id, false));
  }

  // Cap preserved deletions so memory/DOM stay bounded over long sessions across
  // many servers. Set is insertion-ordered, so the first entry is the oldest.
  const RETENTION_CAP = 500;

  function markDeleted(id, action) {
    if (!id) return;
    deletedIds.add(id);
    if (action) deletedActions.set(id, action);
    ensureObserver(); // start maintaining styling now that we have a deletion
    // Apply now and again after Discord finishes its own render pass.
    // full=true: one-shot scan resolves embed/gif-only rows present at delete time.
    applyOne(id, true);
    requestAnimationFrame(() => applyOne(id, true));
    // Evict oldest beyond the cap (actually removes it → frees store + DOM).
    while (deletedIds.size > RETENTION_CAP) {
      const oldest = deletedIds.values().next().value;
      if (oldest === undefined) break;
      removeLocal(oldest);
    }
  }

  // Truly remove a preserved message from our client: replay its real
  // MESSAGE_DELETE through the dispatcher (allowDelete lets it pass the wrap).
  function removeLocal(id) {
    id = String(id);
    deletedIds.delete(id);
    ghostPings.delete(id);
    _rowCache.delete(id);
    allowDelete.add(id);
    const { content, row } = elsFor(id, true);
    if (content) content.classList.remove("dcmod-deleted");
    if (row) {
      row.classList.remove("dcmod-deleted-row");
      delete row.dataset.dcmodId;
    }
    const action = deletedActions.get(id) || { type: "MESSAGE_DELETE", id: id, channelId: _channelOf(row) };
    deletedActions.delete(id);
    stopObserverIfIdle();
    if (DEBUG) log("removeLocal id=" + id + " hasAction=" + !!action + " hasDispatcher=" + !!_dispatcher + " chan=" + action.channelId);
    let removed = false;
    try {
      if (_dispatcher && action && action.channelId) {
        _dispatcher.dispatch(action); // allowDelete lets it pass → store drops it
        removed = true;
      }
    } catch (e) {
      warn("removeLocal dispatch failed", String(e));
    }
    // Fallback: if we couldn't dispatch a real delete, hide the row in the DOM.
    if (!removed && row) row.style.display = "none";
  }

  // Best-effort channel id from a message row's id (chat-messages-<chan>-<id>).
  function _channelOf(row) {
    try {
      const m = row && row.id && row.id.match(/(\d{17,20})/g);
      // Row id often contains [channelId, messageId]; the first long number is the channel.
      if (m && m.length >= 2) return m[0];
    } catch (e) {}
    return undefined;
  }

  function findByPropsAll(...props) {
    for (const r of allRequires()) {
      const m = findByProps(r, ...props);
      if (m) return m;
    }
    return null;
  }

  // Hook the action that deletes a message so that deletes WE initiate (our own
  // messages, or moderating others) actually go through and vanish, while deletes
  // by OTHERS (gateway-only, no local deleteMessage call) stay preserved red.
  function hookOutgoingDeletes() {
    let MA = null;
    try {
      const t = performance.now();
      MA = findByPropsAll("deleteMessage", "editMessage") || findByPropsAll("deleteMessage", "sendMessage") || findByPropsAll("deleteMessage");
      log("hookOutgoingDeletes scan done in " + (performance.now() - t).toFixed(0) + "ms found=" + !!MA);
    } catch (e) {
      warn("hookOutgoingDeletes scan threw", String(e));
    }
    if (MA && typeof MA.deleteMessage === "function") {
      if (MA.__dcmodDelHook) {
        log("deleteMessage already hooked");
        return true;
      }
      MA.__dcmodDelHook = true;
      const orig = MA.deleteMessage;
      MA.deleteMessage = function (channelId, messageId) {
        try {
          if (messageId != null) {
            allowDelete.add(String(messageId));
            // Bound the Set: ids are normally consumed when the matching MESSAGE_DELETE
            // dispatches, but a delete that fails/never dispatches would leak its id forever.
            // Evict oldest (insertion-ordered) so a failure path can't grow unbounded.
            while (allowDelete.size > ALLOW_DELETE_CAP) allowDelete.delete(allowDelete.values().next().value);
          }
        } catch (e) {}
        return orig.apply(this, arguments);
      };
      log("hooked deleteMessage — your deletes vanish, others' stay red");
      return true;
    }
    log("deleteMessage NOT found (minified?) — your deletes will still be preserved; use shift+right-click");
    return false;
  }

  // ids the user chose to actually remove locally (let the delete through).
  const allowDelete = new Set();
  const ALLOW_DELETE_CAP = 200; // bound the allow-list; normally consumed on dispatch (see hook)

  function installDispatcherHook(wreq) {
    const Dispatcher = findDispatcher(wreq);
    if (!Dispatcher || typeof Dispatcher.dispatch !== "function") {
      return false; // quiet — boot() retries
    }
    if (Dispatcher.__dcmodWrapped) {
      log("dispatcher already wrapped");
      return true;
    }
    Dispatcher.__dcmodWrapped = true;
    _dispatcher = Dispatcher;

    // The interceptor decides whether to block an action. Returning true blocks
    // it → the store never sees MESSAGE_DELETE → the message keeps rendering.
    // This runs on the REAL dispatch path even if `Dispatcher` is a facade.
    function interceptor(action) {
      if (!_hooksActive) return false; // benchmark A/B: near-zero cost when off
      // Cheap gate FIRST, before any timing: only message-delete actions matter.
      // The ~thousands of other dispatches now cost a single type compare + return
      // (no performance.now, no counter writes) — true vanilla parity off the delete path.
      const type = action && action.type;
      // Drop analytics events at the source — the science/track handlers never run,
      // so they never build or send the telemetry payload. One compare on the hot path.
      if (_noTrack && (type === "TRACK" || type === "ANALYTICS_TRACK_EVENT")) {
        _telBlocked++;
        return true;
      }
      // Edit-snipe: capture the pre-edit content, then let the update through (never block).
      if (type === "MESSAGE_UPDATE") {
        if (enabled) captureEdit(action);
        return false;
      }
      if (type !== "MESSAGE_DELETE" && type !== "MESSAGE_DELETE_BULK") return false;
      const _t0 = _measuring ? performance.now() : 0;
      let result = false;
      try {
        {
          if (DEBUG && _msgActionLog < 80) {
            _msgActionLog++;
            log("action type=" + type + " keys=[" + Object.keys(action).slice(0, 12).join(",") + "]");
          }
          if (enabled) {
            if (type === "MESSAGE_DELETE") {
              if (allowDelete.has(action.id)) {
                allowDelete.delete(action.id); // consume — id is single-use, bounds the Set
              } else {
                // Ghost-ping detection: did this deleted message @mention you?
                if (_isGhostPing(action.id, action.channelId)) {
                  ghostPings.add(action.id);
                  if (DEBUG) log("GHOST PING preserved id=" + action.id + " chan=" + action.channelId);
                }
                markDeleted(action.id, action);
                result = true; // block removal
              }
            } else if (type === "MESSAGE_DELETE_BULK" && Array.isArray(action.ids)) {
              const block = action.ids.filter((x) => !allowDelete.has(x));
              action.ids.forEach((x) => allowDelete.delete(x)); // consume any allowed ids
              block.forEach((x) => markDeleted(x, { type: "MESSAGE_DELETE", id: x, channelId: action.channelId, guildId: action.guildId }));
              if (block.length === action.ids.length) {
                result = true; // nothing allow-listed → block the whole bulk delete (all stay red)
              } else if (block.length > 0) {
                // MIXED: some ids are yours (allow-listed), some are others'. Passing the
                // original action through would delete the whole batch — wiping the ones we
                // just markDeleted. Trim the action IN PLACE to only the allow-listed ids so
                // Discord removes just those; the blocked (others') ids stay preserved red.
                const blockSet = new Set(block);
                action.ids = action.ids.filter((x) => !blockSet.has(x));
              }
              // block.length === 0 → all allow-listed → pass through unchanged (all vanish)
            }
          }
        }
      } catch (e) {
        warn("interceptor error", String(e));
      } finally {
        if (_measuring) {
          _perf.intMs += performance.now() - _t0;
          _perf.intN++;
        }
      }
      return result;
    }

    if (typeof Dispatcher.addInterceptor === "function") {
      Dispatcher.addInterceptor(interceptor);
      _hookMode = "addInterceptor";
    } else {
      // Fallback: wrap dispatch.
      const orig = Dispatcher.dispatch.bind(Dispatcher);
      Dispatcher.dispatch = function (action) {
        if (interceptor(action)) return;
        return orig(action);
      };
      _hookMode = "dispatch-wrap";
    }

    log("dispatcher hook installed (" + _hookMode + ") — deleted-message viewer active");
    return true;
  }

  // Re-apply red styling when Discord re-renders / virtualizes the message list.
  //
  // PERF: the naive "observe document.body subtree, run applyAll on every mutation"
  // is a constant main-thread tax — Discord mutates the DOM continuously. Instead:
  //   - only observe while there ARE deleted messages to maintain (disconnect when 0),
  //   - coalesce bursts to ONE applyAll per animation frame.
  // So with no deletions tracked (the common case) we cost nothing.
  let _obs = null;
  let _rafScheduled = false;

  // Trailing 17-20 digit message id from a row element id
  // (chat-messages-<chan>-<id> / chat-messages___<id>).
  function _idOfRow(li) {
    const m = li && li.id && li.id.match(/(\d{17,20})$/);
    return m ? m[1] : null;
  }

  // Style a freshly-inserted row if its id is a tracked deletion. Lets off-screen
  // embed/gif rows (no content node) restyle on scroll-in WITHOUT a per-frame
  // full-DOM scan — we only look at the nodes Discord actually added.
  function _tryRow(li) {
    const id = _idOfRow(li);
    if (id && deletedIds.has(id)) {
      _rowCache.set(id, li);
      applyOne(id, false);
    }
  }

  function scheduleApply(mutations) {
    // Insertion-driven discovery: inspect only the added nodes, not the whole DOM.
    if (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches("li[id]")) _tryRow(node);
          if (node.querySelectorAll) {
            const lis = node.querySelectorAll("li[id]");
            for (let k = 0; k < lis.length; k++) _tryRow(lis[k]);
          }
        }
      }
    }
    if (_rafScheduled) return;
    _rafScheduled = true;
    requestAnimationFrame(() => {
      _rafScheduled = false;
      if (_measuring) {
        const t = performance.now();
        applyAll();
        _perf.obsMs += performance.now() - t;
        _perf.obsN++;
      } else {
        applyAll();
      }
    });
  }

  function ensureObserver() {
    if (_obs || !_hooksActive || deletedIds.size === 0) return;
    _obs = new MutationObserver(scheduleApply);
    _obs.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserverIfIdle() {
    if (_obs && deletedIds.size === 0) {
      _obs.disconnect();
      _obs = null;
    }
  }

  function installObserver() {
    ensureObserver(); // no-op until first deletion
  }

  // SHIFT + right-click a preserved (red) deleted message → remove it from our
  // local view for good (replays the real delete via removeLocal). Plain
  // right-click (and any click on a non-preserved message) passes through to
  // Discord untouched.
  function installContextMenu() {
    if (window.__DCMOD_CTX_INSTALLED__) return; // survive hot-reload re-injects
    window.__DCMOD_CTX_INSTALLED__ = true;
    document.addEventListener(
      "contextmenu",
      (e) => {
        try {
          if (!e.shiftKey || !e.target || !e.target.closest) return; // only shift+right-click
          // Prefer the tagged row (works for gif/embed-only messages too).
          let id = null;
          const holder = e.target.closest("[data-dcmod-id]");
          if (holder) id = holder.dataset.dcmodId;
          if (!id) {
            const node = e.target.closest('[id^="message-content-"]');
            if (node && node.classList.contains("dcmod-deleted")) id = node.id.slice("message-content-".length);
          }
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          removeLocal(id);
        } catch (err) {}
      },
      true // capture: beat Discord's own handler
    );
  }

  // ===========================================================================
  // "Copy Avatar" context-menu item — injects a native-looking entry into the
  // user context menu that copies a high-res avatar PNG to the clipboard. When
  // the user has a server-specific avatar (and you're in that guild) you get BOTH
  // "Copy Server Avatar" and "Copy Avatar" so you can choose. We CLONE Discord's
  // own "Copy User ID" item so height/padding/styling match exactly.
  // ===========================================================================
  let _UserStore = null;
  let _GuildMemberStore = null;
  let _pendingUser = null; // {userId, guildId} captured on right-click

  // The real UserStore: has getUser+getCurrentUser+getUsers AND getCurrentUser()
  // returns a user object with an .id (rules out the locale store that also has
  // getCurrentUser/getUser but returns settings).
  function _findUserStore() {
    for (const r of allRequires()) {
      const m = findModule(
        r,
        (mod) =>
          typeof mod.getCurrentUser === "function" &&
          typeof mod.getUser === "function" &&
          (function () {
            try {
              const cu = mod.getCurrentUser();
              return cu && cu.id && typeof cu.username === "string";
            } catch (e) {
              return false;
            }
          })()
      );
      if (m) return m;
    }
    return null;
  }

  function _stores() {
    if (!_UserStore || !_UserStore.getUser || !_UserStore.getCurrentUser) {
      _UserStore = _findUserStore();
    }
    if (!_GuildMemberStore || !_GuildMemberStore.getMember) {
      _GuildMemberStore =
        findByPropsAll("getMember", "getMemberIds") ||
        findByPropsAll("getMember", "isMember") ||
        findByPropsAll("getMember", "getMembers");
    }
    return { U: _UserStore, G: _GuildMemberStore };
  }

  function _parseAvatarSrc(s) {
    let m = s.match(/\/guilds\/(\d+)\/users\/(\d+)\/avatars\//);
    if (m) return { guildId: m[1], userId: m[2] };
    m = s.match(/\/avatars\/(\d+)\//);
    if (m) return { userId: m[1] };
    return null;
  }

  // Pull a user id (+ guild id when present) out of whatever was right-clicked.
  // Climb ancestors from the exact click target outward and use the FIRST element
  // that encloses an avatar <img> — so it works no matter where in the row/header
  // you click (name, status, blank padding), not just on the avatar itself.
  function _userFromEvent(e) {
    let userId = null;
    let guildId = null;
    try {
      let node = e.target;
      for (let i = 0; i < 8 && node && node !== document.body; i++) {
        if (node.querySelector) {
          const img =
            node.querySelector('img[src*="/guilds/"][src*="/avatars/"]') ||
            node.querySelector('img[src*="/avatars/"]');
          if (img) {
            const p = _parseAvatarSrc(img.src);
            if (p && p.userId) {
              userId = p.userId;
              if (p.guildId) guildId = p.guildId;
              break;
            }
          }
        }
        node = node.parentElement;
      }
    } catch (err) {}
    if (!guildId) {
      const um = location.pathname.match(/\/channels\/(\d+)\//);
      if (um) guildId = um[1];
    }
    return { userId, guildId };
  }

  function _globalAvatarUrl(user) {
    if (!user.avatar) {
      let idx;
      if (user.discriminator && user.discriminator !== "0") idx = parseInt(user.discriminator, 10) % 5;
      else idx = Number((BigInt(user.id) >> 22n) % 6n);
      return "https://cdn.discordapp.com/embed/avatars/" + idx + ".png";
    }
    return "https://cdn.discordapp.com/avatars/" + user.id + "/" + user.avatar + ".png?size=4096";
  }
  function _guildAvatarUrl(guildId, userId, hash) {
    return "https://cdn.discordapp.com/guilds/" + guildId + "/users/" + userId + "/avatars/" + hash + ".png?size=4096";
  }

  async function _copyAvatar(url) {
    try {
      const res = await fetch(url);
      let blob = await res.blob();
      if (blob.type !== "image/png") {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        blob = await new Promise((r) => c.toBlob(r, "image/png"));
      }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      log("avatar copied → clipboard (" + url + ")");
    } catch (err) {
      warn("copy avatar failed", String(err));
    }
  }

  function _injectMenuStyle() {
    if (document.getElementById("dcmod-menu-style")) return;
    const s = document.createElement("style");
    s.id = "dcmod-menu-style";
    // Mirror Discord's own menuitem hover highlight (our cloned item is inert, so
    // Discord's JS-driven focus class never lands on it — give it CSS feedback).
    s.textContent = `.dcmod-menuitem:hover { background: var(--background-modifier-hover, rgba(255,255,255,.06)) !important; cursor: pointer; }`;
    document.head.appendChild(s);
  }

  // Find an open user context menu (one containing a "Copy User ID" item).
  function _findUserMenu() {
    const menus = document.querySelectorAll('[role="menu"]');
    for (const m of menus) {
      const items = m.querySelectorAll('[role="menuitem"]');
      for (const it of items) {
        const t = (it.textContent || "").trim();
        if (t === "Copy User ID" || t.indexOf("Copy User ID") === 0) return { menu: m, anchor: it };
      }
    }
    return null;
  }

  function _makeItem(anchor, label, onClick) {
    const it = anchor.cloneNode(true); // identical classes → identical size/styling
    it.id = "dcmod-" + label.replace(/\s+/g, "-").toLowerCase();
    it.classList.add("dcmod-menuitem");
    const lab = it.querySelector('[class*="label"]');
    if (lab) lab.textContent = label;
    else it.textContent = label;
    it.setAttribute("aria-label", label);
    const ic = it.querySelector('[class*="iconContainer"]'); // strip the [ID] badge
    if (ic) ic.remove();
    it.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
      try {
        if (_dispatcher) _dispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" });
      } catch (e) {}
    });
    return it;
  }

  function _tryInjectAvatarItem() {
    const found = _findUserMenu();
    if (!found) return false; // menu not open yet → keep polling
    if (found.menu.querySelector(".dcmod-menuitem")) return true; // already injected
    const info = _pendingUser || {};
    if (!info.userId) return true; // couldn't resolve a user → give up quietly
    const { U, G } = _stores();
    const user = U && U.getUser && U.getUser(info.userId);
    if (!user) return true;
    const member = info.guildId && G && G.getMember && G.getMember(info.guildId, info.userId);
    const hasServer = member && member.avatar;
    const items = [];
    if (hasServer) {
      items.push(_makeItem(found.anchor, "Copy Server Avatar", () => _copyAvatar(_guildAvatarUrl(info.guildId, info.userId, member.avatar))));
      items.push(_makeItem(found.anchor, "Copy Avatar", () => _copyAvatar(_globalAvatarUrl(user))));
    } else {
      items.push(_makeItem(found.anchor, "Copy Avatar", () => _copyAvatar(_globalAvatarUrl(user))));
    }
    let ref = found.anchor;
    for (const it of items) {
      ref.parentNode.insertBefore(it, ref.nextSibling);
      ref = it;
    }
    log("Copy Avatar injected (server=" + !!hasServer + ")");
    return true;
  }

  function installAvatarMenu() {
    if (window.__DCMOD_AVATAR__) return;
    window.__DCMOD_AVATAR__ = true;
    _injectMenuStyle();
    document.addEventListener(
      "contextmenu",
      (e) => {
        try {
          _pendingUser = _userFromEvent(e);
          if (_pendingUser && _pendingUser.userId) {
            // Menu renders a frame or two after the event — poll briefly, then stop.
            let tries = 0;
            const tick = () => {
              if (_tryInjectAvatarItem()) return;
              if (++tries < 30) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }
        } catch (err) {}
      },
      true // CAPTURE: Discord stopsPropagation on user rows, so bubble never reaches us
    );
    log("Copy Avatar menu handler installed");
  }

  // ---------------------------------------------------------------------------
  // Window controls (minimize / maximize-restore) bridge.
  //
  // This frozen Discord build (9240) has a DEAD renderer→main IPC for the custom
  // titlebar buttons: DiscordNative.window.minimize()/maximize() are no-ops, so
  // the min/maximize buttons appear but do nothing. The Electron window itself is
  // fully resizable/maximizable (verified main-process win.maximize() works). We
  // route clicks through our OWN bridge (preload exposes DCModNative → shim ipcMain
  // → win.minimize()/maximize()/unmaximize()/close()). Close must use the bridge too —
  // Discord's renderer close IPC is equally dead. Capture phase + no preventDefault so
  // Discord's own (inert) handler still runs harmlessly.
  // ---------------------------------------------------------------------------
  function installWindowControls() {
    if (window.__DCMOD_WINCTL__) return;
    const api = window.DCModNative;
    if (!api || typeof api.minimize !== "function") {
      log("window controls: DCModNative bridge missing — skipping");
      return;
    }
    window.__DCMOD_WINCTL__ = true;
    document.addEventListener(
      "click",
      (e) => {
        try {
          if (!e.target || !e.target.closest) return;
          const btn = e.target.closest('[class*="winButton"]');
          if (!btn) return;
          const r = btn.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return; // skip the collapsed (0x0) leading set
          const label = (btn.getAttribute("aria-label") || "").toLowerCase();
          if (label === "minimize") api.minimize();
          else if (label === "maximize" || label === "restore") api.toggleMaximize();
          else if (label === "close") api.close();
        } catch (err) {}
      },
      true // capture: beat Discord's (inert) handler
    );
    log("window controls bridged (min/maximize/close via DCModNative)");
  }

  // ---------------------------------------------------------------------------
  // Hover-prefetch — on sustained hover (~150ms intent) over a channel/DM in the
  // sidebar, warm its message cache via Discord's own fetch action so the click
  // opens it instantly. Bounded so it's a small eager fetch, not a storm:
  //   - 150ms hover intent (ignores mouse just passing through),
  //   - dedupe per channel for 30s,
  //   - skip the channel you're already viewing,
  //   - all guarded in try/catch (a wrong signature is a silent no-op, never a crash).
  // Toggle: DCMod.prefetch(bool). Uses a REAL API (not telemetry) — nothing blocked.
  // ---------------------------------------------------------------------------
  let _prefetch = _settings.prefetch !== false;
  let _MessageFetch = null;
  const _prefetched = new Map(); // channelId -> last prefetch time (dedupe)
  const PREFETCH_TTL = 30000;
  const PREFETCH_INTENT_MS = 150;

  function _fetchAction() {
    if (!_MessageFetch || typeof _MessageFetch.fetchMessages !== "function") {
      _MessageFetch = findByPropsAll("fetchMessages") || null;
    }
    return _MessageFetch;
  }

  function _prefetchChannel(channelId) {
    if (!_prefetch || !channelId) return;
    const now = Date.now();
    const last = _prefetched.get(channelId);
    if (last && now - last < PREFETCH_TTL) return; // recently prefetched → skip
    const cur = location.pathname.match(/\/channels\/[^/]+\/(\d+)/);
    if (cur && cur[1] === channelId) return; // already viewing this channel
    const MF = _fetchAction();
    if (!MF) return;
    _prefetched.set(channelId, now);
    if (_prefetched.size > 200) _prefetched.delete(_prefetched.keys().next().value); // bound
    try {
      MF.fetchMessages({ channelId: channelId, limit: 50 });
      if (DEBUG) log("prefetch channel=" + channelId);
    } catch (e) {
      if (DEBUG) warn("prefetch failed", String(e));
    }
  }

  function installHoverPrefetch() {
    if (window.__DCMOD_PREFETCH__) return;
    window.__DCMOD_PREFETCH__ = true;
    let timer = null;
    let pendingChan = null;
    function clearIntent() {
      clearTimeout(timer);
      timer = null;
      pendingChan = null;
    }
    document.addEventListener(
      "mouseover",
      (e) => {
        try {
          if (!_prefetch || !e.target || !e.target.closest) return;
          const link = e.target.closest('a[href*="/channels/"]');
          if (!link) return;
          const m = (link.getAttribute("href") || "").match(/\/channels\/[^/]+\/(\d+)/);
          if (!m) return;
          const chan = m[1];
          if (chan === pendingChan) return; // same target, intent timer already armed
          pendingChan = chan;
          clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            pendingChan = null;
            _prefetchChannel(chan);
          }, PREFETCH_INTENT_MS);
        } catch (err) {}
      },
      true
    );
    // Cancel intent if the pointer leaves the channel link before the timer fires.
    document.addEventListener(
      "mouseout",
      (e) => {
        try {
          if (!pendingChan || !e.target || !e.target.closest) return;
          const from = e.target.closest('a[href*="/channels/"]');
          if (!from) return;
          const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('a[href*="/channels/"]') : null;
          if (to === from) return; // still inside the same link (child→child)
          clearIntent();
        } catch (err) {}
      },
      true
    );
    log("hover-prefetch installed (fetchAction=" + (_fetchAction() ? "found" : "MISSING") + ")");
  }

  // ---------------------------------------------------------------------------
  // Public toggle (use from the console mirror in logs/discord-console.log — DevTools off)
  // ---------------------------------------------------------------------------
  window.DCMod = {
    toggleDeleted() {
      enabled = !enabled;
      _settings.enabled = enabled;
      _saveSettings();
      log("deleted-message viewer:", enabled ? "ON" : "OFF");
      return enabled;
    },
    // Telemetry blocking: on by default. Returns current count of dropped events.
    noTrack(on) {
      if (on !== undefined) _noTrack = !!on;
      _settings.noTrack = _noTrack;
      _saveSettings();
      log("telemetry blocking " + (_noTrack ? "ON" : "OFF") + " — blocked so far: " + _telBlocked);
      return { enabled: _noTrack, blocked: _telBlocked };
    },
    // Collapse UI transition latency. Default ON. DCMod.fastUI(false) restores vanilla feel.
    fastUI(on) {
      if (on !== undefined) _fastUI = !!on;
      _settings.fastUI = _fastUI;
      _saveSettings();
      injectSpeedStyle();
      log("fast UI (instant transitions) " + (_fastUI ? "ON" : "OFF"));
      return _fastUI;
    },
    // Hover-prefetch: warm a channel's messages on hover so it opens instantly.
    prefetch(on) {
      if (on !== undefined) _prefetch = !!on;
      _settings.prefetch = _prefetch;
      _saveSettings();
      log("hover-prefetch " + (_prefetch ? "ON" : "OFF"));
      return _prefetch;
    },
    // Toggle chatty dev logs (per-delete dump, 5-min perf sampler, eviction lines).
    // Persisted; takes full effect on next restart for the perf sampler.
    debug(on) {
      if (on !== undefined) DEBUG = !!on;
      _settings.debug = DEBUG;
      _saveSettings();
      log("debug logging " + (DEBUG ? "ON" : "OFF") + " (restart to (de)activate the 5-min perf sampler)");
      return DEBUG;
    },
    clearDeleted() {
      document.querySelectorAll(".dcmod-deleted").forEach((el) => el.classList.remove("dcmod-deleted"));
      document.querySelectorAll(".dcmod-deleted-row").forEach((el) => {
        el.classList.remove("dcmod-deleted-row");
        try {
          delete el.dataset.dcmodId;
        } catch (e) {
          el.removeAttribute("data-dcmod-id");
        }
      });
      document.querySelectorAll(".dcmod-ghostping-row").forEach((el) => el.classList.remove("dcmod-ghostping-row"));
      deletedIds.clear();
      deletedActions.clear();
      ghostPings.clear();
      _rowCache.clear();
      stopObserverIfIdle();
      log("cleared tracked deletions");
    },
    removeLocal: (id) => removeLocal(id),
    // Edit-snipe: return the captured pre-edit revisions for a message id ([] if none).
    editSnipe(id) {
      const revs = editHistory.get(String(id)) || [];
      log("editSnipe id=" + id + " revisions=" + revs.length);
      revs.forEach((r, i) => log("  [" + i + "] from=" + JSON.stringify(r.from) + " to=" + JSON.stringify(r.to)));
      return revs;
    },
    // Ghost-ping snipe: list ids of deleted messages that @mentioned you this session.
    ghostPings() {
      const ids = Array.from(ghostPings);
      log("ghostPings count=" + ids.length + " ids=[" + ids.join(",") + "]");
      return ids;
    },
    diag: () => diag(),
    perf() {
      const s = perfSnapshot();
      log("perf " + JSON.stringify(s));
      return s;
    },
    perfReset() {
      perfReset();
      log("perf reset");
    },
    // Enable/disable our hooks at runtime (interceptor early-outs, observer
    // disconnects) so you can A/B our overhead in the SAME session/activity.
    setActive(b) {
      _hooksActive = !!b;
      if (!_hooksActive) {
        if (_obs) {
          _obs.disconnect();
          _obs = null;
        }
      } else {
        ensureObserver();
      }
      log("hooks " + (_hooksActive ? "ON" : "OFF"));
      return _hooksActive;
    },
    // Automated A/B: measure `secs` with hooks ON, then `secs` with hooks OFF,
    // print both snapshots. Do the SAME activity (e.g. scroll a busy channel)
    // through both windows for a valid comparison.
    bench(secs) {
      secs = secs || 20;
      _measuring = true; // turn on perf timing for the benchmark window
      this.setActive(true);
      perfReset();
      log("bench: phase ON for " + secs + "s — keep scrolling/using normally");
      setTimeout(() => {
        const on = perfSnapshot();
        log("bench ON " + JSON.stringify(on));
        this.setActive(false);
        perfReset();
        log("bench: phase OFF for " + secs + "s — repeat the SAME activity");
        setTimeout(() => {
          const off = perfSnapshot();
          log("bench OFF " + JSON.stringify(off));
          log("bench DELTA ltPerMin on=" + on.ltPerMin + " off=" + off.ltPerMin + " | blockMsPerMin on=" + on.blockMsPerMin + " off=" + off.blockMsPerMin);
          this.setActive(true);
        }, secs * 1000);
      }, secs * 1000);
      return "running " + secs * 2 + "s — mirror your activity across both phases";
    },
    // Reproducible benchmark: scripted identical scroll for `secs` with hooks ON,
    // then `secs` with hooks OFF. Open a busy channel first. Results auto-logged.
    autoBench(secs) {
      secs = secs || 15;
      const scroller = findScroller();
      if (!scroller) {
        log("autoBench: no message scroller found — open a channel with messages first");
        return "no scroller";
      }
      _measuring = true; // turn on perf timing for the benchmark window
      const self = this;
      const origTop = scroller.scrollTop;
      log("autoBench: scroller scrollHeight=" + scroller.scrollHeight + " — phase ON " + secs + "s");
      self.setActive(true);
      perfReset();
      scrollFor(scroller, secs, () => {
        const on = perfSnapshot();
        log("autoBench ON " + JSON.stringify(on));
        self.setActive(false);
        perfReset();
        log("autoBench: phase OFF " + secs + "s");
        scrollFor(scroller, secs, () => {
          const off = perfSnapshot();
          log("autoBench OFF " + JSON.stringify(off));
          log("autoBench RESULT ltPerMin on=" + on.ltPerMin + " off=" + off.ltPerMin + " | blockMsPerMin on=" + on.blockMsPerMin + " off=" + off.blockMsPerMin + " | ourMs on=" + (on.intMs + on.obsMs).toFixed(1));
          self.setActive(true);
          scroller.scrollTop = origTop;
        });
      });
      return "autoBench running " + secs * 2 + "s (scripted scroll)";
    },
  };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  // Patient boot: webpack only becomes grabbable AFTER login (the app must be
  // fully loaded). We poll slowly for up to ~5 min and stay quiet until ready.
  const MAX_ATTEMPTS = 600;
  // Poll fast for the first ~3s (catch webpack the instant it boots), then widen
  // to 500ms so we don't keep a steady high-frequency timer for up to 5 minutes.
  function pollDelay(attempt) {
    return attempt < 20 ? 150 : 500;
  }

  function chunkLen() {
    const c = window.webpackChunkdiscord_app;
    return Array.isArray(c) ? c.length : -1;
  }

  function boot(attempt) {
    attempt = attempt || 0;
    if (attempt > MAX_ATTEMPTS) {
      warn("gave up waiting for app to load");
      diag();
      return;
    }

    // Prefer captured entrypoint requires; fall back to the push-grabbed one.
    const wreq = getWebpackRequire();
    const haveAny = allRequires().length > 0 || !!wreq;
    if (!haveAny) {
      if (attempt % 20 === 0) log("waiting for webpack…", { attempt, chunkLen: chunkLen(), captured: _wreqs.size, pushes: _pushCount });
      return setTimeout(() => boot(attempt + 1), pollDelay(attempt));
    }

    injectStyle();
    injectSpeedStyle();
    if (!installDispatcherHook(wreq)) {
      if (attempt % 20 === 0) {
        let maxC = 0;
        allRequires().forEach((r) => {
          try {
            maxC = Math.max(maxC, Object.keys(r.c).length);
          } catch (e) {}
        });
        log("searching for dispatcher…", { attempt, captured: _wreqs.size, maxCache: maxC });
      }
      return setTimeout(() => boot(attempt + 1), pollDelay(attempt));
    }

    installObserver();
    installContextMenu();
    installAvatarMenu();
    installWindowControls();
    installHoverPrefetch();
    const _delOk = hookOutgoingDeletes();
    restoreM(); // dispatcher captured — stop taxing every Function .m read
    log("ready ✓  (toggle with DCMod.toggleDeleted())");
    // Structured health line — ONE grep target after a Discord update. Any `=FAIL`
    // (or deleteHook=miss) is the first thing to check; the rest of the client works
    // but that subsystem's internals moved. Cheap, one line, huge triage win.
    log(
      "health dispatcher=" + (_dispatcher ? "ok" : "FAIL") +
      " interceptor=" + (_hookMode || "FAIL") +
      " deleteHook=" + (_delOk ? "ok" : "miss") +
      " telemetry=" + (window.__DCMOD_NOTRACK__ ? "ok" : "FAIL") +
      " ctxMenu=" + (window.__DCMOD_CTX_INSTALLED__ ? "ok" : "FAIL") +
      " avatarMenu=" + (window.__DCMOD_AVATAR__ ? "ok" : "FAIL") +
      " winctl=" + (window.__DCMOD_WINCTL__ ? "ok" : "skip") +
      " msgStore=" + (_msgStore() ? "ok" : "miss") +
      " prefetch=" + (window.__DCMOD_PREFETCH__ ? (_fetchAction() ? "ok" : "no-fetch-action") : "off") +
      " settings=" + JSON.stringify(_settings)
    );
    diag(); // auto-dump state so the log file is self-sufficient
    // Passive baseline: measure our idle overhead for 30s, dump once.
    perfReset();
    setTimeout(() => {
      log("perf baseline " + JSON.stringify(perfSnapshot()) + " noTrack=" + _noTrack + " telBlocked=" + _telBlocked);
      // Long-session sampling: per-interval delta every 5min so main-thread
      // drift is visible across a multi-hour session. Reset each tick.
      perfReset();
      // Long-session sampling is DEBUG-only: without it a normal multi-hour session
      // doesn't accrue a log line every 5 min. Flip DCMod.debug(true) to sample.
      if (DEBUG) {
        if (_perfInterval) clearInterval(_perfInterval);
        _perfInterval = setInterval(() => {
          log("perf interval " + JSON.stringify(perfSnapshot()) + " noTrack=" + _noTrack + " telBlocked=" + _telBlocked);
          perfReset();
        }, _PERF_INTERVAL_MS);
      }
    }, 30000);
  }

  // Manual diagnostic — run DCMod.diag() in the console.
  function diag() {
    const wreq = _wreq || getWebpackRequire();
    const moduleCount = wreq && wreq.c ? Object.keys(wreq.c).length : 0;

    // Find all webpack-related globals on window.
    const wpGlobals = [];
    try {
      for (const k of Object.keys(window)) {
        if (k.indexOf("webpack") !== -1 || k.indexOf("__webpack") !== -1) wpGlobals.push(k);
      }
    } catch (e) {}

    // Sample first 10 module IDs so we can see what type they are.
    const modIdSample = [];
    if (wreq && wreq.c) {
      let n = 0;
      for (const id in wreq.c) {
        if (n++ >= 10) break;
        modIdSample.push(id);
      }
    }

    log("diag url=" + window.location.href);
    log("diag chunkLen=" + chunkLen() + " pushes=" + _pushCount + " lastPushAt=" + _lastPushChunkLen);
    const mCount = wreq && wreq.m ? Object.keys(wreq.m).length : -1;
    log("diag moduleCount=" + moduleCount + " mCount=" + mCount);
    log("diag wpGlobals=" + wpGlobals.join(","));
    log("diag modIdSample=" + modIdSample.join(","));

    if (wreq) {
      const d = findDispatcher(wreq);
      log("diag dispatcherFound=" + !!d + " hasAddInterceptor=" + !!(d && typeof d.addInterceptor === "function"));
      if (d) log("diag dispatcherKeys=" + Object.keys(d).slice(0, 40).join(","));

      let cDispatch = 0, cInterceptor = 0, cSubscribe = 0;
      const cache = wreq.c || {};
      for (const id in cache) {
        let m;
        try { m = cache[id] && cache[id].exports; } catch (e) { continue; }
        for (const obj of [m, m && m.default]) {
          if (!obj) continue;
          try {
            if (typeof obj.dispatch === "function") cDispatch++;
            if (typeof obj.addInterceptor === "function") cInterceptor++;
            if (typeof obj.subscribe === "function") cSubscribe++;
          } catch (e) {}
        }
      }
      log("diag countDispatch=" + cDispatch + " countInterceptor=" + cInterceptor + " countSubscribe=" + cSubscribe);
    }

    return { chunkLen: chunkLen(), pushes: _pushCount, moduleCount, wpGlobals };
  }

  // One-shot early diagnostic so we always get dispatcher state quickly.
  setTimeout(() => {
    try {
      diag();
    } catch (e) {
      warn("early diag failed", String(e));
    }
  }, 6000);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(0));
  } else {
    boot(0);
  }
})();
