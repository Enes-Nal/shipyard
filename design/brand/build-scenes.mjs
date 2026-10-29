#!/usr/bin/env node
// build-scenes.mjs regenerates the scene parts of the brand board
// (design/brand/index.html) from the app's own code, so the board can't drift:
//
//   - every <svg data-scene> on the board is re-rendered from
//     app/src/components/art/scenes.tsx (the real <Scene> component), keeping
//     its width, its still flag and any x/y it is placed at;
//   - the "Scenes" gallery gets one card per name in SCENES;
//   - the "Where each scene appears" map is read from app/src: every
//     <Scene name=…> (including names chosen in an expression, such as
//     name={filtered ? "lighthouse" : "ended"}), with its file and line;
//   - the scene styles are copied from app/src/components/art/scenes.css.
//
//   node design/brand/build-scenes.mjs           rewrite index.html
//   node design/brand/build-scenes.mjs --check   exit 1 if it is out of date
//
// It needs app/node_modules (pnpm -C app install). A placement or a scene
// with no words below fails the build: describe it in PLACES or SCENE_COPY.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const app = join(root, "app");
const src = join(app, "src");
const board = join(import.meta.dirname, "index.html");
const check = process.argv.includes("--check");

// What each scene says, for its gallery card.
const SCENE_COPY = {
  moored: ["Boat tied up.", "Ready to set off. A worktree with nothing open yet.", "rides the swell · 5.2s"],
  ended: ["Empty berth.", "What ran here has left: a slack line, a bobbing buoy.", "buoy bob 4.4s · glint"],
  offline: ["Fog.", "The box is out of sight; Terminal keeps looking.", "light pulse 3.6s · fog drift 12–16s"],
  lighthouse: ["Lighthouse.", "Searching. The beam sweeps the water and finds nothing yet.", "sweep ±7° 7s · lamp 3.5s"],
  dawn: ["Harbour at dawn.", "Nothing here yet, and the start of something.", "sun lifts 3px 10s · gulls 5s"],
  "setting-out": ["Setting out.", "A boat under sail leaving the jetty: work beginning.", "pitch 4.8s · wake 2.4s"],
  rafted: ["Rafted up.", "Boats tied alongside: many agents, one message.", "three rides, 1.6s apart"],
  bottle: ["Message in a bottle.", "Every message read. The last one drifts off.", "roll ±3° 5.6s · rings 6s"],
  calm: ["Calm water.", "Nothing needs you. One buoy, rings spreading.", "bob 6.4s · rings 6s"],
  anchor: ["At anchor.", "Switched off and waiting, safe on the seabed.", "weed sway 6s · fish 9s"],
  storm: ["Squall.", "Something broke. Rain and chop; the buoy blinks.", "rain 1.6s · toss ±10° 3s"],
  chart: ["Chart.", "A course plotted, not sailed yet.", "needle ±9° 6s · ping 3.6s"],
  dock: ["Quay and crane.", "Nothing loaded yet. The hook waits.", "hook swing ±4° 5s · lamp"],
  arriving: ["Coming alongside.", "A boat comes in to an empty berth, line thrown for the cleat: a box on its way.", "ride ±1° 6s · line swing 4.4s"],
  signal: ["Signal lamp.", "Flashes across the water and a far lamp answers: reaching another network.", "flash 4s · answer 4s · fog lift 10s"],
  "first-crate": ["First crate.", "The crane sets the first load on an empty quay: the first thing on the box.", "sling sway ±1.5° 5s"],
};

