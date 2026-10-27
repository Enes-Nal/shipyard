#!/usr/bin/env node
// capture.mjs takes the landing page's screenshots from the live demo (Vite
// on app/ in demo mode, ?shots=1, which leaves out the demo's guide, badge
// and script; Labs on): the harbour home, a conversation, the dashboard and
// zen, in headless Chrome at 2x in Terminal Dark and Terminal Light. It writes
// WebPs into site/assets/shots/: <scene>-<dark|light>-<width>.webp at the
// scene's widths. Vite is stopped when it finishes, fails or is interrupted.
//
//   node site/scripts/capture.mjs                     both themes
//   node site/scripts/capture.mjs --theme dark        one theme
//   node site/scripts/capture.mjs --png /tmp/shots    also keep the 2x PNGs
//   node site/scripts/capture.mjs --phone-only        only re-cut the phone crop
//                                                     from the WebPs already there
//
// A scene with a `phone` area also gets a crop for phones, shown below 640px
// wide: <scene>-<theme>-phone-<width>.webp, at the area's 1x and 2x widths.
// The area is in CSS pixels from the top left of the scene's clip, so it can
// be re-cut from the saved 2x WebP without starting the app (--phone-only).
//
// Other flags: --only, --port N (default 1456), --quality 0.8, --skip-plugins.
// It needs Google Chrome and playwright-core; see site/README.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const appDir = join(root, "app");
const outDir = join(root, "site", "assets", "shots");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only")?.split(",");
const themes = (flag("theme") ?? "dark,light").split(",");
const port = Number(flag("port", "1456"));
const quality = Number(flag("quality", "0.8"));
const pngDir = flag("png");
// Labs on (the harbour home, conversations); light by day in the light theme.
// --url takes the shots from a demo already served (the built site/demo/,
// say) instead of starting Vite; only the scenes that click their way in
// work there (pane-terminal, pane-conversation, attempts, review).
const served = flag("url");
const base = `${served ?? `http://localhost:${port}/`}?shots=1&labs=1&view=conversation`;

// A scene opens the demo, stages one screen and returns the area to keep,
// in CSS pixels. Widths are the WebP widths written; the default is the
// clip's width and twice it. A scene whose widths are set also says its
// clip's width (clipWidth), for --phone-only.
const scenes = [
  {
    // Labs' harbour home: the dithered harbour, the composer and the agents.
    name: "home",
    viewport: { width: 1440, height: 900 },
    widths: [720, 1280, 2080],
    clipWidth: 1440,
    // The heading, the composer and the top of the agents list.
    phone: { x: 520, y: 330, width: 640, height: 480 },
    async stage(s) {
      await s.view({ kind: "workspace" });
      await s.wait(1500);
      return s.full();
    },
  },
  {
    // An agent's conversation, a few seconds into a turn.
    name: "conversation",
    viewport: { width: 1440, height: 900 },
    widths: [720, 1280, 2080],
    clipWidth: 1440,
    // The transcript, down to the question.
    phone: { x: 296, y: 44, width: 720, height: 480 },
    async stage(s) {
      await s.view({ kind: "workspace" });
      await s.wait(800);
      await s.page.locator("textarea").first().fill("Make payment webhook retries safe to repeat");
      await s.page.keyboard.press("Enter");
      await s.wait(10500);
      await s.page.mouse.move(1430, 300);
      return s.full();
    },
  },
  {
    // The Agent Dashboard: every agent by what it needs.
    name: "dashboard",
    viewport: { width: 1440, height: 900 },
    widths: [720, 1280, 2080],
    clipWidth: 1440,
    // Needs you and working.
    phone: { x: 250, y: 50, width: 600, height: 450 },
    async stage(s) {
      await s.view({ kind: "dashboard" });
      await s.page.mouse.move(1430, 450);
      await s.wait(1200);
      return s.full();
    },
  },
  {
    // Zen: the switcher open over an agent's conversation.
    name: "zen",
    query: "&zen=1",
    viewport: { width: 1440, height: 900 },
    widths: [720, 1280, 2080],
    clipWidth: 1440,
    // The switcher.
    phone: { x: 0, y: 0, width: 560, height: 420 },
    async stage(s) {
      await s.view({ kind: "workspace" });
      await s.wait(800);
      await s.page.locator("textarea").first().fill("Make payment webhook retries safe to repeat");
      await s.page.keyboard.press("Enter");
      await s.wait(4000);
      await s.page.locator('[aria-label="Switch agent or worktree"]').click();
      await s.wait(600);
      return s.full();
    },
  },
  {
    // One agent's pane in Terminal view: checkout-fix, asking a question.
    name: "pane-terminal",
    viewport: { width: 1440, height: 900 },
    clipWidth: 800,
    phone: { x: 4, y: 40, width: 440, height: 300 },
    async stage(s) {
      await openAgent(s, 0);
      await s.page.getByRole("button", { name: "Terminal", exact: true }).first().click();
      await s.wait(2000);
      return { x: 240, y: 0, width: 800, height: 400 };
    },
  },
  {
    // The same agent's pane in Conversation view.
    name: "pane-conversation",
    viewport: { width: 1440, height: 900 },
    // Phones get pane-conversation-narrow instead.
    async stage(s) {
      await openAgent(s, 0);
      await s.page.getByRole("button", { name: "Conversation", exact: true }).first().click();
      await s.wait(2000);
      return { x: 240, y: 0, width: 800, height: 400 };
    },
  },
  {
    // The conversation at a phone's width, for the page's phone layout.
    name: "pane-conversation-narrow",
    viewport: { width: 1440, height: 900 },
    async stage(s) {
      await openAgent(s, 0);
      await s.page.getByRole("button", { name: "Hide the sidebar" }).click();
      await s.page.setViewportSize({ width: 560, height: 700 });
      await s.wait(1200);
      await s.page.getByRole("button", { name: "Conversation", exact: true }).first().click();
      await s.wait(2000);
      return { x: 80, y: 40, width: 480, height: 330 };
    },
  },
  {
    // Review's Compare for a run of attempts: three agents, one task, judged.
    name: "attempts",
    viewport: { width: 1440, height: 900 },
    clipWidth: 860,
    // The judge's pick.
    phone: { x: 582, y: 0, width: 280, height: 384 },
    async stage(s) {
      await s.page.getByText("Review", { exact: true }).first().click();
      await s.wait(1500);
      await s.page.getByRole("button", { name: /refunds: 3 attempts/ }).click();
      await s.wait(2000);
      await s.page.mouse.move(1430, 880);
      return { x: 264, y: 245, width: 860, height: 384 };
    },
  },
  {
    // Review: an agent's finished work, its last message and check.
    name: "review",
    viewport: { width: 1440, height: 900 },
    clipWidth: 1200,
    phone: { x: 336, y: 52, width: 466, height: 250 },
    async stage(s) {
      await s.page.getByText("Review", { exact: true }).first().click();
      await s.wait(1500);
      await s.page.getByText("search-perf", { exact: true }).last().click();
      await s.wait(2000);
      await s.page.mouse.move(1430, 880);
      return { x: 240, y: 48, width: 1200, height: 364 };
    },
  },
];

