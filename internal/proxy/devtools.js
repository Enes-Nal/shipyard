// Terminal's console capture for a Browser tab's page: what the page logs
// (console.log, info, warn, error, debug, assert, trace), uncaught errors,
// unhandled promise rejections and resources that failed to load, kept for
// the app's Console drawer. The page's console still gets every call.
//
// In the Terminal app the page is a native webview, which runs this at the
// start of every document (src-tauri/src/browser.rs) and asks it for what
// is new a few times a second: window.__berthDevtools.drain() returns a
// JSON string, or "" when there is nothing new. In an iframe (devtools.go)
// it acts only in a frame the app named berth-devtools:<pane>, and posts
// the same report to the app, its parent, with postMessage.
//
// A report: {v: 1, doc, t0, href, entries, dropped}. doc is this document's
// own id, so the app knows a new page started (a reload, a navigation) and
// starts afresh; t0 is when its navigation started (performance.timeOrigin),
// from which the Network drawer counts the page's requests. An entry:
// {level, text, stack?, source, at?, time, count}.
(function () {
  "use strict";
  var w = window;
  if (w.__berthDevtools) return;

  var KEY = "berth-devtools:";
  var FLAG = "__berth_devtools";
  var MAX = 300;
  var TEXT = 4000;
  var STACK = 4000;

  var framed = false;
  try {
    framed = w.parent !== w;
  } catch (e) {
    framed = true;
  }
  var pane = "";
  var parentOrigin = "";
  if (framed) {
    try {
      if (typeof w.name === "string" && w.name.indexOf(KEY) === 0) pane = w.name.slice(KEY.length);
    } catch (e) {}
    if (!pane) return;
    // The app: the release (tauri://localhost, or tauri.localhost on
    // Windows) or a development build on localhost.
    var APP = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/;
    try {
      var anc = location.ancestorOrigins;
      if (anc && anc.length) parentOrigin = anc[0];
    } catch (e) {}
    if (parentOrigin && !APP.test(parentOrigin)) return;
  }

  // The flag that asked for this script never reaches the page's own code.
  try {
    var here = new URL(location.href);
    if (here.searchParams.has(FLAG)) {
      here.searchParams.delete(FLAG);
      history.replaceState(history.state, "", here.pathname + here.search + here.hash);
    }
  } catch (e) {}

  var doc = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  var t0 = Date.now();
  try {
    if (performance && performance.timeOrigin) t0 = Math.round(performance.timeOrigin);
  } catch (e) {}

  var queue = [];
  var dropped = 0;
  var told = false;
  var busy = false;
  var timer = 0;

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function errorText(e) {
    try {
      var name = e.name || "Error";
      return e.message ? name + ": " + e.message : String(name);
    } catch (x) {
      return "Error";
    }
  }

  function isError(v) {
    try {
      return v instanceof Error || (v && typeof v === "object" && typeof v.message === "string" && typeof v.stack === "string");
    } catch (e) {
      return false;
    }
  }

  // show writes a value as the console would, briefly: objects and arrays
  // two levels deep, a few dozen keys, no cycles.
  function show(v, depth, seen, top) {
    var t = typeof v;
    if (v === null) return "null";
    if (t === "string") return top ? v : JSON.stringify(v.length > 200 ? v.slice(0, 200) + "…" : v);
    if (t === "number" || t === "boolean" || t === "undefined" || t === "bigint") return String(v) + (t === "bigint" ? "n" : "");
    if (t === "symbol") return v.toString();
    if (t === "function") return "ƒ " + (v.name || "anonymous") + "()";
    try {
      if (isError(v)) return errorText(v);
      if (typeof Element !== "undefined" && v instanceof Element) {
        var tag = "<" + v.tagName.toLowerCase();
        if (v.id) tag += "#" + v.id;
        if (typeof v.className === "string" && v.className.trim()) tag += "." + v.className.trim().split(/\s+/).slice(0, 3).join(".");
        return tag + ">";
      }
      if (seen.indexOf(v) >= 0) return "[Circular]";
      if (depth > 1) return Array.isArray(v) ? "Array(" + v.length + ")" : "{…}";
      seen.push(v);
      var out;
      if (Array.isArray(v)) {
        var items = [];
        for (var i = 0; i < v.length && i < 30; i++) items.push(show(v[i], depth + 1, seen, false));
        if (v.length > 30) items.push("… " + (v.length - 30) + " more");
        out = "[" + items.join(", ") + "]";
      } else {
        var keys = Object.keys(v);
        var parts = [];
        for (var k = 0; k < keys.length && k < 30; k++) parts.push(keys[k] + ": " + show(v[keys[k]], depth + 1, seen, false));
        if (keys.length > 30) parts.push("…");
        var ctor = v.constructor && v.constructor.name && v.constructor.name !== "Object" ? v.constructor.name + " " : "";
        out = ctor + "{" + parts.join(", ") + "}";
      }
      seen.pop();
      return out;
    } catch (e) {
      return "[object]";
    }
  }

  // format joins a console call's arguments, with the first one's %s, %d,
  // %i, %f, %o, %O and %c filled in as the console does.
  function format(args) {
    var rest = Array.prototype.slice.call(args);
    var head = "";
    if (typeof rest[0] === "string" && rest[0].indexOf("%") >= 0) {
      var f = rest.shift();
      head = f.replace(/%([sdifoOc%])/g, function (m, c) {
        if (c === "%") return "%";
        if (!rest.length) return m;
        var a = rest.shift();
        if (c === "c") return "";
        if (c === "d" || c === "i") return String(parseInt(a, 10));
        if (c === "f") return String(parseFloat(a));
        if (c === "s") return typeof a === "string" ? a : show(a, 0, [], true);
        return show(a, 0, [], false);
      });
    }
    var parts = head ? [head] : [];
    for (var i = 0; i < rest.length; i++) parts.push(show(rest[i], 0, [], true));
    return parts.join(" ");
  }

  // cleanStack drops the engine's "Error" header and this script's own
  // frames.
  function cleanStack(s) {
    if (!s) return "";
    var lines = String(s).split("\n");
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (!l.trim() || l.indexOf("__berthHook") >= 0 || l.indexOf("__berthTrace") >= 0) continue;
      if (i === 0 && /^\w*Error\b/.test(l) && l.indexOf("@") < 0 && !/^\s+at /.test(l)) continue;
      out.push(l.replace(/^\s+/, ""));
    }
    return clip(out.join("\n"), STACK);
  }

  function __berthTrace() {
    try {
      return cleanStack(new Error().stack);
    } catch (e) {
      return "";
    }
  }

  // add queues an entry; the same entry again, still waiting, counts up.
  function add(level, text, stack, source, at) {
    var e = { level: level, text: clip(text, TEXT), source: source, time: Date.now(), count: 1 };
    if (stack) e.stack = stack;
    if (at) e.at = clip(at, 500);
    var last = queue[queue.length - 1];
    if (last && last.level === e.level && last.text === e.text && last.stack === e.stack && last.source === e.source) {
      last.count++;
    } else {
      queue.push(e);
      if (queue.length > MAX) {
        queue.shift();
        dropped++;
      }
    }
    if (framed) schedule();
  }

  function report() {
    var r = { v: 1, doc: doc, t0: t0, href: String(location.href), entries: queue, dropped: dropped };
    queue = [];
    dropped = 0;
    told = true;
    return r;
  }

  function drain() {
    if (told && !queue.length && !dropped) return "";
    try {
      return JSON.stringify(report());
    } catch (e) {
      return "";
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = 0;
      if (told && !queue.length) return;
      var r = report();
      r.berth = "devtools";
      r.id = pane;
      try {
        w.parent.postMessage(r, parentOrigin || "*");
      } catch (e) {}
    }, 100);
  }

  var LEVELS = { log: "log", info: "info", warn: "warn", error: "error", debug: "debug", trace: "log", assert: "error" };
  var con = w.console;
  if (con) {
    Object.keys(LEVELS).forEach(function (method) {
      var real = con[method];
      if (typeof real !== "function") return;
      var level = LEVELS[method];
      var hook = function __berthHook() {
        var args = arguments;
        if (!busy) {
          busy = true;
          try {
            if (method === "assert") {
              if (!args[0]) add(level, "Assertion failed" + (args.length > 1 ? ": " + format(Array.prototype.slice.call(args, 1)) : ""), __berthTrace(), "console");
            } else {
              var stack = "";
              for (var i = 0; i < args.length; i++) {
                if (isError(args[i])) {
                  stack = cleanStack(args[i].stack);
                  break;
                }
              }
              if (!stack && (level === "error" || level === "warn" || method === "trace")) stack = __berthTrace();
              add(level, format(args), stack, "console");
            }
          } catch (e) {}
          busy = false;
        }
        return real.apply(this, args);
      };
      try {
        con[method] = hook;
      } catch (e) {}
    });
  }

  w.addEventListener(
    "error",
    function (ev) {
      if (busy) return;
      busy = true;
      try {
        var t = ev.target;
        if (t && t !== w && t.tagName) {
          // A resource that failed to load: an image, a script, a stylesheet.
          var src = t.currentSrc || t.src || t.href || "";
          add("error", "Failed to load " + t.tagName.toLowerCase() + (src ? " " + src : ""), "", "resource", src);
        } else {
          var err = ev.error;
          var text = err && isError(err) ? errorText(err) : ev.message || "Script error.";
          var at = ev.filename ? ev.filename + ":" + ev.lineno + ":" + ev.colno : "";
          add("error", "Uncaught " + text, err && err.stack ? cleanStack(err.stack) : "", "uncaught", at);
        }
      } catch (e) {}
      busy = false;
    },
    true,
  );

  w.addEventListener("unhandledrejection", function (ev) {
    if (busy) return;
    busy = true;
    try {
      var r = ev.reason;
      var text = isError(r) ? errorText(r) : show(r, 0, [], false);
      add("error", "Uncaught (in promise) " + text, r && r.stack ? cleanStack(r.stack) : "", "rejection");
    } catch (e) {}
    busy = false;
  });

  try {
    Object.defineProperty(w, "__berthDevtools", { value: Object.freeze({ drain: drain }), enumerable: false, configurable: false, writable: false });
  } catch (e) {}
  // A frame tells the app a new page started even before it logs anything.
  if (framed) schedule();
})();