// Where a scene is placed, keyed "<file under app/src>#<scene>": the screen,
// why this scene, and (when it can't be seen with ?mock=1) why not.
const PLACES = {
  "App.tsx#dawn": ["No worktree selected · Pick a worktree", "The first thing you see when nothing is open: an empty harbour, morning."],
  "components/agent-offline.tsx#lighthouse": ["Finding the Terminal agent…", "Looking for the laptop agent; replaces a spinner.", "Only without ?mock=1, for a moment while the app connects."],
  "components/agent-offline.tsx#offline": ["The Terminal agent is not running", "The same fog as an offline box: out of sight, not gone.", "Only without ?mock=1, when the laptop agent is stopped."],
  "components/error-boundary.tsx#storm": ["Something broke (error boundary)", "The only alarming scene, kept for real errors.", "Needs a real render error."],
  "components/workspace/launcher.tsx#moored": ["Worktree launcher", "A worktree with nothing open is a boat tied up, ready to set off."],
  "components/workspace/pane-state.tsx#ended": ["Terminal pane · session ended", "What ran here has left: an empty berth.", "The demo's exited session opens as a live terminal."],
  "components/workspace/pane-state.tsx#offline": ["Terminal pane · box offline", "The session keeps running out there, in the fog; Terminal reattaches when the box is back."],
  "components/add-project/add-project-dialog.tsx#offline": ["Add a project · box offline", "Projects are added on a box that is online; this one is in the fog.", "Only when every box is offline: the dialog picks an online box."],
  "components/add-project/add-project-dialog.tsx#dock": ["Add a project · no boxes yet", "A quay with an empty hook: there's nothing to load a project onto until there is a box."],
  "components/new-worktree/new-worktree-dialog.tsx#dock": ["New worktree · no boxes, or no projects", "Nothing loaded yet: add a box, or a project on one, first."],
  "components/new-worktree/new-worktree-dialog.tsx#offline": ["New worktree · no box online", "Every box is in the fog; worktrees are made on one that is online."],
  "components/notifications/notification-center.tsx#bottle": ["Notifications · You're all caught up", "Every message read; the last one drifts off."],
  "views/plugin-screen-view.tsx#anchor": ["Plugin screen · plugin is off", "Turned off on purpose, waiting at anchor. One click brings it up."],
  "views/plugin-screen-view.tsx#storm": ["Plugin screen · plugin didn't load", "Weather, not your fault. Try again sits below.", "Needs a plugin that fails while starting."],
  "views/plugin-screen-view.tsx#ended": ["Plugin screen · plugin isn't installed", "The berth is empty: what lived here has gone."],
  "views/kits/kits-view.tsx#dock": ["Kits · No kits yet", "Kits are what a project is loaded with; the hook is empty.", "The demo always has kits, even with &fresh=1."],
  "views/dashboard/dashboard-view.tsx#setting-out": ["Agent Dashboard · No agents yet", "An invitation: the button below starts one."],
  "views/worktrees/worktrees-view.tsx#lighthouse": ["Worktrees · No worktrees match", "You searched and the beam found nothing. Clear filters sits right under it."],
  "views/worktrees/worktrees-view.tsx#ended": ["Worktrees · No worktrees yet", "Worktrees are berths; none yet is an empty one."],
  "views/review/review-view.tsx#calm": ["Review · Nothing to review", "Nothing needs you, and the scene says so without a checkmark."],
  "views/automations/flows/runs-tab.tsx#chart": ["Automations · Runs · No runs yet", "The course exists; nobody has sailed it."],
  "views/automations/flows/flow-list.tsx#chart": ["Automations · Flows · No flows yet", "A flow is a course plotted ahead. Sits above the starter templates, smaller.", "Needs a box with no flows; &fresh=1 has no boxes at all."],
  "views/onboarding/onboarding-view.tsx#dawn": ["Onboarding · Welcome", "A first run is a harbour before anyone arrives."],
  "views/onboarding/onboarding-view.tsx#arriving": ["Onboarding · Add a box", "A boat coming in to an empty berth while the box is on its way.", "Shows until berthd answers; the demo's &fresh=1 starts here."],
  "views/onboarding/onboarding-view.tsx#lighthouse": ["Onboarding · Add a box · pairing", "Looking for the box while it pairs.", "Only while a real box pairs."],
  "views/onboarding/onboarding-view.tsx#signal": ["Onboarding · Add a box · over Tailscale", "A lamp across the water: the box is on another network.", "Only when the Tailscale option is chosen."],
  "views/onboarding/onboarding-view.tsx#moored": ["Onboarding · Box paired", "The box is in, tied up and ready."],
  "views/onboarding/onboarding-view.tsx#first-crate": ["Onboarding · Add a project", "The first crate set down on an empty quay: the first thing on the box."],
  "views/onboarding/onboarding-view.tsx#setting-out": ["Onboarding · Start your first agent", "The last step sends the first boat out."],
};

