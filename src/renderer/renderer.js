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

  // ---------------------------------------------------------------------------
  // Perf harness — measures OUR self-imposed overhead so optimizations are
  // verifiable. longtask = main-thread task >50ms (Chromium). int* = our
  // interceptor; obs* = our mutation-observer apply pass.
  // ---------------------------------------------------------------------------
  const _perf = { intMs: 0, intN: 0, obsMs: 0, obsN: 0, ltN: 0, ltMs: 0, since: 0 };
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

  // Search wreq.m factory source strings — handles webpack 5 where most modules
  // are registered but not yet executed (so wreq.c only has ~100 of 2000+ modules).
  function findModuleBySource(wreq, ...keywords) {
    if (!wreq.m) return null;
    for (const id in wreq.m) {
      try {
        const src = wreq.m[id].toString();
        if (!keywords.every((kw) => src.includes(kw))) continue;
        // Execute the module so it lands in wreq.c and returns its exports.
        const mod = wreq(id);
        if (mod) return mod;
      } catch (e) {}
    }
    return null;
  }

  // Modern Discord nests the FluxDispatcher INSTANCE under an export property
  // (e.g. exports.Z / exports.ZP / exports.default), and minifies method names.
  // So we scan each module's exports AND its one-level-deep property values.
  function exportCandidates(mod) {
    const out = [];
    if (!mod) return out;
    out.push(mod);
    let keys = [];
    try {
      keys = Object.keys(mod);
    } catch (e) {
      return out;
    }
    for (const k of keys) {
      let v;
      try {
        v = mod[k]; // Discord getters can throw — isolate each one.
      } catch (e) {
        continue;
      }
      if (v && (typeof v === "object" || typeof v === "function")) out.push(v);
    }
    return out;
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
    if (!candidates.length) return null;
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
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Deleted-message viewer
  // ---------------------------------------------------------------------------
  const deletedIds = new Set();
  const deletedActions = new Map(); // id -> original MESSAGE_DELETE action (for replay)
  let enabled = true;
  let _dispatcher = null;

  // Locate the text node AND the message row for a message id. Gif/embed-only
  // messages may have no message-content text node, so we also find the row by id.
  function elsFor(id) {
    const content = document.getElementById("message-content-" + id);
    let row = content ? content.closest("li") : null;
    if (!row) {
      try {
        // Discord message rows carry the message id in their element id
        // (e.g. chat-messages-<channelId>-<id> / chat-messages___<id>).
        row = document.querySelector('li[id*="' + id + '"]');
      } catch (e) {}
    }
    return { content, row };
  }

  function applyOne(id) {
    const { content, row } = elsFor(id);
    if (content) content.classList.add("dcmod-deleted");
    if (row && !row.classList.contains("dcmod-deleted-row")) {
      row.classList.add("dcmod-deleted-row");
      try {
        row.dataset.dcmodId = id;
      } catch (e) {}
    }
  }

  function applyAll() {
    if (!enabled) return;
    deletedIds.forEach(applyOne);
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
    applyOne(id);
    requestAnimationFrame(() => applyOne(id));
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
    allowDelete.add(id);
    const { content, row } = elsFor(id);
    if (content) content.classList.remove("dcmod-deleted");
    if (row) {
      row.classList.remove("dcmod-deleted-row");
      delete row.dataset.dcmodId;
    }
    const action = deletedActions.get(id) || { type: "MESSAGE_DELETE", id: id, channelId: _channelOf(row) };
    deletedActions.delete(id);
    stopObserverIfIdle();
    log("removeLocal id=" + id + " hasAction=" + !!action + " hasDispatcher=" + !!_dispatcher + " chan=" + action.channelId);
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
          if (messageId != null) allowDelete.add(String(messageId));
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
      const _t0 = performance.now();
      let result = false;
      try {
        // Cheap gate first: only message-delete actions matter. Avoid all string
        // work (Object.keys etc.) for the ~thousands of other dispatches.
        const type = action && action.type;
        if (type === "MESSAGE_DELETE" || type === "MESSAGE_DELETE_BULK") {
          if (_msgActionLog < 80) {
            _msgActionLog++;
            log("action type=" + type + " keys=[" + Object.keys(action).slice(0, 12).join(",") + "]");
          }
          if (enabled) {
            if (type === "MESSAGE_DELETE" && !allowDelete.has(action.id)) {
              markDeleted(action.id, action);
              result = true; // block removal
            } else if (type === "MESSAGE_DELETE_BULK" && Array.isArray(action.ids)) {
              const block = action.ids.filter((x) => !allowDelete.has(x));
              block.forEach((x) => markDeleted(x, { type: "MESSAGE_DELETE", id: x, channelId: action.channelId, guildId: action.guildId }));
              if (block.length === action.ids.length) result = true; // block all
            }
          }
        }
      } catch (e) {
        warn("interceptor error", String(e));
      } finally {
        _perf.intMs += performance.now() - _t0;
        _perf.intN++;
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

  function scheduleApply() {
    if (_rafScheduled) return;
    _rafScheduled = true;
    requestAnimationFrame(() => {
      _rafScheduled = false;
      const t = performance.now();
      applyAll();
      _perf.obsMs += performance.now() - t;
      _perf.obsN++;
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
  // Text transforms (ported from the selfbot's visuals/owoify). Pure string→string.
  // Applied PRE-SEND by rewriting the message box, so the sent message is already
  // styled — zero flash, no edits, no (edited) tag. (See SELFBOT_AND_CLIENT.md.)
  // ===========================================================================
  const _map = (s, from, to) => {
    let out = "";
    for (const ch of s) {
      const i = from.indexOf(ch);
      out += i === -1 ? ch : to[i];
    }
    return out;
  };
  const _LOWER = "abcdefghijklmnopqrstuvwxyz";
  const _UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const _DIGITS = "0123456789";

  function _fromCodepoints(base) {
    // base = array of starting codepoints for [a..z]; build 26-char string.
    return Array.from({ length: 26 }, (_, i) => String.fromCodePoint(base + i)).join("");
  }

  const transforms = {
    vaporwave(t) {
      let out = "";
      for (const ch of t) {
        const c = ch.codePointAt(0);
        if (c >= 0x21 && c <= 0x7e) out += String.fromCodePoint(c + 0xfee0);
        else if (ch === " ") out += "　";
        else out += ch;
      }
      return out;
    },
    smallcaps(t) {
      const sc = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘQʀsᴛᴜᴠᴡxʏᴢ";
      return _map(t.toLowerCase(), _LOWER, sc);
    },
    doublestruck(t) {
      // 𝕒.. (U+1D552) lowercase, 𝔸.. (U+1D538) uppercase, 𝟘.. (U+1D7D8) digits
      const lo = _fromCodepoints(0x1d552);
      const up = _fromCodepoints(0x1d538);
      const dg = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x1d7d8 + i)).join("");
      return _map(_map(_map(t, _LOWER, lo), _UPPER, up), _DIGITS, dg);
    },
    script(t) {
      // 𝓪.. (U+1D4EA) bold script lowercase, 𝓐.. (U+1D4D0) uppercase
      const lo = _fromCodepoints(0x1d4ea);
      const up = _fromCodepoints(0x1d4d0);
      return _map(_map(t, _LOWER, lo), _UPPER, up);
    },
    bold(t) {
      const lo = _fromCodepoints(0x1d41a);
      const up = _fromCodepoints(0x1d400);
      const dg = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(0x1d7ce + i)).join("");
      return _map(_map(_map(t, _LOWER, lo), _UPPER, up), _DIGITS, dg);
    },
    bigtext(t) {
      let out = [];
      for (const ch of t.toLowerCase()) {
        if (ch >= "a" && ch <= "z") out.push(String.fromCodePoint(0x1f1e6 + (ch.charCodeAt(0) - 97)) + " ");
        else if (ch === " ") out.push("  ");
        else out.push(ch);
      }
      return out.join("");
    },
    spoilerify(t) {
      return Array.from(t).map((c) => (c === " " ? " " : "||" + c + "||")).join("");
    },
    zalgo(t) {
      const marks = [];
      for (let c = 0x0300; c <= 0x036f; c++) marks.push(String.fromCharCode(c));
      let out = "";
      for (const ch of t) {
        out += ch;
        if (ch !== " ") for (let i = 0; i < 5; i++) out += marks[Math.floor(Math.random() * marks.length)];
      }
      return out;
    },
    owoify(t) {
      const faces = [" (・`ω´・)", " owo", " UwU", " >w<", " ^w^", " :3"];
      let s = t
        .replace(/(?:r|l)/g, "w")
        .replace(/(?:R|L)/g, "W")
        .replace(/n([aeiou])/g, "ny$1")
        .replace(/N([aeiou])/g, "Ny$1")
        .replace(/ove/g, "uv");
      s = s.replace(/([.!?])\s*/g, (m, p) => p + faces[Math.floor(Math.random() * faces.length)] + " ");
      return s.trim();
    },
  };

  // ===========================================================================
  // Message box (Slate editor) pre-send rewrite
  // ===========================================================================
  function getMessageBox() {
    return document.querySelector('[data-slate-editor="true"]') || document.querySelector('div[role="textbox"]');
  }

  // Replace the current message-box text with transform(currentText). Uses
  // execCommand("insertText") so Slate processes it as real user input.
  function applyTransformToInput(fn) {
    const box = getMessageBox();
    if (!box) {
      log("transform: message box not found (focus a channel)");
      return false;
    }
    box.focus();
    const text = box.textContent || "";
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(box);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand("insertText", false, fn(text));
      return true;
    } catch (e) {
      warn("transform failed", String(e));
      return false;
    }
  }

  // ===========================================================================
  // Custom UI — minimal, modern, edgy. Black/white. Floating launcher + panel.
  // ===========================================================================
  function injectUIStyle() {
    if (document.getElementById("dcmod-ui-style")) return;
    const s = document.createElement("style");
    s.id = "dcmod-ui-style";
    s.textContent = `
      #dcmod-launcher {
        position: fixed; right: 18px; bottom: 18px; z-index: 99999;
        width: 38px; height: 38px; border-radius: 9px;
        background: #000; color: #fff; border: 1px solid #2a2a2a;
        font: 700 13px/38px ui-monospace,Menlo,Consolas,monospace; text-align: center;
        cursor: pointer; user-select: none; letter-spacing: .5px;
        box-shadow: 0 4px 18px rgba(0,0,0,.5); transition: transform .12s, border-color .12s;
      }
      #dcmod-launcher:hover { transform: translateY(-2px); border-color: #fff; }
      #dcmod-panel {
        position: fixed; right: 18px; bottom: 66px; z-index: 99999;
        width: 286px; max-height: 70vh; overflow-y: auto;
        background: #0a0a0a; color: #fff; border: 1px solid #2a2a2a; border-radius: 12px;
        padding: 14px; display: none; font-family: ui-monospace,Menlo,Consolas,monospace;
        box-shadow: 0 10px 40px rgba(0,0,0,.6);
      }
      #dcmod-panel.open { display: block; }
      .dcmod-h {
        font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
        color: #666; margin: 14px 0 8px; border-bottom: 1px solid #1c1c1c; padding-bottom: 5px;
      }
      .dcmod-h:first-child { margin-top: 0; }
      .dcmod-title { font-size: 13px; font-weight: 700; letter-spacing: 3px; margin-bottom: 2px; }
      .dcmod-sub { font-size: 9px; color: #555; letter-spacing: 1px; margin-bottom: 6px; }
      .dcmod-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      .dcmod-btn {
        background: transparent; color: #ddd; border: 1px solid #333; border-radius: 7px;
        padding: 7px 6px; font: 600 11px ui-monospace,Menlo,Consolas,monospace; cursor: pointer;
        transition: all .1s; text-align: center;
      }
      .dcmod-btn:hover { background: #fff; color: #000; border-color: #fff; }
      .dcmod-btn.wide { grid-column: 1 / -1; }
      .dcmod-btn.on { background: #fff; color: #000; }
      .dcmod-note { font-size: 9px; color: #444; margin-top: 10px; line-height: 1.4; }
    `;
    document.head.appendChild(s);
  }

  function installUI() {
    if (document.getElementById("dcmod-launcher")) return;
    injectUIStyle();

    const launcher = document.createElement("div");
    launcher.id = "dcmod-launcher";
    launcher.textContent = "DC";
    launcher.title = "DiscordMod";

    const panel = document.createElement("div");
    panel.id = "dcmod-panel";

    const mkBtn = (label, onClick, opts) => {
      const b = document.createElement("div");
      b.className = "dcmod-btn" + (opts && opts.wide ? " wide" : "");
      b.textContent = label;
      b.addEventListener("click", onClick);
      return b;
    };
    const mkHeader = (t) => {
      const h = document.createElement("div");
      h.className = "dcmod-h";
      h.textContent = t;
      return h;
    };
    const mkGrid = (btns) => {
      const g = document.createElement("div");
      g.className = "dcmod-grid";
      btns.forEach((b) => g.appendChild(b));
      return g;
    };

    // Title
    const title = document.createElement("div");
    title.className = "dcmod-title";
    title.textContent = "DISCORDMOD";
    panel.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "dcmod-sub";
    sub.textContent = "client mod · pre-send";
    panel.appendChild(sub);

    // Text transforms — rewrite the message box, then you hit Enter.
    panel.appendChild(mkHeader("text · transforms current input"));
    const tnames = [
      ["vaporwave", "vaporwave"],
      ["sᴍᴀʟʟᴄᴀᴘs", "smallcaps"],
      ["𝕕𝕤𝕥𝕣𝕦𝕔𝕜", "doublestruck"],
      ["𝓼𝓬𝓻𝓲𝓹𝓽", "script"],
      ["𝐛𝐨𝐥𝐝", "bold"],
      ["🇧🇮🇬", "bigtext"],
      ["s‖p‖oiler", "spoilerify"],
      ["z̸a̸l̸g̸o̸", "zalgo"],
      ["owoify", "owoify"],
    ];
    panel.appendChild(
      mkGrid(tnames.map(([label, key]) => mkBtn(label, () => applyTransformToInput(transforms[key]))))
    );

    // Deleted-message viewer
    panel.appendChild(mkHeader("deleted viewer"));
    const toggleBtn = mkBtn(enabled ? "viewer: ON" : "viewer: OFF", () => {
      const now = window.DCMod.toggleDeleted();
      toggleBtn.textContent = now ? "viewer: ON" : "viewer: OFF";
      toggleBtn.classList.toggle("on", now);
    });
    toggleBtn.classList.toggle("on", enabled);
    const clearBtn = mkBtn("clear all", () => window.DCMod.clearDeleted());
    panel.appendChild(mkGrid([toggleBtn, clearBtn]));

    const note = document.createElement("div");
    note.className = "dcmod-note";
    note.textContent = "transforms rewrite your draft — press Enter to send. shift+right-click a red (deleted) message to remove it.";
    panel.appendChild(note);

    launcher.addEventListener("click", () => panel.classList.toggle("open"));
    document.body.appendChild(launcher);
    document.body.appendChild(panel);
    log("UI installed");
  }

  // ---------------------------------------------------------------------------
  // Public toggle (use from DevTools console)
  // ---------------------------------------------------------------------------
  window.DCMod = {
    toggleDeleted() {
      enabled = !enabled;
      log("deleted-message viewer:", enabled ? "ON" : "OFF");
      return enabled;
    },
    clearDeleted() {
      document.querySelectorAll(".dcmod-deleted").forEach((el) => el.classList.remove("dcmod-deleted"));
      deletedIds.clear();
      log("cleared tracked deletions");
    },
    removeLocal: (id) => removeLocal(id),
    transforms,
    transform: (name) => applyTransformToInput(transforms[name]),
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
  const POLL_MS = 500;
  const MAX_ATTEMPTS = 600;

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
      return setTimeout(() => boot(attempt + 1), POLL_MS);
    }

    injectStyle();
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
      return setTimeout(() => boot(attempt + 1), POLL_MS);
    }

    installObserver();
    installContextMenu();
    hookOutgoingDeletes();
    installUI();
    restoreM(); // dispatcher captured — stop taxing every Function .m read
    log("ready ✓  (toggle with DCMod.toggleDeleted())");
    diag(); // auto-dump state so the log file is self-sufficient
    // Passive baseline: measure our idle overhead for 30s, dump once.
    perfReset();
    setTimeout(() => log("perf baseline " + JSON.stringify(perfSnapshot())), 30000);
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
