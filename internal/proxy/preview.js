// Terminal's Preview frame script. The laptop's proxy puts it at the top of a
// worktree page's <head> only for a Preview tab's frames (preview.go), never
// for normal browsing. It talks to the Terminal app, the frame's parent, with
// postMessage, and only with it: it mirrors navigation, scrolling, clicks and
// typing between frames, forces light or dark, and draws the frame for a
// screenshot. In any other frame (the page's own iframes, a Browser tab in a
// plain browser) it does nothing at all: the app names its frames, and only
// a frame so named answers.
(function () {
  "use strict";
  var w = window;

  var FLAG = "__berth_preview";
  var KEY = "berth-preview:";

  // The flag that asked for this script never reaches the page's own code:
  // routers see the address they expect.
  try {
    var here = new URL(location.href);
    if (here.searchParams.has(FLAG)) {
      here.searchParams.delete(FLAG);
      history.replaceState(history.state, "", here.pathname + here.search + here.hash);
    }
  } catch (e) {}

  var cfg = null;
  try {
    if (typeof w.name === "string" && w.name.indexOf(KEY) === 0) cfg = JSON.parse(w.name.slice(KEY.length));
  } catch (e) {}
  if (!cfg || typeof cfg.id !== "string" || w.parent === w) return;
  if (w.__berthPreview) return;
  w.__berthPreview = true;

  // The app: the release (tauri://localhost, or tauri.localhost on Windows)
  // or a development build on localhost.
  var APP = /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost|https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?)$/;
  var parentOrigin = "";
  try {
    var anc = location.ancestorOrigins;
    if (anc && anc.length) parentOrigin = anc[0];
  } catch (e) {}
  if (parentOrigin && !APP.test(parentOrigin)) return;

  function post(msg) {
    msg.berth = "preview";
    msg.id = cfg.id;
    try {
      w.parent.postMessage(msg, parentOrigin || "*");
    } catch (e) {}
  }
  function save() {
    try {
      w.name = KEY + JSON.stringify(cfg);
    } catch (e) {}
  }

  // The page's own fetches say they come from a Preview frame, so the proxy
  // lends them the cookies a frame is not sent (preview.go).
  var HDR = "X-Berth-Preview";
  function sameOrigin(u) {
    try {
      return new URL(String(u), location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  var realFetch = w.fetch;
  if (realFetch) {
    w.fetch = function (input, init) {
      try {
        var isReq = typeof Request !== "undefined" && input instanceof Request;
        if (sameOrigin(isReq ? input.url : input)) {
          var h = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
          h.set(HDR, "1");
          init = Object.assign({}, init, { headers: h });
        }
      } catch (e) {}
      return realFetch.call(this, input, init);
    };
  }
  if (w.XMLHttpRequest) {
    var xo = XMLHttpRequest.prototype.open;
    var xs = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__berthSame = sameOrigin(u);
      return xo.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (this.__berthSame) this.setRequestHeader(HDR, "1");
      } catch (e) {}
      return xs.apply(this, arguments);
    };
  }

  // ---- Light and dark ------------------------------------------------------

  var realMatch = w.matchMedia ? w.matchMedia.bind(w) : null;
  var PCS = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
  var TRUE = "(min-width: 0px)";
  var FALSE = "(max-width: 0.001px)";
  function forced() {
    return cfg.theme === "light" || cfg.theme === "dark" ? cfg.theme : "";
  }
  function rewrite(text) {
    var f = forced();
    if (!f) return text;
    return text.replace(PCS, function (_, s) {
      return s.toLowerCase() === f ? TRUE : FALSE;
    });
  }

  // Media rules keep what they said first, so a theme can be undone.
  var original = new WeakMap();
  function fixList(owner, list) {
    if (!list) return;
    var o = original.get(owner);
    if (o === undefined) {
      o = list.mediaText;
      if (!/prefers-color-scheme/i.test(o)) return;
      original.set(owner, o);
    }
    var next = rewrite(o);
    if (list.mediaText !== next) list.mediaText = next;
  }
  function eachRule(rules, fn, depth) {
    if (!rules || depth > 8) return;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      fn(r);
      if (r.styleSheet) eachRule(safeRules(r.styleSheet), fn, depth + 1);
      if (r.cssRules) eachRule(r.cssRules, fn, depth + 1);
    }
  }
  function safeRules(sheet) {
    try {
      return sheet.cssRules;
    } catch (e) {
      return null; // another origin's sheet
    }
  }
  function sheets() {
    var out = [];
    var list = document.styleSheets;
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    if (document.adoptedStyleSheets) out = out.concat(Array.prototype.slice.call(document.adoptedStyleSheets));
    return out;
  }
  function applyMedia() {
    sheets().forEach(function (s) {
      eachRule(
        safeRules(s),
        function (r) {
          if (r.media && (r.cssRules || r.styleSheet)) fixList(r, r.media);
        },
        0,
      );
    });
    var els = document.querySelectorAll("link[media],style[media],source[media]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var o = el.getAttribute("data-berth-media");
      if (o === null) {
        o = el.getAttribute("media") || "";
        if (!/prefers-color-scheme/i.test(o)) continue;
        el.setAttribute("data-berth-media", o);
      }
      var next = rewrite(o);
      if (el.getAttribute("media") !== next) el.setAttribute("media", next);
    }
  }

  // matchMedia answers for the forced theme, and tells listeners when it
  // changes, so a theme library that reads the system's choice follows.
  var fakes = [];
  if (realMatch) {
    w.matchMedia = function (q) {
      q = String(q);
      if (!/prefers-color-scheme/i.test(q)) return realMatch(q);
      return fakeList(q);
    };
  }
  function fakeList(q) {
    var real = realMatch(q);
    var target = document.createDocumentFragment();
    var mql = {
      get media() {
        return real.media;
      },
      get matches() {
        return forced() ? realMatch(rewrite(q)).matches : real.matches;
      },
      onchange: null,
      addEventListener: function (t, fn, o) {
        target.addEventListener(t, fn, o);
      },
      removeEventListener: function (t, fn, o) {
        target.removeEventListener(t, fn, o);
      },
      addListener: function (fn) {
        target.addEventListener("change", fn);
      },
      removeListener: function (fn) {
        target.removeEventListener("change", fn);
      },
      dispatchEvent: function (e) {
        return target.dispatchEvent(e);
      },
    };
    var last = mql.matches;
    mql._check = function () {
      var m = mql.matches;
      if (m === last) return;
      last = m;
      var ev;
      try {
        ev = new MediaQueryListEvent("change", { media: real.media, matches: m });
      } catch (e) {
        ev = new Event("change");
      }
      if (typeof mql.onchange === "function") mql.onchange.call(mql, ev);
      target.dispatchEvent(ev);
    };
    real.addEventListener ? real.addEventListener("change", mql._check) : real.addListener(mql._check);
    fakes.push(mql);
    return mql;
  }

  // What the page keys its theme on, read from its own styles: a .dark
  // class (Tailwind's class strategy, next-themes), a data-theme attribute,
  // or prefers-color-scheme media rules.
  function detect() {
    var cls = false;
    var attr = false;
    var media = false;
    var seen = 0;
    sheets().forEach(function (s) {
      eachRule(
        safeRules(s),
        function (r) {
          if (++seen > 40000) return;
          var sel = r.selectorText;
          if (sel) {
            if (/\.(dark|light)(?![\w\\-])/.test(sel)) cls = true;
            if (/\[data-theme/.test(sel)) attr = true;
          }
          if (r.media && /prefers-color-scheme/i.test(original.get(r) || r.media.mediaText)) media = true;
        },
        0,
      );
    });
    var html = document.documentElement;
    if (html.classList.contains("dark") || html.classList.contains("light")) cls = true;
    if (html.hasAttribute("data-theme")) attr = true;
    return cls ? "class" : attr ? "data-theme" : media ? "media" : "none";
  }
  var detected = "none";
  function strategy() {
    var s = cfg.strategy;
    if (s === "media" || s === "class" || s === "data-theme") return s;
    return detected === "none" ? "media" : detected;
  }

  // The page's own class, data-theme and color-scheme, as they were before
  // a theme was forced, to put back.
  var before = null;
  var guard = false;
  function applyAttrs() {
    var html = document.documentElement;
    var f = forced();
    var s = strategy();
    guard = true;
    if (f && !before) before = { cls: html.className, theme: html.getAttribute("data-theme"), scheme: html.style.colorScheme };
    if (!f && before) {
      if (html.className !== before.cls) html.className = before.cls;
      if (before.theme === null) html.removeAttribute("data-theme");
      else html.setAttribute("data-theme", before.theme);
      html.style.colorScheme = before.scheme;
      before = null;
    } else if (f) {
      html.style.colorScheme = f;
      if (s === "class") {
        var other = f === "dark" ? "light" : "dark";
        if (!html.classList.contains(f)) html.classList.add(f);
        if (html.classList.contains(other)) html.classList.remove(other);
      }
      if (s === "data-theme" && html.getAttribute("data-theme") !== f) html.setAttribute("data-theme", f);
    }
    guard = false;
  }
  function applyTheme() {
    applyMedia();
    applyAttrs();
    fakes.forEach(function (m) {
      m._check();
    });
  }

  // Styles come and go (a dev server's hot reload replaces them): theme them
  // as they arrive. A page that sets its own class back is set again.
  var pending = false;
  function soon() {
    if (pending) return;
    pending = true;
    (w.queueMicrotask || setTimeout)(function () {
      pending = false;
      if (forced()) applyMedia();
    });
  }
  new MutationObserver(function (list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === "attributes") {
        if (!guard && forced() && m.target === document.documentElement) applyAttrs();
        continue;
      }
      var t = m.target;
      if (t && (t.nodeName === "STYLE" || t.nodeName === "LINK")) soon();
      for (var j = 0; j < m.addedNodes.length; j++) {
        var n = m.addedNodes[j].nodeName;
        if (n === "STYLE" || n === "LINK" || n === "SOURCE") soon();
      }
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-theme", "style"] });
  document.addEventListener(
    "load",
    function (e) {
      if (e.target && e.target.nodeName === "LINK") soon();
    },
    true,
  );
  if (forced()) applyTheme();

  // ---- Where the page is ---------------------------------------------------

  // A path to an element that finds the same element in another frame: the
  // same page at another width has the same DOM, laid out differently. Ids
  // a framework made up per render (React's :r1:, Radix's) are skipped.
  function stableId(id) {
    return id && !/[:«»]|^radix-|^headlessui-|^\d/.test(id) && document.querySelectorAll("#" + cssEscape(id)).length === 1;
  }
  function cssEscape(s) {
    return w.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&");
  }
  function path(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el === document.documentElement) return "html";
    if (el === document.body) return "body";
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement && el !== document.body) {
      if (stableId(el.id)) {
        parts.unshift("#" + cssEscape(el.id));
        return parts.join(">");
      }
      var i = 1;
      var s = el;
      while ((s = s.previousElementSibling)) if (s.localName === el.localName) i++;
      parts.unshift(el.localName + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    parts.unshift("body");
    return parts.join(">");
  }
  function find(sel) {
    if (!sel) return null;
    try {
      return document.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  // Navigation: single-page routers change the address with pushState;
  // report each change, and the first address on load.
  var lastUrl = "";
  function report() {
    var u = location.href;
    if (u === lastUrl) return;
    lastUrl = u;
    post({ type: "nav", url: u, title: document.title });
  }
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(report, 0);
      return r;
    };
  });
  w.addEventListener("popstate", function () {
    setTimeout(report, 0);
  });
  w.addEventListener("hashchange", report);
  // A page with a router listens for popstate; one without is navigated in
  // full.
  var router = false;
  var add = w.addEventListener;
  w.addEventListener = function (t) {
    if (t === "popstate") router = true;
    return add.apply(this, arguments);
  };
  // full: the other frame loaded a new page, so this one does too, rather
  // than ask a router for an address it may not know.
  function go(url, full) {
    var u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return;
    }
    if (u.href === location.href) {
      if (full) location.reload();
      return;
    }
    if (u.origin !== location.origin || !router || full) {
      location.assign(u.href);
      return;
    }
    if (u.pathname === location.pathname && u.search === location.search && u.hash !== location.hash) {
      location.hash = u.hash;
      return;
    }
    history.pushState(null, "", u.pathname + u.search + u.hash);
    var ev;
    try {
      ev = new PopStateEvent("popstate", { state: null });
    } catch (e) {
      ev = new Event("popstate");
    }
    w.dispatchEvent(ev);
  }

  // Scrolling: the window, or the element that scrolls. Proportional by
  // default; anchored to the element at the top of the view when asked.
  var quietUntil = 0;
  var scrollFrame = 0;
  var scrolled = null;
  function scroller(t) {
    return !t || t === document || t === document.documentElement || t === document.body ? null : t;
  }
  function ratio(n, d) {
    return d > 0 ? Math.max(0, Math.min(1, n / d)) : 0;
  }
  w.addEventListener(
    "scroll",
    function (e) {
      if (Date.now() < quietUntil) return;
      scrolled = scroller(e.target);
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(function () {
        scrollFrame = 0;
        var el = scrolled;
        var se = document.scrollingElement || document.documentElement;
        var box = el || se;
        var msg = {
          type: "scroll",
          sel: el ? path(el) : "",
          x: ratio(box.scrollLeft, box.scrollWidth - box.clientWidth),
          y: ratio(box.scrollTop, box.scrollHeight - box.clientHeight),
        };
        if (!el) {
          var top = document.elementFromPoint(Math.round(w.innerWidth / 2), 2);
          if (top && top !== document.documentElement && top !== document.body) {
            var r = top.getBoundingClientRect();
            if (r.height > 0) {
              msg.anchor = path(top);
              msg.frac = (0 - r.top) / r.height;
            }
          }
        }
        post(msg);
      });
    },
    { capture: true, passive: true },
  );
  function scrollTo(m) {
    quietUntil = Date.now() + 250;
    var el = m.sel ? find(m.sel) : null;
    var se = document.scrollingElement || document.documentElement;
    var box = el || se;
    if (!el && m.mode === "anchor" && m.anchor) {
      var a = find(m.anchor);
      var r = a && a.getBoundingClientRect();
      if (r && r.height > 0) {
        se.scrollTop = se.scrollTop + r.top + (m.frac || 0) * r.height;
        return;
      }
    }
    box.scrollTop = (m.y || 0) * (box.scrollHeight - box.clientHeight);
    box.scrollLeft = (m.x || 0) * (box.scrollWidth - box.clientWidth);
  }

  // Clicks and typing, as the person made them (never the ones replayed
  // here, which are not trusted events).
  var lastClick = 0;
  document.addEventListener(
    "click",
    function (e) {
      if (!e.isTrusted) return;
      lastClick = Date.now();
      post({ type: "click", sel: path(e.target) });
    },
    true,
  );
  function onInput(e) {
    if (!e.isTrusted) return;
    var t = e.target;
    if (!t || !("value" in t || t.isContentEditable)) return;
    post({ type: "input", sel: path(t), value: t.isContentEditable ? t.textContent : t.value, checked: t.type === "checkbox" || t.type === "radio" ? t.checked : undefined, kind: e.type });
  }
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  document.addEventListener(
    "submit",
    function (e) {
      // A submit button's click is mirrored already.
      if (!e.isTrusted || Date.now() - lastClick < 150) return;
      post({ type: "submit", sel: path(e.target) });
    },
    true,
  );
  function setValue(el, m) {
    if (m.checked !== undefined) {
      if (el.checked !== m.checked) el.click();
      return;
    }
    if (el.isContentEditable) {
      el.textContent = m.value;
    } else {
      var proto = Object.getPrototypeOf(el);
      var desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, m.value);
      else el.value = m.value;
    }
    el.dispatchEvent(new Event(m.kind === "change" ? "change" : "input", { bubbles: true }));
  }

  // ---- A picture of the frame ----------------------------------------------

  function dataUrl(url) {
    return fetch(url, { credentials: "include" })
      .then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then(function (b) {
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () {
            res(String(fr.result));
          };
          fr.onerror = rej;
          fr.readAsDataURL(b);
        });
      });
  }
  var URL_RE = /url\((['"]?)([^'")]+)\1\)/g;
  function inlineUrls(css, base, cache) {
    var urls = [];
    css.replace(URL_RE, function (_, q, u) {
      if (!/^data:/.test(u)) urls.push(u);
      return _;
    });
    return Promise.all(
      urls.map(function (u) {
        var abs;
        try {
          abs = new URL(u, base).href;
        } catch (e) {
          return null;
        }
        if (!cache[abs]) cache[abs] = dataUrl(abs).catch(function () {
          return "";
        });
        return cache[abs].then(function (d) {
          return [u, d];
        });
      }),
    ).then(function (pairs) {
      pairs.forEach(function (p) {
        if (p && p[1]) css = css.split(p[0]).join(p[1]);
      });
      return css;
    });
  }
  function fontCss(cache) {
    var faces = [];
    sheets().forEach(function (s) {
      eachRule(
        safeRules(s),
        function (r) {
          if (r.type === 5 /* CSSRule.FONT_FACE_RULE */) faces.push(inlineUrls(r.cssText, s.href || location.href, cache));
        },
        0,
      );
    });
    return Promise.all(faces).then(function (all) {
      return all.join("\n");
    });
  }
  function styleText(cs) {
    var s = "";
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      s += p + ":" + cs.getPropertyValue(p) + ";";
    }
    return s;
  }
  function shot(req) {
    var W = w.innerWidth;
    var H = w.innerHeight;
    var sx = w.scrollX;
    var sy = w.scrollY;
    var cache = {};
    var waits = [];
    var pseudo = [];
    var n = 0;
    function copy(src) {
      if (src.nodeType === 3) return document.createTextNode(src.nodeValue);
      if (src.nodeType !== 1) return null;
      var tag = src.localName;
      if (tag === "script" || tag === "noscript" || tag === "template" || tag === "link" || tag === "meta") return null;
      var cs = getComputedStyle(src);
      if (cs.display === "none") return null;
      var el;
      if (tag === "iframe" || tag === "video" || tag === "object" || tag === "embed") {
        el = document.createElement("div");
      } else if (tag === "canvas") {
        el = document.createElement("img");
        try {
          el.setAttribute("src", src.toDataURL());
        } catch (e) {}
      } else {
        el = src.cloneNode(false);
      }
      el.removeAttribute("id");
      var style = styleText(cs);
      if (cs.position === "fixed") {
        var r = src.getBoundingClientRect();
        style += "position:absolute;top:" + (r.top + sy) + "px;left:" + (r.left + sx) + "px;right:auto;bottom:auto;";
      }
      if (cs.position === "sticky") {
        // Where it is stuck now, against where it would be.
        var stuck = src.getBoundingClientRect();
        var keep = src.style.position;
        src.style.position = "static";
        var free = src.getBoundingClientRect();
        src.style.position = keep;
        style += "position:relative;top:" + (stuck.top - free.top) + "px;left:" + (stuck.left - free.left) + "px;bottom:auto;right:auto;";
      }
      if (/url\(/.test(cs.backgroundImage)) {
        var bg = cs.backgroundImage;
        waits.push(
          inlineUrls(bg, location.href, cache).then(function (v) {
            el.style.backgroundImage = v;
          }),
        );
      }
      el.setAttribute("style", style);
      ["::before", "::after"].forEach(function (p) {
        var ps = getComputedStyle(src, p);
        if (!ps.content || ps.content === "none" || ps.content === "normal") return;
        var c = "berth-shot-" + n++;
        el.classList.add(c);
        pseudo.push("." + c + p + "{" + styleText(ps) + "content:" + ps.content + ";}");
      });
      if (tag === "img") {
        var url = src.currentSrc || src.src;
        el.removeAttribute("srcset");
        el.removeAttribute("loading");
        if (url && !/^data:/.test(url)) {
          waits.push(
            dataUrl(url)
              .then(function (d) {
                el.setAttribute("src", d);
              })
              .catch(function () {
                el.removeAttribute("src");
              }),
          );
        }
      }
      if (tag === "input") {
        if (src.type === "checkbox" || src.type === "radio") {
          if (src.checked) el.setAttribute("checked", "");
          else el.removeAttribute("checked");
        } else el.setAttribute("value", src.value);
      }
      if (tag === "textarea") el.textContent = src.value;
      if (tag === "select") {
        // drawn as a box with its chosen option
        var label = src.options[src.selectedIndex];
        el = document.createElement("div");
        el.setAttribute("style", style);
        el.textContent = label ? label.text : "";
        return el;
      }
      if (tag !== "iframe" && tag !== "canvas" && tag !== "textarea") {
        for (var c2 = src.firstChild; c2; c2 = c2.nextSibling) {
          var k = copy(c2);
          if (k) el.appendChild(k);
        }
      }
      return el;
    }
    var root = document.documentElement;
    var body = document.body ? copy(document.body) : null;
    var rootStyle = styleText(getComputedStyle(root));
    Promise.all(waits)
      .then(function () {
        return fontCss(cache);
      })
      .then(function (fonts) {
        var holder = document.createElement("div");
        holder.setAttribute("style", rootStyle + "position:absolute;left:" + -sx + "px;top:" + -sy + "px;margin:0;width:" + root.scrollWidth + "px;height:" + root.scrollHeight + "px;transform:translate(0,0);overflow:visible;");
        if (body) holder.appendChild(body);
        var xml = new XMLSerializer().serializeToString(holder);
        var css = (fonts + "\n" + pseudo.join("\n")).replace(/]]>/g, "");
        var svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><foreignObject x="0" y="0" width="100%" height="100%">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + W + "px;height:" + H + 'px;overflow:hidden;position:relative">' +
          "<style><![CDATA[" + css + "]]></style>" + xml + "</div></foreignObject></svg>";
        var img = new Image();
        return new Promise(function (res, rej) {
          img.onload = res;
          // A policy that keeps data: images out (img-src 'self'): the app
          // draws it instead.
          img.onerror = function () {
            post({ type: "shot", req: req, width: W, height: H, svg: svg });
            rej(null);
          };
          img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        }).then(function () {
          // Fonts and pictures in an SVG image settle a moment after it loads.
          return new Promise(function (res) {
            setTimeout(res, 60);
          });
        }).then(function () {
          var scale = Math.min(2, w.devicePixelRatio || 1);
          var canvas = document.createElement("canvas");
          canvas.width = Math.round(W * scale);
          canvas.height = Math.round(H * scale);
          var ctx = canvas.getContext("2d");
          ctx.scale(scale, scale);
          ctx.drawImage(img, 0, 0, W, H);
          var data;
          try {
            data = canvas.toDataURL("image/png");
          } catch (e) {
            post({ type: "shot", req: req, width: W, height: H, svg: svg });
            return;
          }
          post({ type: "shot", req: req, width: W, height: H, data: data });
        });
      })
      .catch(function (e) {
        if (e === null) return;
        post({ type: "shot", req: req, error: String((e && e.message) || e) });
      });
  }

  // ---- Talking to the app --------------------------------------------------

  w.addEventListener("message", function (e) {
    if (e.source !== w.parent || !APP.test(e.origin)) return;
    if (parentOrigin && e.origin !== parentOrigin) return;
    parentOrigin = e.origin;
    var m = e.data;
    if (!m || m.berth !== "preview") return;
    switch (m.type) {
      case "config":
        var themeChanged = m.theme !== undefined && (m.theme !== cfg.theme || m.strategy !== cfg.strategy);
        if (m.theme !== undefined) cfg.theme = m.theme;
        if (m.strategy !== undefined) cfg.strategy = m.strategy;
        save();
        if (themeChanged) applyTheme();
        break;
      case "navigate":
        go(m.url, !!m.full);
        break;
      case "scroll":
        scrollTo(m);
        break;
      case "click":
        var c = find(m.sel);
        if (c && typeof c.click === "function") c.click();
        break;
      case "input":
        var t = find(m.sel);
        if (t) setValue(t, m);
        break;
      case "submit":
        var f = find(m.sel);
        if (f && f.requestSubmit) f.requestSubmit();
        break;
      case "reload":
        location.reload();
        break;
      case "shot":
        shot(m.req);
        break;
    }
  });

  function hello() {
    detected = detect();
    if (forced()) applyTheme();
    lastUrl = location.href;
    post({
      type: "hello",
      url: location.href,
      title: document.title,
      detected: detected,
      dark: !!(realMatch && realMatch("(prefers-color-scheme: dark)").matches),
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", hello);
  else hello();
  // Styles a page loads late can change what it keys its theme on.
  w.addEventListener("load", function () {
    var d = detect();
    if (d !== detected) {
      detected = d;
      if (forced()) applyTheme();
      post({ type: "detected", detected: d });
    }
  });
})();