const NUMBERS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// load bundles scenes.tsx with the app's own esbuild and React, and imports it.
async function load() {
  const require = createRequire(join(app, "package.json"));
  if (!existsSync(join(app, "node_modules"))) throw new Error("app/node_modules is missing: run `pnpm -C app install` first");
  const esbuild = require("esbuild");
  const dir = mkdtempSync(join(tmpdir(), "berth-scenes-"));
  const out = join(dir, "scenes.mjs");
  try {
    await esbuild.build({
      stdin: {
        contents: `export { Scene, SCENES } from "@/components/art/scenes";\nexport { createElement } from "react";\nexport { renderToStaticMarkup } from "react-dom/server";`,
        resolveDir: src,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      jsx: "automatic",
      alias: { "@": src },
      loader: { ".css": "empty" },
      outfile: out,
      logLevel: "error",
      banner: { js: `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(join(app, "package.json"))});` },
    });
    return await import(pathToFileURL(out).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.tsx$/.test(e.name)) files.push(p);
  }
  return files;
}

// placements finds every <Scene name=…> in app/src outside scenes.tsx.
function placements(names) {
  const found = [];
  for (const file of walk(src)) {
    const rel = relative(src, file);
    if (rel === join("components", "art", "scenes.tsx")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/<Scene\b([^>]*?)\/?>/g)) {
      const attrs = m[1];
      const line = text.slice(0, m.index).split("\n").length;
      const lit = attrs.match(/\bname="([^"]+)"/);
      const expr = attrs.match(/\bname=\{([^}]*)\}/);
      const width = Number(attrs.match(/\bwidth=\{(\d+)\}/)?.[1] ?? 136);
      let list = lit ? [lit[1]] : expr ? [...expr[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
      // name={copy.scene}: the names are set elsewhere in the file, as scene: "dock".
      const prop = expr && !list.length ? expr[1].trim().match(/([A-Za-z_$][\w$]*)$/)?.[1] : undefined;
      if (prop) list = [...new Set([...text.matchAll(new RegExp(`\\b${prop}\\s*:\\s*"([a-z-]+)"`, "g"))].map((x) => x[1]).filter((n) => names.includes(n)))];
      // name={scene} from a helper that returns them: every scene the file names in quotes.
      if (prop && !list.length) list = [...new Set([...text.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]).filter((n) => names.includes(n)))];
      if (!list.length) throw new Error(`${rel}:${line}: can't tell which scene <Scene${attrs}> draws`);
      for (const name of list) {
        if (!names.includes(name)) throw new Error(`${rel}:${line}: unknown scene "${name}"`);
        found.push({ file: rel.split("\\").join("/"), line, name, width });
      }
    }
  }
  return found;
}

function replaceBetween(html, key, body) {
  const re = new RegExp(`(<!-- generated:${key} -->)[\\s\\S]*?(<!-- /generated:${key} -->)`);
  if (!re.test(html)) throw new Error(`index.html has no <!-- generated:${key} --> block`);
  return html.replace(re, (_, a, b) => `${a}${body}${b}`);
}

