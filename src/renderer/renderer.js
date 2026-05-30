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
    style.textContent = `
      .dcmod-deleted,
      .dcmod-deleted * {
        color: #f04747 !important;
      }
      .dcmod-deleted::after {
        content: " (deleted)";
        color: #f04747;
        font-size: 0.7rem;
        font-weight: 600;
        opacity: 0.85;
      }
      .dcmod-deleted { position: relative; }
      .dcmod-x {
        cursor: pointer;
        margin-left: 6px;
        padding: 0 4px;
        font-size: 0.7rem;
        font-weight: 700;
        color: #fff;
        background: #f04747;
        border-radius: 3px;
        opacity: 0;
        transition: opacity .1s;
        user-select: none;
      }
      .dcmod-deleted:hover .dcmod-x { opacity: 1; }
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
    // Add a hover ✕ to actually remove this message from our local view.
    if (!content.querySelector(".dcmod-x")) {
      const x = document.createElement("span");
      x.className = "dcmod-x";
      x.textContent = "✕";
      x.title = "DCMod: remove this deleted message from view";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        removeLocal(id);
      });
      content.appendChild(x);
    }
  }

  function applyAll() {
    if (!enabled) return;
    deletedIds.forEach(applyOne);
  }

  function markDeleted(id, action) {
    if (!id) return;
    deletedIds.add(id);
    if (action) deletedActions.set(id, action);
    // Apply now and again after Discord finishes its own render pass.
    applyOne(id);
    requestAnimationFrame(() => applyOne(id));
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
      try {
        if (action && typeof action.type === "string" && action.type.indexOf("MESSAGE") !== -1 && _msgActionLog < 80) {
          _msgActionLog++;
          log("action type=" + action.type + " keys=[" + Object.keys(action).slice(0, 12).join(",") + "]");
        }
        if (enabled && action) {
          if (action.type === "MESSAGE_DELETE" && !allowDelete.has(action.id)) {
            markDeleted(action.id, action);
            return true; // block removal
          }
          if (action.type === "MESSAGE_DELETE_BULK" && Array.isArray(action.ids)) {
            const block = action.ids.filter((x) => !allowDelete.has(x));
            block.forEach((x) => markDeleted(x, { type: "MESSAGE_DELETE", id: x, channelId: action.channelId, guildId: action.guildId }));
            if (block.length === action.ids.length) return true; // block all
          }
        }
      } catch (e) {
        warn("interceptor error", String(e));
      }
      return false;
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
  function installObserver() {
    const obs = new MutationObserver(() => applyAll());
    obs.observe(document.body, { childList: true, subtree: true });
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
    log("ready ✓  (toggle with DCMod.toggleDeleted())");
    diag(); // auto-dump state so the log file is self-sufficient
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