// openAgent opens the nth agent on the Agent Dashboard (0: checkout-fix).
async function openAgent(s, n) {
  if (await s.page.getByText("Agent Dashboard", { exact: true }).count()) await s.page.getByText("Agent Dashboard", { exact: true }).first().click();
  await s.wait(1200);
  await s.page.getByRole("button", { name: "Open", exact: true }).nth(n).click();
  await s.wait(2500);
}

async function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) {
    const p = process.env.PLAYWRIGHT_CORE;
    tries.push(statSync(p).isDirectory() ? join(p, "index.mjs") : p);
  }
  tries.push(join(import.meta.dirname, "node_modules", "playwright-core", "index.mjs"));
  // npx's cache, where `npx playwright-core` leaves it.
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) {
    const found = readdirSync(npx)
      .map((d) => join(npx, d, "node_modules", "playwright-core", "index.mjs"))
      .filter((f) => existsSync(f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    tries.push(...found);
  }
  for (const f of tries) if (existsSync(f)) return import(pathToFileURL(f).href);
  try {
    return await import("playwright-core");
  } catch {
    throw new Error("playwright-core not found. Run `npm install --prefix site/scripts --no-save playwright-core`, or set PLAYWRIGHT_CORE to its folder.");
  }
}

function startVite() {
  if (!args.includes("--skip-plugins")) {
    const r = spawnSync(process.execPath, [join(appDir, "scripts", "build-plugins.mjs")], { cwd: appDir, stdio: "inherit" });
    if (r.status !== 0) throw new Error("building the built-in plugins failed");
  }
  const vite = join(appDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw new Error("app/node_modules is missing: run `pnpm install` in app/ first");
  const child = spawn(process.execPath, [vite, "--mode", "demo", "--port", String(port), "--strictPort"], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log };
}

function stopVite(vite) {
  if (!vite || vite.child.exitCode !== null) return;
  try {
    process.kill(-vite.child.pid, "SIGTERM");
  } catch {
    vite.child.kill("SIGTERM");
  }
}

async function waitForServer(vite) {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (vite.child.exitCode !== null) throw new Error(`Vite exited:\n${vite.log()}`);
    try {
      const r = await fetch(`http://localhost:${port}/`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite did not answer on port ${port}:\n${vite.log()}`);
}

// encode turns one 2x PNG into WebPs at the given widths, in the browser.
// The source is a 2x image of the clip; `area` (CSS pixels within the clip)
// cuts part of it, for the phone crops.
async function encode(page, image, clip, widths, area, mime = "image/png") {
  return page.evaluate(
    async ({ b64, mime, clip, widths, area, quality }) => {
      const img = new Image();
      img.src = `data:${mime};base64,${b64}`;
      await img.decode();
      const k = img.width / clip.width;
      const a = area ?? { x: 0, y: 0, width: clip.width, height: clip.height };
      return widths.map((w) => {
        const h = Math.round((a.height * w) / a.width);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, a.x * k, a.y * k, a.width * k, a.height * k, 0, 0, w, h);
        return { w, h, data: c.toDataURL("image/webp", quality).split(",")[1] };
      });
    },
    { b64: image.toString("base64"), mime, clip, widths, area, quality },
  );
}

function write(name, r) {
  const file = join(outDir, `${name}-${r.w}.webp`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`${name}-${r.w}.webp  ${r.w}x${r.h}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

// phoneOnly re-cuts every phone crop from the 2x WebP already in assets/shots.
async function phoneOnly() {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
  try {
    const page = await browser.newPage();
    for (const scene of scenes) {
      if (!scene.phone || (only && !only.includes(scene.name))) continue;
      for (const theme of themes) {
        const re = new RegExp(`^${scene.name}-${theme}-(\\d+)\\.webp$`);
        const sizes = readdirSync(outDir).map((f) => Number(f.match(re)?.[1])).filter(Boolean).sort((a, b) => b - a);
        if (!sizes.length) throw new Error(`no ${scene.name}-${theme} WebP to cut a phone crop from`);
        const big = readFileSync(join(outDir, `${scene.name}-${theme}-${sizes[0]}.webp`));
        // The clip in CSS pixels: twice the widest WebP, unless the scene
        // says (its widths are set, and the widest is under 2x).
        const dims = await page.evaluate(async (b64) => {
          const img = new Image();
          img.src = `data:image/webp;base64,${b64}`;
          await img.decode();
          return { width: img.width, height: img.height };
        }, big.toString("base64"));
        const cw = scene.clipWidth ?? dims.width / 2;
        const clip = { width: cw, height: (dims.height * cw) / dims.width };
        const p = scene.phone;
        for (const r of await encode(page, big, clip, [p.width, p.width * 2], p, "image/webp")) write(`${scene.name}-${theme}-phone`, r);
      }
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  mkdirSync(outDir, { recursive: true });
  if (pngDir) mkdirSync(pngDir, { recursive: true });
  const vite = served ? null : startVite();
  const cleanup = () => stopVite(vite);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("exit", cleanup);

  let failed = 0;
  let browser;
  try {
    if (vite) await waitForServer(vite);
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
    const encoder = await browser.newPage();
    for (const scene of scenes) {
      if (only && !only.includes(scene.name)) continue;
      for (const theme of themes) {
        const viewport = scene.viewport ?? { width: 1280, height: 800 };
        // The demo follows the system's light or dark, as the website does,
        // and starts afresh on every load: Terminal Light or Terminal Dark, compact.
        const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme === "light" ? "light" : "dark" });
        const page = await ctx.newPage();
        const errors = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("pageerror", (e) => errors.push(e.message));
        const wait = (ms) => page.waitForTimeout(ms);
        const s = {
          page,
          wait,
          view: (v) => page.evaluate((v) => window.__berthStore.getState().setView(v), v),
          full: () => ({ x: 0, y: 0, ...viewport }),
        };
        try {
          await page.goto(`${base}${theme === "light" ? "&light=day" : ""}${scene.query ?? ""}`);
          if (!served) await page.waitForFunction(() => "__berthStore" in window);
          await wait(2500);
          // The demo's fixtures keep a loop running; its card would cover
          // the shots. The crew card in the same corner stays.
          await page.addStyleTag({ content: '[role=region][aria-label=Loops] > :not([aria-label=Crew]) { display: none !important; }' });
          const clip = await scene.stage(s);
          await wait(1200);
          const png = await page.screenshot({ clip });
          if (pngDir) writeFileSync(join(pngDir, `${scene.name}-${theme}.png`), png);
          const widths = scene.widths ?? [Math.round(clip.width), Math.round(clip.width * 2)];
          for (const r of await encode(encoder, png, clip, widths)) write(`${scene.name}-${theme}`, r);
          if (scene.phone) {
            const p = scene.phone;
            for (const r of await encode(encoder, png, clip, [p.width, p.width * 2], p)) write(`${scene.name}-${theme}-phone`, r);
          }
          if (errors.length) {
            failed++;
            console.error(`${scene.name} (${theme}): console errors in the demo:\n  ${errors.join("\n  ")}`);
          }
        } catch (err) {
          failed++;
          console.error(`${scene.name} (${theme}) failed: ${err.message.split("\n")[0]}`);
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    await browser?.close();
    cleanup();
  }
  if (failed) {
    console.error(`${failed} scene(s) failed or logged errors`);
    process.exit(1);
  }
}

(args.includes("--phone-only") ? phoneOnly() : main()).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