async function main() {
  const { Scene, SCENES, createElement, renderToStaticMarkup } = await load();
  const names = [...SCENES];
  // Each render starts React's ids over, so give every drawing its own.
  let n = 0;
  const render = (name, width, still, extra = "") => {
    let svg = renderToStaticMarkup(createElement(Scene, { name, width, still }));
    const id = svg.match(/\bid="([A-Za-z0-9]+)-/)?.[1];
    if (id) svg = svg.split(`${id}-`).join(`s${n++}-`);
    if (extra) svg = svg.replace(/^<svg/, `<svg${extra}`);
    return svg;
  };

  for (const n of names) if (!SCENE_COPY[n]) throw new Error(`scene "${n}" has no gallery copy: add it to SCENE_COPY in build-scenes.mjs`);
  for (const n of Object.keys(SCENE_COPY)) if (!names.includes(n)) throw new Error(`SCENE_COPY has "${n}", which scenes.tsx no longer draws`);

  const places = placements(names);
  const seen = new Set();
  for (const p of places) {
    const key = `${p.file}#${p.name}`;
    if (!PLACES[key]) throw new Error(`${p.file}:${p.line} places "${p.name}", which the board doesn't describe: add "${key}" to PLACES in build-scenes.mjs`);
    seen.add(key);
  }
  const stale = Object.keys(PLACES).filter((k) => !seen.has(k));
  if (stale.length) console.warn(`note: PLACES describes placements the app doesn't have (left off the board): ${stale.join(", ")}`);

  let html = readFileSync(board, "utf8");

  // Gallery: one card per scene, then the still frame and how to use one.
  const cards = names.map((n) => {
    const [title, line, motion] = SCENE_COPY[n];
    return `<article class="card"><div class="art">${render(n, 208)}</div><h3>${n}</h3><p><strong>${esc(title)}</strong> ${esc(line)}</p><span class="motion">${esc(motion)}</span></article>`;
  });
  cards.push(`<article class="card"><div class="art">${render("ended", 208, true)}</div><h3>still <span class="note">reduced motion</span></h3><p>Under reduced motion, or with <code>still</code>, every scene holds its first frame. It reads the same without movement.</p><span class="motion">no animation</span></article>`);
  cards.push(`<article class="card"><h3>using a scene</h3><pre>&lt;EmptyMedia&gt;\n  &lt;Scene name="calm" /&gt;\n&lt;/EmptyMedia&gt;</pre><p>Default 136px wide. Pass <code>width</code> (96–152) and <code>still</code> for tight spots. Colour comes from the surrounding text and the theme's amber.</p><span class="motion">app/src/components/art/scenes.tsx</span></article>`);
  html = replaceBetween(html, "gallery", `\n      ${cards.join("\n      ")}\n      `);
  html = replaceBetween(html, "count", NUMBERS[names.length] ?? String(names.length));

  // Map: one row per placement, in the order of SCENES, then unplaced scenes.
  const order = (x) => names.indexOf(x.name);
  const rows = [...places]
    .sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file) || a.line - b.line)
    .map((p) => {
      const [screen, why, away] = PLACES[`${p.file}#${p.name}`];
      const demo = away ? `<span class="f away">Not in demo mode. ${esc(away)}</span>` : "";
      return `<tr><td class="sc">${render(p.name, 120, true)}<code>${p.name}</code></td><td><span class="lbl">Screen</span>${esc(screen)}<span class="f">${p.file}:${p.line}${p.width !== 136 ? ` · ${p.width}px` : ""}</span></td><td class="muted"><span class="lbl">Why this one</span>${esc(why)}${demo}</td></tr>`;
    });
  for (const n of names.filter((n) => !places.some((p) => p.name === n)))
    rows.push(`<tr><td class="sc">${render(n, 120, true)}<code>${n}</code></td><td><span class="lbl">Screen</span>Not placed<span class="f">no &lt;Scene name="${n}"&gt; in app/src</span></td><td class="muted"><span class="lbl">Why this one</span>Drawn and ready; no screen uses it today.</td></tr>`);
  html = replaceBetween(html, "map", `\n          ${rows.join("\n          ")}\n          `);
  html = replaceBetween(html, "places", String(places.length));

  // Every other scene on the board (hero, anatomy, directions): redrawn at
  // its own size, still or not, keeping where it is placed.
  html = html.replace(/<svg\b([^>]*\bdata-scene="([a-z-]+)"[^>]*)>[\s\S]*?<\/svg>/g, (whole, attrs, name) => {
    if (!names.includes(name)) throw new Error(`the board draws "${name}", which scenes.tsx no longer has`);
    const width = Number(attrs.match(/\bwidth="([\d.]+)"/)?.[1] ?? 136);
    const still = /\bdata-still="true"/.test(attrs);
    const extra = ["x", "y"].map((k) => attrs.match(new RegExp(`\\s${k}="[^"]*"`))?.[0] ?? "").join("");
    return render(name, width, still, extra);
  });

  // Scene styles, as the app has them.
  const css = readFileSync(join(src, "components", "art", "scenes.css"), "utf8").trim();
  html = html.replace(/(\/\* generated:scenes-css \*\/)[\s\S]*?(\/\* \/generated:scenes-css \*\/)/, (_, a, b) => `${a}\n${css}\n${b}`);

  const before = readFileSync(board, "utf8");
  if (check) {
    if (before !== html) {
      console.error("design/brand/index.html is out of date: run node design/brand/build-scenes.mjs");
      process.exit(1);
    }
    console.log("design/brand/index.html is up to date");
    return;
  }
  writeFileSync(board, html);
  console.log(`${names.length} scenes, ${places.length} placements${before === html ? " (no change)" : ""}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
