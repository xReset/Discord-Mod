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
    // Red text only — no "(deleted)" label, no inline button. Right-click a red
    // message to remove it locally (see installContextMenu).
    style.textContent = `
      .dcmod-deleted,
      .dcmod-deleted * {
        color: #f04747 !important;
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

  function applyOne(id) {
    const content = document.getElementById("message-content-" + id);
    if (!content || content.classList.contains("dcmod-deleted")) return;
    content.classList.add("dcmod-deleted");
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
    deletedIds.delete(id);
    allowDelete.add(id);
    const el = document.getElementById("message-content-" + id);
    if (el) el.classList.remove("dcmod-deleted");
    const action = deletedActions.get(id);
    deletedActions.delete(id);
    stopObserverIfIdle();
    try {
      if (_dispatcher && action) _dispatcher.dispatch(action);
      else if (el) {
        // No stored action / dispatcher — just hide the row.
        const row = el.closest("li") || el.parentElement;
        if (row) row.style.display = "none";
      }
    } catch (e) {
      warn("removeLocal failed", String(e));
    }
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
          if (!e.shiftKey) return; // only shift+right-click is ours
          const node = e.target && e.target.closest ? e.target.closest('[id^="message-content-"]') : null;
          if (!node || !node.classList.contains("dcmod-deleted")) return;
          const id = node.id.slice("message-content-".length);
          e.preventDefault();
          e.stopPropagation();
          removeLocal(id);
        } catch (err) {}
      },
      true // capture: beat Discord's own handler
    );
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
