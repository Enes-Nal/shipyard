/* Terminal launch video: every frame is a pure function of t (seconds).

   window.seek(t) puts the page at time t; nothing moves by itself (no CSS
   animations or transitions), so headless Chrome can step it frame by frame.
   All timing comes from beats.json, the grid scripts/music.py measured from
   the track: scene changes on downbeats (bar lines), small motions on beats
   and eighths. at(bar, beat) is the time of a beat in the edit.

   ?f=16x9 | 1x1 | 9x16 picks the frame; ?t=12.5 opens at a time; ?hud=1
   shows the bar and beat. */

(async function main() {
  const Q = new URLSearchParams(location.search);
  const BEATS = await (await fetch("beats.json")).json();
  const DUR = BEATS.duration;
  const BT = BEATS.beat;
  const at = (bar, beat = 0) => Math.max(0, BEATS.downbeats[0] + bar * BEATS.bar) + beat * BT;

  // ---------------------------------------------------------------- format
  const FORMATS = {
    "16x9": { W: 1920, H: 1080, head: 84, sub: 38, headTop: 112, headW: 1560, box: { cx: 960, cy: 566, w: 1640, h: 470 }, logoCy: 470, strip: { w: 1680, bottom: 0 }, dashW: 1480, narrow: false },
    "1x1": { W: 1080, H: 1080, head: 64, sub: 32, headTop: 86, headW: 960, box: { cx: 540, cy: 560, w: 980, h: 470 }, logoCy: 440, strip: { w: 1080, bottom: 0 }, dashW: 1160, narrow: true },
    "9x16": { W: 1080, H: 1920, head: 82, sub: 38, headTop: 290, headW: 960, box: { cx: 540, cy: 960, w: 1024, h: 860 }, logoCy: 860, strip: { w: 1080, bottom: 170 }, dashW: 1160, narrow: true },
  };
  const F = FORMATS[Q.get("f") || "16x9"];
  const stage = document.getElementById("stage");
  for (const [k, v] of Object.entries({ "--W": F.W + "px", "--H": F.H + "px", "--head": F.head + "px", "--sub": F.sub + "px", "--head-top": F.headTop + "px", "--head-w": F.headW + "px" })) stage.style.setProperty(k, v);
  if (F.narrow) stage.classList.add("narrow");
  document.body.style.width = F.W + "px";
  document.body.style.height = F.H + "px";

  // ---------------------------------------------------------------- easing
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const E = {
    lin: (p) => p,
    out: (p) => 1 - Math.pow(1 - p, 3),
    outQuart: (p) => 1 - Math.pow(1 - p, 4),
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    in: (p) => p * p * p,
    inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    inOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    outBack: (p) => {
      const c1 = 1.5, c3 = c1 + 1;
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    },
  };
  const prog = (t, t0, d, ease = E.lin) => ease(clamp((t - t0) / d));

  // Enter at t0 (rise and fade), leave by t1 (fade and lift), as {o, y, s}.
  function env(t, t0, t1, o = {}) {
    const { din = 0.62, dout = 0.24, dy = 30, dyOut = -22, s0 = 1, ease = E.outExpo } = o;
    const a = prog(t, t0, din, ease);
    const b = t1 == null ? 0 : prog(t, t1 - dout, dout, E.in);
    return { o: a * (1 - b), y: (1 - a) * dy + b * dyOut, s: lerp(s0, 1, a) };
  }
  function put(el, v, extra = "") {
    el.style.opacity = v.o.toFixed(4);
    el.style.visibility = v.o < 0.002 ? "hidden" : "visible";
    el.style.transform = `${extra} translate(${(v.x || 0).toFixed(2)}px, ${v.y.toFixed(2)}px) scale(${(v.s ?? 1).toFixed(4)})`;
  }

  // ---------------------------------------------------------------- helpers
  const h = (html) => {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  };
  const layers = document.getElementById("layers");
  function scene(id) {
    const el = h(`<div class="scene" id="${id}"></div>`);
    layers.appendChild(el);
    return el;
  }
  // A content box: authored at w x h, scaled to fit the format's box.
  function box(parent, w, hh, cy = F.box.cy, max = 1) {
    const s = Math.min(F.box.w / w, F.box.h / hh, max);
    const el = h(`<div class="box" style="width:${w}px;height:${hh}px"></div>`);
    el.dataset.base = `translate(-50%, -50%) translate(${F.box.cx - F.W / 2}px, ${cy - F.H / 2}px) scale(${s})`;
    el.style.left = "50%";
    el.style.top = "50%";
    el.style.transform = el.dataset.base;
    parent.appendChild(el);
    return el;
  }
  // Headline: lines of words; each word rises in, a little after the last.
  function headline(parent, lines, top = F.headTop) {
    const el = h(`<div class="head" style="top:${top}px"></div>`);
    const lineEls = lines.map((ln) => {
      const l = h(`<span class="ln"></span>`);
      // Words split on spaces outside tags, so a word can carry markup.
      const safe = ln.replace(/<[^>]*>/g, (m) => m.replace(/ /g, "\u0000"));
      safe.split(/ +/).forEach((w, i) => {
        if (i) l.appendChild(document.createTextNode(" "));
        if (w) l.appendChild(h(`<span class="w">${w.replace(/\u0000/g, " ")}</span>`));
      });
      el.appendChild(l);
      return l;
    });
    parent.appendChild(el);
    return { el, lines: lineEls };
  }
  function playHead(hd, t, ins, out) {
    hd.lines.forEach((l, i) => {
      [...l.querySelectorAll(".w")].forEach((w, j) => {
        const v = env(t, ins[i] + j * 0.05, out, { din: 0.7, dy: F.head * 0.42 });
        put(w, v);
      });
    });
  }
  function sub(parent, text, topPx) {
    const el = h(`<div class="sub" style="top:${topPx}px">${text}</div>`);
    parent.appendChild(el);
    return el;
  }
  // Two-line headlines measure their height once fonts are in; a subline
  // sits under its headline.
  const headBottom = (hd) => F.headTop + hd.el.getBoundingClientRect().height;

  // A path that draws itself: pathLength 1, dash offset from 1 to 0.
  const drawn = (el, p) => {
    el.style.strokeDasharray = "1 1";
    el.style.strokeDashoffset = (1 - clamp(p)).toFixed(4);
  };

  // The B of the mark comes up into its tile, like a hull out of the water.
  const riseB = (el, p) => {
    el.style.transformBox = "fill-box";
    el.style.transformOrigin = "50% 100%";
    el.style.opacity = clamp(p * 1.6).toFixed(4);
    el.style.transform = `translateY(${(70 * (1 - p)).toFixed(2)}px) scale(${lerp(0.92, 1, p).toFixed(4)})`;
  };

  // ---------------------------------------------------------------- the mark
  const MARK = (size, id) => `
  <svg width="${size}" height="${size}" viewBox="100 100 824 824" aria-hidden="true">
    <defs>
      <linearGradient id="${id}bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#25282d"/><stop offset="1" stop-color="#121417"/></linearGradient>
      <linearGradient id="${id}hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".09"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
    </defs>
    <g class="tile">
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#${id}bg)"/>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#${id}hl)"/>
      <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>
    </g>
    <path class="b" pathLength="1" d="M332 268 H556 a118 118 0 0 1 0 236 H332 Z M332 504 H584 a128 128 0 0 1 0 256 H332 Z" fill="none" stroke="#ecebe7" stroke-width="84" stroke-linejoin="round" stroke-linecap="round"/>
    <g class="dot"><circle cx="548" cy="386" r="34" fill="#e8a33d"/></g>
  </svg>`;

  // ---------------------------------------------------------------- harbour
  // The landing page's hero harbour (site/index.html), as a strip along the
  // bottom of the frame, in the same line weights. Built once; seek() moves
  // its boats, water, sun and gulls.
  const wave = (y, amp, n = 90) => {
    let d = `M-72 ${y} q6 ${-amp} 12 0`;
    for (let i = 0; i < n; i++) d += " t12 0";
    return d;
  };
  const BOATS = [
    { x0: 214, x1: 612, d: 6, lines: ["M192 164.5 Q 205 172 218 176", "M296 176 Q 312 170 325 161"], label: "claude", ph: 0.3 },
    { x0: 348, x1: 704, d: 6, lines: ["M327 161 Q 340 170 352 176", "M430 176 Q 446 170 459 161"], label: "codex", ph: 2.1 },
    { x0: 482, x1: 796, d: 6, lines: ["M461 161 Q 474 170 486 176", "M564 176 Q 580 170 593 161"], label: "cursor", ph: 4.0 },
  ];
  const harbourSVG = `
  <svg viewBox="0 76 960 152" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <defs>
      <clipPath id="sky"><rect x="-100" y="0" width="1200" height="168"/></clipPath>
      <clipPath id="wavesclip"><rect id="wavesrect" x="480" y="160" width="0" height="80"/></clipPath>
      <linearGradient id="fadeg" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.07" stop-color="#fff"/><stop offset="0.93" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <mask id="fade" maskUnits="userSpaceOnUse" x="0" y="60" width="960" height="200"><rect x="0" y="60" width="960" height="200" fill="url(#fadeg)"/></mask>
    </defs>
    <g mask="url(#fade)">
      <g clip-path="url(#sky)"><circle id="sun" cx="858" cy="100" r="14" stroke="currentColor" stroke-width="1.8"/></g>
      <g id="gulls" stroke="currentColor" stroke-width="1.6" opacity="0.6">
        <path id="gull1" d="M512 104 q4.2 -4.4 8.4 0 q4.2 -4.4 8.4 0"/>
        <path id="gull2" d="M540 116 q3.2 -3.4 6.4 0 q3.2 -3.4 6.4 0" opacity="0.7"/>
      </g>
      <g id="haze" stroke="currentColor" stroke-width="1.6">
        <path id="fog1" d="M330 118 H940" stroke-dasharray="26 16" opacity="0.2"/>
        <path id="fog2" d="M420 130 H920" stroke-dasharray="14 18" opacity="0.14"/>
      </g>
      <path id="headland" d="M770 178 C 798 164, 834 159, 864 164 S 920 172, 980 177" stroke="currentColor" stroke-width="1.8" opacity="0.28"/>

      <g id="quay" stroke="currentColor">
        <path pathLength="1" d="M20 168 H204" stroke-width="3.4"/>
        <path pathLength="1" d="M34 171 V182 M80 171 V182 M126 171 V182 M172 171 V182" stroke-width="3"/>
        <path pathLength="1" d="M34 189 V204 M80 189 V204 M126 189 V204 M172 189 V204 M326 189 V203 M460 189 V203 M594 189 V203" stroke-width="3" opacity="0.24"/>
        <path pathLength="1" d="M186 163.4 H198 M192 164 V167" stroke-width="2.6"/>
        <path pathLength="1" d="M326 156 V182 M460 156 V182 M594 156 V182" stroke-width="3.4"/>
        <path pathLength="1" d="M321 156 H331 M455 156 H465 M589 156 H599" stroke-width="2.4"/>
      </g>

      <!-- The box: the harbour master's shed, built when berthd starts. -->
      <g id="shed" stroke="currentColor">
        <rect id="shedwin" x="85" y="142" width="9" height="8" fill="#e3e4e8" stroke="none" opacity="0"/>
        <path pathLength="1" d="M45 166 V134 H101 V166" stroke-width="2.6"/>
        <path pathLength="1" d="M38 137 L73 115 L108 137" stroke-width="2.6"/>
        <path pathLength="1" d="M64 166 V150 H78 V166" stroke-width="2"/>
        <path pathLength="1" d="M85 142 H94 V150 H85 Z" stroke-width="1.8"/>
        <circle id="shedring" cx="73" cy="140" r="20" stroke-width="1.4" opacity="0"/>
      </g>
      <g id="shedlabel" opacity="0">
        <rect x="47" y="90" width="52" height="16" rx="8" fill="#212226" stroke="#3a3b42" stroke-width="1.1"/>
        <circle cx="57" cy="98" r="2.6" fill="#8a8c95" stroke="none"/>
        <text x="77" y="102" text-anchor="middle" font-size="10.5">devl</text>
      </g>

      ${BOATS.map((b, i) => `
      <g id="lines${i}" stroke="currentColor" stroke-width="1.5">${b.lines.map((d) => `<path d="${d}"/>`).join("")}</g>
      <g id="wake${i}" stroke="currentColor" opacity="0">
        <path d="M-58 10 H-4" stroke-width="1.5" stroke-dasharray="7 6" opacity="0.6"/>
        <path d="M-44 17 H-2" stroke-width="1.3" stroke-dasharray="5 8" opacity="0.35"/>
      </g>
      <g id="boat${i}" stroke="currentColor">
        <path class="hull" d="M0 0 H88 L78 14 H12 Z" stroke-width="2.6"/>
        <path class="hull" d="M23 0 V-10 H46 L53 0" stroke-width="2.1"/>
        <path d="M36 -10 V-34" stroke-width="1.9"/>
        <circle class="lampoff" cx="36" cy="-37.5" r="3.6" stroke-width="1.7"/>
        <circle class="lampon" cx="36" cy="-37.5" r="5.2" fill="#e8a33d" stroke="none" opacity="0"/>
      </g>
      <path id="glint${i}" d="M0 0 H20" stroke="#e8a33d" stroke-width="1.8" opacity="0"/>
      <g id="tag${i}" opacity="0">
        <rect x="-26" y="-14" width="52" height="16" rx="8" fill="#212226" stroke="#3a3b42" stroke-width="1.1"/>
        <text x="0" y="-2.4" text-anchor="middle" font-size="10.5">${b.label}</text>
      </g>`).join("")}

      <g id="waves" stroke="currentColor" clip-path="url(#wavesclip)">
        <path id="w1" d="${wave(184, 2.6)}" stroke-width="1.6"/>
        <path id="w2" d="${wave(197, 2.2)}" stroke-width="1.5" stroke-dasharray="16 8" opacity="0.5"/>
        <path id="w3" d="${wave(210, 2)}" stroke-width="1.4" stroke-dasharray="6 10 14 6" opacity="0.28"/>
      </g>
    </g>
  </svg>`;
  const hw = document.getElementById("harbour-wrap");
  hw.innerHTML = harbourSVG;
  const stripH = (F.strip.w * 152) / 960;
  Object.assign(hw.style, { width: F.strip.w + "px", height: stripH + "px", left: (F.W - F.strip.w) / 2 + "px", right: "auto", bottom: F.strip.bottom + "px" });
  const $ = (id) => document.getElementById(id);
  const H = {
    sun: $("sun"), gull1: $("gull1"), gull2: $("gull2"), fog1: $("fog1"), fog2: $("fog2"), quay: [...$("quay").children],
    shed: [...$("shed").querySelectorAll("path")], shedwin: $("shedwin"), shedring: $("shedring"), shedlabel: $("shedlabel"),
    w1: $("w1"), w2: $("w2"), w3: $("w3"), wavesrect: $("wavesrect"), headland: $("headland"),
    boats: BOATS.map((_, i) => ({ g: $("boat" + i), lines: $("lines" + i), wake: $("wake" + i), on: $("boat" + i).querySelector(".lampon"), off: $("boat" + i).querySelector(".lampoff"), glint: $("glint" + i), tag: $("tag" + i) })),
  };

  // ---------------------------------------------------------------- scenes
  const T = {
    logo: [0, at(2)],
    problem: [at(2), at(4)],
    install: [at(4), at(6)],
    agents: [at(6), at(8)],
    fan: [at(8), at(10)],
    url: [at(10), at(12)],
    sleep: [at(12), at(14)],
    end: [at(14), DUR + 1],
  };

  // 1 · Logo at dawn
  const S1 = scene("s-logo");
  const s1box = box(S1, 980, 360, F.logoCy);
  s1box.innerHTML = `
    <div class="abs lockup" style="left:50%;top:0;transform:translateX(-50%)">
      <div class="mk">${MARK(190, "m1")}</div>
      <div class="word"><span>berth</span></div>
    </div>
    <div class="abs tagline" style="left:0;right:0;top:250px">A harbour for your agents.</div>`;
  const s1 = { lock: s1box.querySelector(".lockup"), mk: s1box.querySelector(".mk"), tile: s1box.querySelector(".tile"), b: s1box.querySelector(".b"), dot: s1box.querySelector(".dot"), word: s1box.querySelector(".word"), tag: s1box.querySelector(".tagline") };
  s1.tagWords = (() => {
    const el = s1.tag;
    const words = el.textContent.split(" ");
    el.innerHTML = words.map((w) => `<span class="w" style="display:inline-block">${w}</span>`).join(" ");
    return [...el.querySelectorAll(".w")];
  })();

  // 2 · The problem
  const S2 = scene("s-problem");
  const s2head = headline(S2, ["When your laptop sleeps,", "your agents stop."]);
  const s2box = box(S2, 760, 420, F.box.cy + (F.narrow ? 0 : 24), 1.12);
  s2box.innerHTML = `
    <svg class="abs" style="left:0;top:0" width="760" height="420" viewBox="0 0 760 420" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g class="lid" style="transform-origin: 380px 300px">
        <rect x="150" y="20" width="460" height="280" rx="18" fill="#1c1d21" stroke="#8a8c95" stroke-width="3"/>
        <g class="screen">
          <text x="186" y="80" font-family="JetBrains Mono" font-size="22" fill="#e3e4e8">claude</text>
          <text x="276" y="80" font-family="JetBrains Mono" font-size="22" fill="#8d8f98">on this laptop</text>
          <text x="186" y="124" font-family="JetBrains Mono" font-size="20" fill="#8d8f98">&gt; Fix the checkout webhook</text>
          <text x="186" y="166" font-family="JetBrains Mono" font-size="20" fill="#b6b8bf">● Update(webhook.ts)</text>
          <rect x="186" y="196" width="230" height="9" rx="4.5" fill="#8a8c95" opacity="0.3"/>
          <rect x="186" y="220" width="170" height="9" rx="4.5" fill="#8a8c95" opacity="0.3"/>
          <g class="spin2" style="transform-origin: 196px 260px"><path d="M196 250 a10 10 0 1 1 -10 10" stroke="#b6b8bf" stroke-width="2.6"/></g>
          <text x="220" y="267" font-family="JetBrains Mono" font-size="20" fill="#b6b8bf">working</text>
        </g>
      </g>
      <path d="M96 308 H664 L640 334 H120 Z" fill="#1c1d21" stroke="#8a8c95" stroke-width="3"/>
      <path d="M340 308 H420" stroke="#8a8c95" stroke-width="3" opacity="0.6"/>
      <g class="zz" opacity="0">
        <path d="M352 258 a22 22 0 1 0 22 30 a17 17 0 1 1 -22 -30 Z" stroke="#8a8c95" stroke-width="2.6"/>
        <text x="402" y="262" font-family="Inter" font-weight="600" font-size="26" fill="#8a8c95">z</text>
        <text x="424" y="240" font-family="Inter" font-weight="600" font-size="20" fill="#8a8c95">z</text>
      </g>
    </svg>
    <div class="abs mono chip2" style="left:50%;top:364px;transform:translateX(-50%);white-space:nowrap;font-size:26px;color:#8d8f98"></div>`;
  const s2 = { lid: s2box.querySelector(".lid"), screen: s2box.querySelector(".screen"), spin: s2box.querySelector(".spin2"), zz: s2box.querySelector(".zz"), chip: s2box.querySelector(".chip2") };

  // 3 · One line installs berthd
  const S3 = scene("s-install");
  const s3head = headline(S3, [`One line installs <span class="mono" style="font-size:0.92em;letter-spacing:-0.02em">berthd</span> on a box.`]);
  const s3box = box(S3, 1180, 420);
  s3box.innerHTML = `
    <div class="abs term" style="left:0;top:0">
      <div class="bar"><i></i><i></i><i></i><span>you@devl: ~</span></div>
      <pre></pre>
    </div>`;
  const s3 = { term: s3box.querySelector(".term"), pre: s3box.querySelector("pre") };
  const CMD = ["curl ", "-fsSL ", "https://", "berthd.app", "/install ", "| sh"];
  const OUT = [
    [at(4, 3.5), `<span class="d">==&gt;</span> Downloading berthd (v0.1.2, linux/amd64)`],
    [at(5, 0), `<span class="d">  verified against checksums.txt</span>`],
    [at(5, 1), `<span class="d">==&gt;</span> Starting the service`],
    [at(5, 2), `<span class="b">berthd v0.1.2 is running.</span>`],
  ];

  // 4 · Every agent, by what it needs
  const S4 = scene("s-agents");
  const s4head = headline(S4, F.narrow ? ["Every agent on every box,", "by what it needs."] : ["Every agent on every box, by what it needs."]);
  const DW = F.dashW;
  const colW = (DW - 52 - 44) / 3;
  const s4box = box(S4, DW, 500, F.box.cy + (F.narrow ? 20 : 4));
  const G = {
    wait: `<svg width="22" height="22" viewBox="0 0 22 22"><circle cx="11" cy="11" r="7" fill="#e8a33d"/></svg>`,
    work: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 4 a8 8 0 1 1 -8 8" stroke="#b6b8bf" stroke-width="2.6" stroke-linecap="round"/></svg>`,
    done: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12.5 l4.5 4.5 l9.5 -10" stroke="#3fb950" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };
  const spinner = (cls) => `<svg class="${cls}" width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex:none"><path d="M12 4 a8 8 0 1 1 -8 8" stroke="#b6b8bf" stroke-width="2.6" stroke-linecap="round"/></svg>`;
  const doneG = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex:none"><path d="M5 12.5 l4.5 4.5 l9.5 -10" stroke="#3fb950" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const waitG = `<svg width="24" height="24" viewBox="0 0 24 24" style="flex:none"><circle cx="12" cy="12" r="7" fill="#e8a33d"/></svg>`;
  s4box.innerHTML = `
    <div class="abs dash" style="left:0;top:0;width:${DW}px">
      <div class="col"><h5>${G.wait}Needs you<span class="n amber" data-n="wait">0</span></h5></div>
      <div class="col"><h5>${G.work}Working<span class="n" data-n="work">0</span></h5></div>
      <div class="col"><h5>${G.done}Done<span class="n" data-n="done">2</span></h5></div>
    </div>`;
  const dash = s4box.querySelector(".dash");
  const cols = [...dash.querySelectorAll(".col")];
  const card = (name, meta, glyph, extra = "") => h(`
    <div class="card"><div class="t">${glyph}<span>${name}</span></div><div class="m">${meta}</div>${extra}</div>`);
  const qa = card("qa-deck", "devl · codex", `<span class="g">${spinner("sp")}</span>`);
  const bf = card("checkout-fix", "devl · claude", `<span class="g">${spinner("sp")}</span>`, `<div class="ask"><div class="q">Cap the total retry time too?</div><div class="chips"><span><b>1</b>Yes, 30s</span><span><b>2</b>No</span></div></div>`);
  const jv = card("judge-v2", "gpu · cursor", `<span class="g">${spinner("sp")}</span>`);
  const bp = card("search-perf", "devl · claude", doneG);
  const cf = card("ci-flake", "gpu · codex", doneG);
  for (const c of [bf, qa, jv, bp, cf]) dash.appendChild(c);
  const s4 = { dash, cols, bf, qa, jv, bp, cf, counts: Object.fromEntries([...dash.querySelectorAll("[data-n]")].map((e) => [e.dataset.n, e])) };

  // 5 · One prompt, several agents, each in its own worktree
  const S5 = scene("s-fan");
  const s5head = headline(S5, ["One prompt, several agents."]);
  const s5sub = sub(S5, "Each in its own worktree.", 0);
  const FW = 1360, FH = 440;
  const s5box = box(S5, FW, FH, F.box.cy + (F.narrow ? 10 : 34));
  const lanes = [
    { y: 70, name: "checkout-fix", meta: "devl · claude", br: "me/checkout-fix" },
    { y: 220, name: "qa-deck", meta: "devl · codex", br: "me/qa-deck" },
    { y: 370, name: "judge-v2", meta: "gpu · cursor", br: "me/judge-v2" },
  ];
  const ox = 452, oy = 220, cx0 = 830;
  const lanePath = (y) => `M${ox} ${oy} C ${ox + 150} ${oy}, ${cx0 - 190} ${y}, ${cx0 - 16} ${y}`;
  s5box.innerHTML = `
    <svg class="abs" style="left:0;top:0;overflow:visible" width="${FW}" height="${FH}" viewBox="0 0 ${FW} ${FH}" fill="none" stroke-linecap="round" stroke-linejoin="round">
      ${lanes.map((l, i) => `<path class="dots" d="${lanePath(l.y)}" stroke="#8a8c95" stroke-width="3" stroke-dasharray="0.1 12" opacity="0.7"/>
        <path class="solid" pathLength="1" d="${lanePath(l.y)}" stroke="#8a8c95" stroke-width="3"/>
        ${[0.42, 0.66, 0.86].map((p) => `<circle class="commit c${i}" r="7" fill="#1c1d21" stroke="#b6b8bf" stroke-width="3" data-p="${p}"/>`).join("")}
        <circle class="runner" r="7" fill="#e3e4e8"/>`).join("")}
      <circle cx="${ox}" cy="${oy}" r="9" fill="#1c1d21" stroke="#b6b8bf" stroke-width="3"/>
    </svg>
    <div class="abs panel prompt" style="left:0;top:${oy - 112}px;width:${ox - 40}px;height:224px;padding:30px 32px">
      <div style="font:450 22px var(--sans);color:var(--muted)">Send to 3 agents</div>
      <div style="margin-top:14px;font:550 34px/1.2 var(--sans);color:var(--fg);letter-spacing:-0.015em">Make the check pass</div>
      <div class="send" style="position:absolute;right:26px;bottom:24px;width:64px;height:42px;border-radius:11px;background:#e3e4e8;display:flex;align-items:center;justify-content:center">
        <svg width="26" height="20" viewBox="0 0 26 20" fill="none"><path d="M3 10 H22 M15 3 L22 10 L15 17" stroke="#18191c" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
    </div>
    ${lanes.map((l, i) => `
    <div class="abs panel agent a${i}" style="left:${cx0}px;top:${l.y - 58}px;width:${FW - cx0}px;height:116px;padding:20px 26px">
      <div style="display:flex;align-items:center;gap:14px;font:550 30px/1.1 var(--sans);color:var(--fg);letter-spacing:-0.012em">
        <span>${l.name}</span>
        <span style="margin-left:auto;position:relative;width:30px;height:30px">
          <span class="st-work" style="position:absolute;inset:0">${spinner("sp5")}</span>
          <span class="st-done" style="position:absolute;inset:0;opacity:0"><svg width="30" height="30" viewBox="0 0 30 30" fill="none"><circle cx="15" cy="15" r="12.5" stroke="#3fb950" stroke-width="2.4"/><path d="M9.5 15.4 l3.8 3.8 l7.2 -7.8" stroke="#3fb950" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </span>
      </div>
      <div style="margin-top:12px;display:flex;gap:18px;font:450 21px var(--mono);color:var(--muted)">
        <span class="meta">${l.meta}</span><span class="br" style="color:var(--fg-2)">${l.br}</span>
      </div>
    </div>`).join("")}`;
  const s5svg = s5box.querySelector("svg");
  const s5 = {
    prompt: s5box.querySelector(".prompt"),
    send: s5box.querySelector(".send"),
    dots: [...s5svg.querySelectorAll(".dots")],
    solid: [...s5svg.querySelectorAll(".solid")],
    runners: [...s5svg.querySelectorAll(".runner")],
    commits: lanes.map((_, i) => [...s5svg.querySelectorAll(".commit.c" + i)]),
    agents: lanes.map((_, i) => s5box.querySelector(".a" + i)),
    origin: s5svg.querySelector(`circle[cx="${ox}"]`),
  };
  // Commit dots sit along their lane.
  s5.solid.forEach((p, i) => {
    const L = p.getTotalLength();
    s5.commits[i].forEach((c) => {
      const pt = p.getPointAtLength(L * +c.dataset.p);
      c.setAttribute("cx", pt.x);
      c.setAttribute("cy", pt.y);
    });
  });

  // 6 · A private URL for every worktree
  const S6 = scene("s-url");
  const s6head = headline(S6, ["Every worktree gets a private URL."]);
  const s6sub = sub(S6, "On your laptop only. Nothing public.", 0);
  const s6box = box(S6, 1240, 548, F.box.cy + (F.narrow ? 16 : 40));
  s6box.innerHTML = `
    <div class="abs browser" style="left:0;top:0">
      <div class="bar"><i></i><i></i><i></i>
        <div class="url"><svg width="18" height="22" viewBox="0 0 18 22" fill="none" style="flex:none"><rect x="2" y="9" width="14" height="11" rx="3" stroke="#8d8f98" stroke-width="2.2"/><path d="M5 9 V6.5 a4 4 0 0 1 8 0 V9" stroke="#8d8f98" stroke-width="2.2"/></svg><span class="typed"></span><span class="caret"></span></div>
        <i style="opacity:0"></i><i style="opacity:0"></i><i style="opacity:0"></i>
      </div>
      <div class="loadbar" style="position:absolute;left:0;top:74px;height:3px;width:100%;background:#8a8c95;transform-origin:0 50%"></div>
      <div class="page">
        <div class="pg p0" style="font:600 46px/1 var(--sans);color:var(--fg);letter-spacing:-0.02em">Checkout</div>
        <div class="pg p1" style="margin-top:14px;font:450 25px var(--sans);color:var(--muted)">2 items · ships Friday</div>
        <div class="pg p2" style="margin-top:34px;width:520px;height:116px;border:2px solid var(--border-2);border-radius:16px;padding:0 30px;display:flex;align-items:center;gap:14px">
          <span style="font:600 48px var(--sans);color:var(--fg);letter-spacing:-0.02em">€128.00</span><span style="font:450 25px var(--sans);color:var(--muted)">total</span>
        </div>
        <div class="pg p3" style="margin-top:22px;width:520px;height:64px;border:2px solid var(--border);border-radius:14px;display:flex;align-items:center;justify-content:space-between;padding:0 26px">
          <span style="width:190px;height:10px;border-radius:5px;background:#8a8c95;opacity:.3"></span><span style="width:110px;height:10px;border-radius:5px;background:#8a8c95;opacity:.3"></span>
        </div>
        <div class="pg p4" style="position:absolute;right:56px;top:44px;width:520px;display:grid;gap:22px">
          ${[300, 420, 360, 250, 390].map((w) => `<span style="display:block;width:${w}px;height:12px;border-radius:6px;background:#8a8c95;opacity:.22"></span>`).join("")}
        </div>
        <div class="pg p5 mono" style="position:absolute;right:56px;bottom:40px;font:450 21px var(--mono);color:var(--muted)">me/checkout-fix · port 3110</div>
      </div>
    </div>`;
  const s6 = { browser: s6box.querySelector(".browser"), typed: s6box.querySelector(".typed"), caret: s6box.querySelector(".caret"), load: s6box.querySelector(".loadbar"), pg: [...s6box.querySelectorAll(".pg")] };
  const URL_CHUNKS = ["3110.", "devl.", "localhost", ":1377"];

  // 7 · Close the laptop; the agents keep going
  const S7 = scene("s-sleep");
  const s7head = headline(S7, ["Close the laptop.", "Your agents keep going."]);
  const TW = 1320, TH = 330;
  const tx0 = 392, tx1 = TW - 40;
  const s7box = box(S7, TW, TH, F.box.cy + (F.narrow ? 10 : 30), 1.12);
  s7box.innerHTML = `
    <div class="abs panel" style="left:0;top:0;width:${TW}px;height:${TH}px;background:var(--bg-2);border-color:var(--border)"></div>
    <svg class="abs" style="left:0;top:0;overflow:visible" width="${TW}" height="${TH}" viewBox="0 0 ${TW} ${TH}" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <g class="lap" transform="translate(44 92)">
        <g class="lid7" style="transform-origin: 26px 32px"><rect x="6" y="0" width="40" height="32" rx="4" stroke="#8a8c95" stroke-width="2.6" fill="#1c1d21"/></g>
        <path d="M0 34 H52 L48 40 H4 Z" stroke="#8a8c95" stroke-width="2.6" fill="#1c1d21"/>
      </g>
      <text x="${F.narrow ? 112 : 116}" y="128" font-family="Inter" font-size="28" font-weight="500" fill="#b6b8bf">Your laptop</text>
      <g transform="translate(44 196)">
        <path d="M26 6 v26 M14.7 12.5 l22.6 13 M14.7 25.5 l22.6 -13" stroke="#8a8c95" stroke-width="2.8"/>
      </g>
      <text x="${F.narrow ? 112 : 116}" y="232" font-family="JetBrains Mono" font-size="26" fill="#b6b8bf">claude <tspan fill="#8d8f98">on devl</tspan></text>

      <path class="lt-solid" d="M${tx0} 118 H${tx1}" stroke="#b6b8bf" stroke-width="3.2"/>
      <path class="lt-dash" d="M${tx0} 118 H${tx1}" stroke="#8a8c95" stroke-width="3" stroke-dasharray="10 12" opacity="0.7"/>
      <text class="asleep" y="96" font-family="Inter" font-size="22" fill="#8d8f98">asleep</text>
      <path class="ag-solid" d="M${tx0} 222 H${tx1}" stroke="#b6b8bf" stroke-width="3.2"/>
      <text class="working" y="200" font-family="Inter" font-size="22" fill="#8d8f98">working</text>
      <g class="done7" opacity="0"><circle cx="${tx1}" cy="222" r="14" fill="#1c1d21" stroke="#3fb950" stroke-width="3"/><path d="M${tx1 - 6} 222.5 l4.2 4.2 l8 -8.6" stroke="#3fb950" stroke-width="3"/></g>
      <text class="done7t" x="${tx1}" y="200" text-anchor="end" font-family="Inter" font-size="22" fill="#b6b8bf" opacity="0">done</text>
      <g class="ph"><path d="M0 70 V262" stroke="#e3e4e8" stroke-width="2" opacity="0.5"/><circle class="phdot" cx="0" cy="222" r="8" fill="#e3e4e8"/></g>
      <text class="clock" y="296" text-anchor="middle" font-family="JetBrains Mono" font-size="26" fill="#e3e4e8">23:18</text>
    </svg>`;
  const s7svg = s7box.querySelector("svg");
  const s7 = {
    lid: s7svg.querySelector(".lid7"),
    ltSolid: s7svg.querySelector(".lt-solid"), ltDash: s7svg.querySelector(".lt-dash"), asleep: s7svg.querySelector(".asleep"),
    agSolid: s7svg.querySelector(".ag-solid"), working: s7svg.querySelector(".working"), done: s7svg.querySelector(".done7"), doneT: s7svg.querySelector(".done7t"),
    ph: s7svg.querySelector(".ph"), clock: s7svg.querySelector(".clock"),
  };

  // 8 · End card
  const S8 = scene("s-end");
  const s8box = box(S8, 1200, 560, F.logoCy + (F.narrow ? 40 : 40), 1.12);
  s8box.innerHTML = `
    <div class="abs lockup l8" style="left:50%;top:0;transform:translateX(-50%)">
      <div class="mk">${MARK(170, "m8")}</div>
      <div class="word" style="font-size:136px">berth</div>
    </div>
    <div class="abs e1" style="left:0;right:0;top:214px;text-align:center;font:500 ${F.narrow ? 40 : 44}px/1.2 var(--sans);letter-spacing:-0.022em;color:var(--fg-2)">Agents that keep working${F.narrow ? "<br>" : " "}when your laptop sleeps.</div>
    <div class="abs e2" style="left:0;right:0;top:${F.narrow ? 352 : 312}px;display:flex;justify-content:center;align-items:center;gap:26px">
      <span class="btn primary"><svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5 V10.5 M4.5 7 L8 10.5 L11.5 7 M3 13.5 H13"/></svg>Download for macOS</span>
    </div>
    <div class="abs e3" style="left:0;right:0;top:${F.narrow ? 462 : 422}px;text-align:center;font:500 34px/1.2 var(--sans);letter-spacing:-0.012em;color:var(--fg)">berthd.app<span style="color:var(--muted);font-weight:450"> · open source, MIT</span></div>`;
  const s8 = { lock: s8box.querySelector(".l8"), tile: s8box.querySelector(".tile"), b: s8box.querySelector(".b"), dot: s8box.querySelector(".dot"), word: s8box.querySelector(".word"), e1: s8box.querySelector(".e1"), e2: s8box.querySelector(".e2"), e3: s8box.querySelector(".e3") };

  await document.fonts.ready;
  // Sublines sit under their headlines, measured once the fonts are in.
  s5sub.style.top = headBottom(s5head) + 18 + "px";
  s1.shift = (s1.word.offsetWidth + 34) / 2;
  s6sub.style.top = headBottom(s6head) + 18 + "px";

  // ---------------------------------------------------------------- seek
  const scenes = { logo: S1, problem: S2, install: S3, agents: S4, fan: S5, url: S6, sleep: S7, end: S8 };
  const hud = document.getElementById("hud");
  if (Q.get("hud")) hud.hidden = false;

  function vis(name, t) {
    const [a, b] = T[name];
    const on = t >= a - 0.001 && t < b + 0.001;
    scenes[name].style.display = on ? "block" : "none";
    return on;
  }
  // Content boxes drift in a touch over their scene (a slow push-in).
  let pushIn = 1;
  const boxPut = (el, v) => {
    el.style.opacity = v.o.toFixed(4);
    el.style.transform = `${el.dataset.base} translate(0px, ${v.y.toFixed(2)}px) scale(${((v.s ?? 1) * pushIn).toFixed(4)})`;
  };

  function seekHarbour(t) {
    // Strip opacity: full where the harbour carries the story, quiet under UI.
    const quiet = [
      [T.problem[0], T.problem[1], 0.5],
      [T.fan[0], T.url[1], 0.42],
    ];
    let o = 1;
    for (const [a, b, q] of quiet) {
      const inn = prog(t, a, 0.6, E.inOutSine);
      const out = prog(t, b - 0.3, 0.6, E.inOutSine);
      o = Math.min(o, lerp(1, q, inn * (1 - out)));
    }
    hw.style.opacity = o.toFixed(4);

    // Water draws out from the middle over the first beats, then drifts.
    const wp = prog(t, 0.05, 1.5, E.out);
    H.wavesrect.setAttribute("x", (480 - 560 * wp).toFixed(2));
    H.wavesrect.setAttribute("width", (1120 * wp).toFixed(2));
    H.w1.setAttribute("transform", `translate(${(-((t / 8) % 1) * 24).toFixed(3)} 0)`);
    H.w2.setAttribute("transform", `translate(${(((t / 12) % 1) * 48 - 48).toFixed(3)} 0)`);
    H.w3.setAttribute("transform", `translate(${(-((t / 16) % 1) * 72).toFixed(3)} 0)`);
    // Quay and posts draw on in the intro.
    H.quay.forEach((p, i) => drawn(p, prog(t, 0.25 + i * 0.12, 1.1, E.inOut)));
    H.headland.style.opacity = (0.28 * prog(t, 0.6, 1.2)).toFixed(3);
    // Sun: rises in the intro; sets and comes back while the laptop sleeps.
    const rise = prog(t, 0.2, 3.6, E.out);
    const night = prog(t, at(12, 0.5), BEATS.bar * 0.9, E.inOutSine) * (1 - prog(t, at(13, 0.6), BEATS.bar * 0.9, E.inOutSine));
    H.sun.setAttribute("cy", (lerp(124, 100, rise) + night * 86).toFixed(2));
    H.sun.style.opacity = (0.45 * rise).toFixed(3);
    H.gull1.setAttribute("transform", `translate(${(Math.sin(t / 1.9) * 5 + t * 1.2).toFixed(2)} ${(Math.cos(t / 2.3) * 2).toFixed(2)})`);
    H.gull2.setAttribute("transform", `translate(${(Math.sin(t / 2.4 + 1) * 4 + t * 1.0).toFixed(2)} ${(Math.cos(t / 1.7) * 1.6).toFixed(2)})`);
    H.gull1.parentNode.style.opacity = (0.6 * prog(t, 1.0, 1.0)).toFixed(3);
    H.fog1.setAttribute("transform", `translate(${(Math.sin(t / 4.5) * 10).toFixed(2)} 0)`);
    H.fog2.setAttribute("transform", `translate(${(-Math.sin(t / 5.7) * 10).toFixed(2)} 0)`);
    H.fog1.parentNode.style.opacity = prog(t, 0.8, 1.6).toFixed(3);

    // The box: the shed builds a beat after berthd starts.
    const sb = at(5, 0);
    H.shed.forEach((p, i) => drawn(p, prog(t, sb + i * 0.07, 0.55, E.inOut)));
    H.shedwin.style.opacity = (0.75 * prog(t, at(5, 1), 0.3, E.out)).toFixed(3);
    const ring = prog(t, at(5, 1), 1.1, E.out);
    H.shedring.setAttribute("r", (10 + 26 * ring).toFixed(2));
    H.shedring.style.opacity = (ring > 0 && ring < 1 ? 0.7 * (1 - ring) : 0).toFixed(3);
    const lab = env(t, at(5, 1), T.agents[1], { din: 0.5, dy: 6, dyOut: -4, dout: 0.4 });
    H.shedlabel.setAttribute("opacity", lab.o.toFixed(3));
    H.shedlabel.setAttribute("transform", `translate(0 ${lab.y.toFixed(2)})`);

    // Boats: moored at their berths, then setting out one a beat, then at
    // work out on the water; one lamp lit while its agent needs you.
    BOATS.forEach((b, i) => {
      const B = H.boats[i];
      const intro = prog(t, 0.7 + i * 0.28, 0.9, E.out);
      const dep = at(6, 1 + (2 - i) * 0.5) - 0.12; // the furthest out leaves first
      const sail = prog(t, dep, 2.3, E.inOut);
      const xAt = (tt) => {
        const sl = prog(tt, dep, 2.3, E.inOut);
        // At work they wander; through the night they head further out.
        const out = 46 * prog(tt, at(12, 0.5), BEATS.bar * 1.6, E.inOutSine) * (0.5 + i * 0.35);
        return lerp(b.x0, b.x1, sl) + sl * (Math.sin((tt - dep) / 2.6 + b.ph) * 10 + out);
      };
      const x = xAt(t);
      const vx = (xAt(t + 0.05) - xAt(t - 0.05)) / 0.1;
      const sc = lerp(1, 0.82, sail);
      const y = lerp(175, 177, sail) + (1 - intro) * 8 + Math.sin((t * 2 * Math.PI) / 5.2 + b.ph) * 0.9;
      const rot = Math.sin((t * 2 * Math.PI) / 5.2 + b.ph + 0.8) * 1.2 - clamp(vx / 40, -1, 1) * 1.4;
      B.g.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${rot.toFixed(3)} 44 12) scale(${sc.toFixed(4)})`);
      B.g.style.opacity = intro.toFixed(3);
      B.lines.style.opacity = (intro * (1 - prog(t, dep - 0.1, 0.3))).toFixed(3);
      B.wake.setAttribute("transform", `translate(${x.toFixed(2)} ${(y + 1).toFixed(2)}) scale(${sc.toFixed(4)})`);
      const wk = sail > 0 ? clamp(Math.abs(vx) / 28) : 0;
      B.wake.style.opacity = wk.toFixed(3);
      [...B.wake.children].forEach((p, k) => p.setAttribute("transform", `translate(${(-((t * (k ? 9 : 13)) % 13)).toFixed(2)} 0)`));
      // Lamp: only checkout-fix's boat (claude), from "needs you" until morning.
      if (i === 0) {
        const lit = prog(t, at(7, 0), 0.25) * (1 - prog(t, at(14, 0) - 0.05, 0.4));
        B.on.style.opacity = lit.toFixed(3);
        B.off.style.opacity = (1 - lit).toFixed(3);
        B.glint.setAttribute("transform", `translate(${(x + 26 * sc).toFixed(2)} ${(y + 20).toFixed(2)}) scale(${sc * (0.85 + 0.15 * Math.sin(t * 2.4))} 1)`);
        B.glint.style.opacity = (lit * (0.35 + 0.12 * Math.sin(t * 2.4))).toFixed(3);
      }
      const tg = env(t, dep + 0.05, at(8, 0), { din: 0.5, dy: 5, dyOut: -3, dout: 0.35 });
      B.tag.setAttribute("opacity", tg.o.toFixed(3));
      B.tag.setAttribute("transform", `translate(${(x + 36 * sc).toFixed(2)} ${(y - 50 * sc + tg.y).toFixed(2)})`);
    });
  }

  function seek(t) {
    seekHarbour(t);
    for (const [name, [a, b]] of Object.entries(T)) {
      if (t >= a && t < b) pushIn = 1 + 0.024 * prog(t, a, Math.min(b, DUR) - a, E.inOutSine);
    }

    // 1 · logo
    if (vis("logo", t)) {
      const out = T.logo[1];
      const all = env(t, 0, out, { din: 0.01, dout: 0.3, dyOut: -18 });
      boxPut(s1box, { o: all.o, y: all.y });
      const tile = prog(t, 0.08, 0.9, E.outExpo);
      s1.tile.style.opacity = tile;
      s1.mk.style.transform = `scale(${lerp(0.9, 1, tile)})`;
      riseB(s1.b, prog(t, 0.22, 0.9, E.outExpo));
      // The dot drops in on beat 2 and rides like a buoy after.
      const d0 = at(0, 2);
      const drop = prog(t, d0 - 0.18, 0.5, E.outBack);
      const bob = t > d0 ? Math.sin(((t - d0) * 2 * Math.PI) / BEATS.bar) * 10 : 0;
      s1.dot.style.transformBox = "fill-box";
      s1.dot.style.transformOrigin = "50% 50%";
      s1.dot.style.transform = `translate(0px, ${(-150 * (1 - drop) + bob).toFixed(2)}px) scale(${lerp(0.4, 1, prog(t, d0 - 0.18, 0.3, E.out))})`;
      s1.dot.style.opacity = prog(t, d0 - 0.18, 0.14);
      const wd = prog(t, at(0, 3), 0.8, E.outExpo);
      s1.word.style.clipPath = `inset(-20% ${(100 - wd * 100).toFixed(2)}% -20% 0)`;
      s1.word.style.transform = `translateX(${(-26 * (1 - wd)).toFixed(2)}px)`;
      const slide = prog(t, at(0, 3) - 0.05, 0.75, E.inOut);
      s1.lock.style.transform = `translateX(-50%) translateX(${(s1.shift * (1 - slide)).toFixed(2)}px)`;
      s1.tagWords.forEach((w, j) => put(w, env(t, at(1, 0) + j * 0.06, null, { din: 0.7, dy: 22 })));
    }

    // 2 · problem
    if (vis("problem", t)) {
      const [a, out] = T.problem;
      playHead(s2head, t, [a, at(3, 0)], out);
      boxPut(s2box, env(t, a + 0.1, out, { dy: 40, dout: 0.26 }));
      // The lid shuts on the downbeat of bar 3, landing on beat 2.
      const c = prog(t, at(3, 0), BT * 1.0, E.inOut);
      s2.lid.style.transform = `scaleY(${lerp(1, 0.03, c).toFixed(4)})`;
      s2.screen.style.opacity = (1 - prog(t, at(3, 0), 0.25)).toFixed(3);
      s2.spin.style.transform = `rotate(${((t * 300) % 360).toFixed(1)}deg)`;
      s2.zz.setAttribute("opacity", prog(t, at(3, 1.6), 0.4, E.out).toFixed(3));
      s2.zz.setAttribute("transform", `translate(0 ${(-12 * prog(t, at(3, 1.6), 1.2, E.out)).toFixed(2)})`);
      const stopped = t >= at(3, 1);
      s2.chip.innerHTML = stopped ? `<span style="color:#b6b8bf">claude</span> · stopped` : `<span style="color:#b6b8bf">claude</span> · working`;
      s2.chip.style.opacity = (prog(t, a + 0.3, 0.5) * (stopped ? 0.6 + 0.4 * prog(t, at(3, 1), 0.3) : 1)).toFixed(3);
    }

    // 3 · install
    if (vis("install", t)) {
      const [a, out] = T.install;
      playHead(s3head, t, [a], out);
      boxPut(s3box, env(t, a, out, { dy: 46, s0: 0.97 }));
      let html = `<span class="p">$ </span><span class="c">`;
      CMD.forEach((ch, k) => {
        if (t >= at(4, k * 0.5)) html += ch;
      });
      html += `</span>`;
      const entered = t >= at(4, 3);
      const caretOn = Math.floor(((t - a) / BT) * 2) % 2 === 0 || !entered;
      if (!entered) html += `<span class="caret" style="opacity:${caretOn ? 1 : 0}"></span>`;
      for (const [tt, line] of OUT) if (t >= tt) html += "\n" + line;
      if (entered && t < OUT[OUT.length - 1][0]) html += "\n" + `<span class="caret" style="opacity:${caretOn ? 0.8 : 0}"></span>`;
      if (t >= OUT[OUT.length - 1][0]) html += "\n" + `<span class="p">$ </span><span class="caret" style="opacity:${caretOn ? 1 : 0}"></span>`;
      if (s3.pre.innerHTML !== html) s3.pre.innerHTML = html;
    }

    // 4 · agents
    if (vis("agents", t)) {
      const [a, out] = T.agents;
      playHead(s4head, t, [a, a + 0.18], out);
      boxPut(s4box, env(t, a, out, { dy: 46, s0: 0.98 }));
      s4.cols.forEach((c, i) => put(c.querySelector("h5"), env(t, a + 0.1 + i * 0.07, null, { dy: 16 })));
      const cw = colW + 22; // column pitch
      const rowH = 132;
      // where each card is, as [column, row] keyframes on beats
      const place = (el, keys, tin) => {
        let col = keys[0][1], row = keys[0][2];
        let pc = col, pr = row, p = 1;
        for (let k = 1; k < keys.length; k++) {
          if (t >= keys[k][0]) {
            pc = col; pr = row;
            col = keys[k][1]; row = keys[k][2];
            p = prog(t, keys[k][0], 0.5, E.outExpo);
          }
        }
        const x = lerp(pc, col, p) * cw;
        const y = 58 + lerp(pr, row, p) * rowH;
        const v = env(t, tin, null, { din: 0.5, dy: -18, s0: 0.95 });
        el.style.left = "0px";
        el.style.width = colW + "px";
        el.style.top = "0px";
        el.style.opacity = v.o.toFixed(3);
        el.style.visibility = v.o < 0.002 ? "hidden" : "visible";
        el.style.transform = `translate(${x.toFixed(2)}px, ${(y + v.y).toFixed(2)}px) scale(${v.s.toFixed(4)})`;
      };
      const b1 = at(6, 1), b2 = at(6, 2), b3 = at(6, 3), m1 = at(7, 0), m2 = at(7, 2);
      place(s4.bp, [[0, 2, 0], [m2, 2, 1]], a + 0.25);
      place(s4.cf, [[0, 2, 1], [m2, 2, 2]], a + 0.32);
      place(s4.bf, [[0, 1, 0], [m1, 0, 0]], b1);
      place(s4.qa, [[0, 1, 1], [m1, 1, 0], [m2, 2, 0]], b2);
      place(s4.jv, [[0, 1, 2], [m1, 1, 1], [m2, 1, 0]], b3);
      // checkout-fix needs you: amber outline, its question and answers.
      const w = prog(t, m1, 0.35, E.out);
      s4.bf.classList.toggle("wait", t >= m1);
      const ask = s4.bf.querySelector(".ask");
      ask.style.display = t >= m1 ? "block" : "none";
      ask.style.opacity = prog(t, m1 + 0.15, 0.4, E.out).toFixed(3);
      s4.bf.querySelector(".g").innerHTML = t >= m1 ? waitG : spinner("sp");
      s4.qa.querySelector(".g").innerHTML = t >= m2 ? doneG : spinner("sp");
      for (const sp of s4.dash.querySelectorAll(".sp")) sp.style.transform = `rotate(${((t * 330) % 360).toFixed(1)}deg)`;
      const nWork = (t >= b1) + (t >= b2) + (t >= b3) - (t >= m1) - (t >= m2);
      s4.counts.wait.textContent = t >= m1 ? 1 : 0;
      s4.counts.work.textContent = nWork;
      s4.counts.done.textContent = 2 + (t >= m2);
      s4.counts.wait.style.opacity = t >= m1 ? 1 : 0.5;
      void w;
    }

    // 5 · fan-out
    if (vis("fan", t)) {
      const [a, out] = T.fan;
      playHead(s5head, t, [a], out);
      put(s5sub, env(t, at(9, 0), out, { dy: 18 }), "translateX(-50%)");
      boxPut(s5box, env(t, a, out, { dy: 40, s0: 0.98 }));
      put(s5.prompt, env(t, a + 0.05, null, { dy: 24 }));
      const press = prog(t, at(8, 1) - 0.08, 0.08) * (1 - prog(t, at(8, 1) + 0.04, 0.22, E.out));
      s5.send.style.transform = `scale(${(1 - 0.12 * press).toFixed(4)})`;
      s5.agents.forEach((ag, i) => {
        const v = env(t, a + 0.12 + i * 0.06, null, { dy: 24 });
        const arrive = at(8, 2 + i * 0.5);
        const lit = prog(t, arrive, 0.3, E.out);
        v.o *= 0.45 + 0.55 * lit;
        put(ag, v);
        ag.style.borderColor = lit > 0.01 ? `rgb(${lerp(58, 110, lit * (1 - prog(t, arrive + 0.3, 0.8)))} ${lerp(59, 112, lit * (1 - prog(t, arrive + 0.3, 0.8)))} ${lerp(66, 120, lit * (1 - prog(t, arrive + 0.3, 0.8)))})` : "";
        const done = prog(t, at(9, 2 + i * 0.5), 0.3, E.outBack);
        ag.querySelector(".st-work").style.opacity = (lit * (1 - done)).toFixed(3);
        ag.querySelector(".st-done").style.opacity = done.toFixed(3);
        ag.querySelector(".st-done").style.transform = `scale(${lerp(0.6, 1, done).toFixed(3)})`;
        ag.querySelector(".sp5").style.transform = `rotate(${((t * 330) % 360).toFixed(1)}deg)`;
        // branch name in, as the lane turns into a worktree's branch
        const br = prog(t, at(9, 0) + i * 0.06, 0.5, E.out);
        ag.querySelector(".br").style.opacity = br.toFixed(3);
        ag.querySelector(".meta").style.display = br > 0.5 ? "none" : "inline";
        ag.querySelector(".br").style.display = br > 0.5 ? "inline" : "none";
      });
      s5.dots.forEach((d, i) => (d.style.opacity = (0.7 * prog(t, a + 0.2, 0.4) * (1 - prog(t, at(9, 0), 0.3))).toFixed(3)));
      s5.solid.forEach((p, i) => {
        const L = p.getTotalLength();
        const go = at(8, 1.5 + i * 0.5) - 0.02;
        const run = prog(t, go - BT, BT, E.inOut);
        drawn(p, prog(t, at(9, 0) + i * 0.05, 0.5, E.inOut));
        const r = s5.runners[i];
        const pt = p.getPointAtLength(L * run);
        r.setAttribute("cx", pt.x);
        r.setAttribute("cy", pt.y);
        r.style.opacity = (run > 0 && run < 1 ? 1 : 0).toString();
        s5.commits[i].forEach((c, k) => {
          const pop = prog(t, at(9, 1 + k * 0.5) + i * 0.08, 0.3, E.outBack);
          c.style.opacity = prog(t, at(9, 1 + k * 0.5) + i * 0.08, 0.1).toFixed(3);
          c.setAttribute("r", (7 * pop).toFixed(2));
        });
      });
    }

    // 6 · private URL
    if (vis("url", t)) {
      const [a, out] = T.url;
      playHead(s6head, t, [a], out);
      put(s6sub, env(t, at(11, 0), out, { dy: 18 }), "translateX(-50%)");
      const v = env(t, a, out, { dy: 44, s0: 0.97 });
      v.s *= 1 + 0.025 * prog(t, at(11, 0), BEATS.bar, E.inOutSine);
      boxPut(s6box, v);
      let u = "";
      URL_CHUNKS.forEach((c, k) => {
        if (t >= at(10, 0.5 + k * 0.5)) u += c;
      });
      s6.typed.textContent = u;
      const loaded = at(10, 2.5);
      s6.caret.style.opacity = t < loaded && Math.floor(((t - a) / BT) * 2) % 2 === 0 ? 1 : 0;
      const lb = prog(t, loaded, 0.45, E.out);
      s6.load.style.transform = `scaleX(${lb.toFixed(4)})`;
      s6.load.style.opacity = (lb > 0 ? 0.6 * (1 - prog(t, loaded + 0.4, 0.3)) : 0).toFixed(3);
      s6.pg.forEach((p, k) => put(p, env(t, at(10, 3 + k * 0.25), null, { dy: 16, din: 0.5 })));
    }

    // 7 · sleep
    if (vis("sleep", t)) {
      const [a, out] = T.sleep;
      playHead(s7head, t, [a, at(13, 0)], out);
      boxPut(s7box, env(t, a, out, { dy: 40, s0: 0.98 }));
      const shut = at(12, 1);
      const c = prog(t, shut - BT * 0.5, BT * 0.6, E.inOut);
      s7.lid.style.transform = `scaleY(${lerp(1, 0.08, c).toFixed(4)})`;
      // The playhead runs the night through, from 23:18 to 07:40.
      const p0 = a + 0.25, p1 = at(13, 3);
      const p = prog(t, p0, p1 - p0, E.inOutSine);
      const x = lerp(tx0, tx1, p);
      const xShut = lerp(tx0, tx1, prog(shut, p0, p1 - p0, E.inOutSine));
      s7.ph.setAttribute("transform", `translate(${x.toFixed(2)} 0)`);
      const mins = Math.round(lerp(23 * 60 + 18, 31 * 60 + 40, p));
      s7.clock.textContent = `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      s7.clock.setAttribute("x", x.toFixed(2));
      s7.ltSolid.setAttribute("d", `M${tx0} 118 H${Math.min(x, xShut).toFixed(2)}`);
      s7.ltDash.setAttribute("d", `M${xShut.toFixed(2)} 118 H${Math.max(x, xShut).toFixed(2)}`);
      s7.ltDash.style.opacity = (t > shut ? 0.7 : 0).toString();
      s7.asleep.setAttribute("x", (xShut + 16).toFixed(2));
      s7.asleep.style.opacity = prog(t, shut + 0.15, 0.4).toFixed(3);
      s7.agSolid.setAttribute("d", `M${tx0} 222 H${x.toFixed(2)}`);
      s7.working.setAttribute("x", (tx0 + 4).toFixed(2));
      s7.working.style.opacity = (prog(t, p0 + 0.3, 0.4) * (1 - prog(t, p1 - 0.2, 0.3))).toFixed(3);
      const dn = prog(t, p1, 0.35, E.outBack);
      s7.done.setAttribute("opacity", prog(t, p1, 0.12).toFixed(3));
      s7.done.setAttribute("transform", `translate(${tx1} 222) scale(${lerp(0.5, 1, dn).toFixed(3)}) translate(${-tx1} -222)`);
      s7.doneT.setAttribute("opacity", prog(t, p1 + 0.08, 0.3).toFixed(3));
      s7.ph.style.opacity = (1 - prog(t, p1, 0.3)).toFixed(3);
    }

    // 8 · end card
    if (vis("end", t)) {
      const a = T.end[0];
      const v = env(t, a, null, { din: 0.9, dy: 24, s0: 0.97 });
      boxPut(s8box, { o: 1, y: 0 });
      put(s8.lock, v, "translateX(-50%)");
      const tile = prog(t, a, 0.6, E.outExpo);
      s8.tile.style.opacity = tile;
      riseB(s8.b, prog(t, a + 0.04, 0.8, E.outExpo));
      const d0 = a + 0.36;
      const drop = prog(t, d0 - 0.18, 0.5, E.outBack);
      const bob = t > d0 ? Math.sin(((t - d0) * 2 * Math.PI) / BEATS.bar) * 10 : 0;
      s8.dot.style.transformBox = "fill-box";
      s8.dot.style.transformOrigin = "50% 50%";
      s8.dot.style.transform = `translate(0px, ${(-150 * (1 - drop) + bob).toFixed(2)}px)`;
      s8.dot.style.opacity = prog(t, d0 - 0.18, 0.14);
      put(s8.e1, env(t, at(14, 1), null, { dy: 22 }));
      put(s8.e2, env(t, at(14, 2), null, { dy: 22 }));
      put(s8.e3, env(t, at(14, 3), null, { dy: 22 }));
    }

    if (!hud.hidden) {
      const k = Math.floor((t - BEATS.downbeats[0]) / BT + 1e-6);
      hud.textContent = `t ${t.toFixed(3)}  bar ${Math.floor(k / 4)}  beat ${(k % 4) + 1}`;
    }
  }

  window.seek = seek;
  window.VIDEO = { duration: DUR, beats: BEATS, scenes: T, format: F };
  seek(+(Q.get("t") || 0));
  window.__ready = true;
})();
