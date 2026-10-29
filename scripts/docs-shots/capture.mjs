#!/usr/bin/env node
// capture.mjs takes the docs' screenshots (docs.berthd.app) from the app in
// mock mode: Vite on app/ (plain dev, made-up boxes and agents with
// ?mock=1&shots=1), staged by clicking through the real UI in headless
// Chromium at 2x, in Terminal Light and Terminal Dark. It writes
//
//   docs-site/public/shots/<scene>-<light|dark>.webp   the pictures
//   docs-site/lib/shots.json                           each scene's size in CSS px
//
// and the docs' <Shot name="<scene>" /> reads the size from shots.json, so the
// page saves the picture's room before it loads. Vite is stopped when it
// finishes, fails or is interrupted. A console error in the app fails the run.
//
//   node scripts/docs-shots/capture.mjs                    every scene, both themes
//   node scripts/docs-shots/capture.mjs --only themes,chat-question
//   node scripts/docs-shots/capture.mjs --theme dark       one theme
//   node scripts/docs-shots/capture.mjs --png /tmp/shots   also keep the 2x PNGs
//   node scripts/docs-shots/capture.mjs --url http://127.0.0.1:1438/
//                                                         an app already served
//                                                         in dev mode; no Vite
//   node scripts/docs-shots/capture.mjs --list             the scenes, and stop
//
// Other flags: --port N (Vite's, default 1438), --quality 0.82 (WebP),
// --max-width 2000 (px; wider shots are scaled down), --skip-plugins (don't
// rebuild the built-in plugins first).
//
// It needs `pnpm -C app install` and playwright-core 1.57 or newer:
//
//   npm install --prefix scripts/docs-shots --no-save playwright-core
//
// or point PLAYWRIGHT_CORE at a playwright-core folder (or its index.mjs).
// It runs Playwright's own Chromium when installed (`npx playwright-core
// install chromium`), else Google Chrome; CHROME_CHANNEL=chrome picks Chrome.
//
// The app never talks to a real agent in mock mode. Requests to the laptop
// agent's ports (1377–1379), such as a worktree's dev server page, never
// leave the browser: a page is drawn in place (the live demo's drawing) and
// everything else is refused.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const appDir = join(root, "app");
const outDir = join(root, "docs-site", "public", "shots");
const manifest = join(root, "docs-site", "lib", "shots.json");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const only = flag("only")?.split(",");
const themes = (flag("theme") ?? "light,dark").split(",");
const port = Number(flag("port", "1438"));
const quality = Number(flag("quality", "0.82"));
const maxWidth = Number(flag("max-width", "2000"));
const pngDir = flag("png");
const served = flag("url");
const appUrl = (served ?? `http://127.0.0.1:${port}/`).replace(/\/?$/, "/");
// Made-up data, without the "made-up data" badge; agents open as
// conversations, as Labs has them by default.
const start = `${appUrl}?mock=1&shots=1&view=conversation`;

// Nothing to do with the scene: the loop card the fixtures keep running and
// toasts from their scripted activity (an agent on gpu finishing, Codex
// stopping to ask). The crew card in the same corner stays.
const QUIET = "[role=region][aria-label=Loops] > :not([aria-label=Crew]), [data-slot=toast-viewport], [data-slot=toast-viewport-anchored] { display: none !important; }";

// A scene opens the app, stages one screen and returns the area to keep, in
// CSS pixels. prefs and ui seed what the app keeps in localStorage
// (berth.prefs, berth.ui) before it starts. Each scene × theme starts afresh.
const scenes = [
  {
    // Settings → Appearance → Theme: Terminal's four, then the VS Code ports.
    name: "themes",
    page: "/guides/themes",
    viewport: { width: 1180, height: 1100 },
    async stage(s) {
      await s.settings("Appearance");
      await s.page.getByText("Match system", { exact: true }).waitFor();
      // Down to the end of the second row of dark themes (Tokyo Night, Nord…).
      const clip = await s.around(s.page.getByText("Theme", { exact: true }).first(), { left: 20, top: 20, height: 2000, width: 680 });
      const row = await s.box(s.page.getByText("Nord", { exact: true }).first());
      return { ...clip, height: Math.round(row.y + row.height + 18 - clip.y) };
    },
  },
  {
    // Settings → Appearance → Chat background, the harbour scene picked.
    name: "chat-background",
    page: "/guides/themes#chat-background",
    viewport: { width: 1180, height: 900 },
    async stage(s) {
      await s.settings("Appearance");
      await s.page.getByRole("button", { name: "Harbour", exact: true }).click();
      await s.wait(600);
      const head = s.page.getByText("Chat background", { exact: true }).first();
      // To the top of the settings' scroll, clear of their sticky header.
      await head.evaluate((el) => {
        el.scrollIntoView({ block: "start" });
        let p = el.parentElement;
        while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement;
        if (p) p.scrollTop -= 40;
      });
      await s.page.mouse.move(5, 5);
      await s.wait(800);
      return s.around(head, { left: 20, top: 16, height: 576, width: 680 });
    },
  },
  {
    // A conversation where Claude asks two questions with its own form, over
    // the chart contours background.
    name: "chat-question",
    page: "/guides/labs#conversation-view",
    viewport: { width: 1180, height: 820 },
    prefs: { chatBackground: { source: "builtin", builtin: "contours", strength: 0.45 } },
    async stage(s) {
      await s.capabilities(["answer"]);
      await s.openWorktree("checkout-fix");
      await s.page.getByText("Claude wants to run", { exact: true }).waitFor();
      // The fixture waits on a permission; this agent asks its questions.
      await s.app(async (key) => {
        const { useConversations } = await import("/src/lib/conversation-store.ts");
        const items = useConversations.getState().items[key].filter((i) => i.kind !== "ask" && !(i.kind === "edit" && /retry\.go|createOrder/.test(i.file)));
        items.push({ kind: "text", id: "docs-said", text: "The fix needs a key that stays the same when the provider retries. Two choices before I write the migration:" });
        items.push({
          kind: "question",
          id: "docs-question",
          tool: "toolu_docs_question",
          questions: [
            {
              header: "Key",
              question: "Where should the idempotency key come from?",
              options: [
                { label: "The provider's event ID", description: "Stripe sends the same evt_ id on every retry" },
                { label: "A hash of the payload", description: "Works for providers without event IDs" },
                { label: "Our own key on the payment", description: "Made when checkout starts, stored with the payment" },
              ],
            },
            {
              header: "Retries",
              question: "How should a failed webhook be retried?",
              options: [{ label: "5 tries over 10 minutes" }, { label: "Back off for up to an hour" }, { label: "Leave it to the provider" }],
            },
          ],
        });
        useConversations.setState((st) => ({ items: { ...st.items, [key]: items } }));
      }, "devl/checkout-fix-claude");
      await s.page.getByText("Where should the idempotency key come from?").waitFor();
      await s.page.getByText("The provider's event ID", { exact: true }).click();
      await s.foldTasks();
      await s.page.mouse.move(5, 400);
      await s.wait(800);
      const said = await s.box(s.page.getByText(/^The fix needs a key/).first());
      return s.column({ pad: 64, bottomOf: "[aria-label^='Background work'], [aria-label$='of context used']", top: Math.max(42, said.y - 18) });
    },
  },
  {
    // A finished conversation's artifacts: cards where they were published,
    // and the reply box's list of them.
    name: "chat-artifacts",
    page: "/guides/labs#conversation-view",
    viewport: { width: 1180, height: 820 },
    async stage(s) {
      await s.openWorktree("search-perf");
      const chip = s.page.getByRole("button", { name: /^\d+ artifacts? .* published/ }).first();
      await chip.waitFor();
      await s.dismissTasks();
      await chip.click();
      await s.wait(900);
      return s.column({ pad: 64, bottomOf: "[aria-label$='of context used']", topPad: 0 });
    },
  },
  {
    // Two worktrees' tabs in one strip, and a tab with a pane of each.
    name: "tab-groups",
    page: "/guides/labs#worktrees-side-by-side",
    // At least 1100px: narrower, the group not in front folds to its label
    // and the panes' chips to dots.
    viewport: { width: 1180, height: 800 },
    async stage(s) {
      await s.openWorktree("checkout-fix");
      await s.page.getByText("search-perf", { exact: true }).first().click({ modifiers: ["Alt"] });
      await s.wait(1500);
      await s.dismissTasks();
      // Drag checkout-fix's Next.js tab onto the bottom edge of search-perf's
      // pane: one tab, a pane of each worktree, stacked.
      const tab = await s.box(s.page.getByText("Next.js", { exact: true }).first());
      await s.page.mouse.move(tab.x + 10, tab.y + tab.height / 2);
      await s.page.mouse.down();
      await s.page.mouse.move(tab.x + 40, tab.y + 30, { steps: 5 });
      await s.page.mouse.move(700, Math.round(s.viewport.height * 0.85), { steps: 10 });
      await s.page.mouse.move(700, Math.round(s.viewport.height * 0.96), { steps: 10 });
      await s.wait(300);
      await s.page.mouse.up();
      await s.page.getByText("Service", { exact: true }).first().waitFor();
      await s.wait(2000);
      // Off the panes, so their headers show no hover controls.
      await s.page.mouse.move(120, s.viewport.height - 60);
      // From the sidebar's edge to the end of the breadcrumb's name, so the
      // shot reads at the docs' column width: the conversation's column ends
      // inside it, and the panes' controls are just outside.
      const crumb = await s.box(s.page.getByText("shop / checkout-fix", { exact: true }).first());
      return { x: 240, y: 0, width: Math.round(crumb.x + crumb.width + 4 - 240), height: s.viewport.height - 26 };
    },
  },
  {
    // Kits: the kits this laptop has, and where each is applied.
    name: "kits",
    page: "/guides/kits",
    // Narrow enough that the kits stack, so the shot reads at the column's width.
    viewport: { width: 900, height: 800 },
    async stage(s) {
      await s.page.getByText("More", { exact: true }).first().click();
      await s.page.getByRole("menuitem", { name: "Kits" }).click();
      await s.page.getByText("Shop development", { exact: true }).waitFor();
      await s.wait(800);
      const card = (name) => s.box(s.page.getByText(name, { exact: true }).locator("xpath=ancestor::*[contains(@class,'rounded')][1]"));
      const bottom = Math.max(...(await Promise.all(["Shop development", "Node app"].map(card))).map((b) => b.y + b.height));
      return { x: 240, y: 0, width: s.viewport.width - 240, height: Math.round(bottom + 28) };
    },
  },
  {
    // A service with "terminal": true runs in a tab of its own (Next.js),
    // here beside the page it serves.
    name: "service-terminal",
    page: "/guides/kits",
    viewport: { width: 1000, height: 520 },
    async stage(s) {
      await s.openWorktree("checkout-fix");
      await s.hideSidebar();
      await s.page.getByText("Next.js", { exact: true }).first().click();
      await s.wait(1200);
      // The web service's button opens its page beside the terminal.
      await s.page.getByRole("button", { name: "web", exact: true }).first().click();
      await s.wait(2500);
      await s.page.mouse.move(300, 300);
      return { x: RAIL, y: 0, width: s.viewport.width - RAIL, height: s.viewport.height - 26 };
    },
  },
  {
    // A browser pane watching the agent's own browser on the box.
    name: "agent-browser",
    page: "/guides/agent-browser#watching-it",
    viewport: { width: 840, height: 600 },
    async stage(s) {
      await s.openWorktree("checkout-fix");
      await s.hideSidebar();
      await s.page.keyboard.press("Meta+Shift+b");
      await s.page.getByRole("button", { name: "Agent's view · live" }).click();
      await s.wait(2600);
      await s.page.mouse.move(500, 300);
      // From the pane's bar down: the tab strip scrolls at this width.
      return { x: RAIL, y: 40, width: s.viewport.width - RAIL, height: s.viewport.height - 66 };
    },
  },
  {
    // The card for an agent's browser that Ubuntu's sandbox setting stops,
    // in the worktree's browser pane on gpu.
    name: "browser-sandbox",
    page: "/guides/agent-browser#when-ubuntu-blocks-it",
    viewport: { width: 840, height: 600 },
    async stage(s) {
      // The fixtures' boxes have nothing blocked; gpu says so, as an Ubuntu
      // 24.04 box would (GET /v1/browser/health).
      await s.capabilities(["browser.health"], {
        gpu: { "GET browser/health": { state: "sandbox", userns: "1", no_sandbox: false, setting: { no_sandbox: false }, error: "No usable sandbox!", text: "Chromium can't start its sandbox" } },
      });
      await s.openWorktree("ci-flake");
      await s.hideSidebar();
      await s.page.keyboard.press("Meta+Shift+b");
      await s.wait(800);
      await s.app(async () => (await import("/src/components/browser-sandbox.tsx")).refreshSandbox("gpu"));
      await s.page.getByRole("button", { name: "Agent's browser blocked" }).click();
      await s.wait(900);
      await s.page.mouse.move(500, 500);
      const card = await s.box(s.page.locator("[data-sandbox-card]").first());
      return { x: RAIL, y: 0, width: s.viewport.width - RAIL, height: Math.round(card.y + card.height + 40) };
    },
  },
];

// The sidebar's rail of icons, when the sidebar is hidden (CSS px).
const RAIL = 76;

// The helpers a scene stages with.
function helpers(page, viewport) {
  const wait = (ms) => page.waitForTimeout(ms);
  const s = {
    page,
    viewport,
    wait,
    full: () => ({ x: 0, y: 0, ...viewport }),
    // app runs a function in the page, where the app's own modules import
    // by their path under app/ (Vite serves them, the same instances).
    app: (fn, arg) => page.evaluate(fn, arg),
    async box(locator) {
      const b = await locator.boundingBox();
      if (!b) throw new Error(`not on screen: ${locator}`);
      return b;
    },
    // around clips from an element's top left, padded, to a fixed size.
    async around(locator, { left = 0, top = 0, width, height }) {
      const b = await s.box(locator);
      return { x: Math.max(0, Math.round(b.x - left)), y: Math.max(0, Math.round(b.y - top)), width, height: Math.min(height, viewport.height - Math.max(0, Math.round(b.y - top))) };
    },
    // column clips the chat's column with some page either side, from below
    // the tab strip to just under the reply box's controls.
    async column({ pad = 64, bottomOf, topPad = 0, top }) {
      // The reply box: a terminal's own hidden textarea has no placeholder.
      const reply = await s.box(page.locator("textarea[placeholder]:visible").last());
      const under = bottomOf ? await page.locator(bottomOf).last().boundingBox() : null;
      const x = Math.max(0, Math.round(reply.x - pad));
      const right = Math.min(viewport.width, Math.round(reply.x + reply.width + pad));
      const bottom = Math.min(viewport.height - 26, Math.round((under ? under.y + under.height : reply.y + reply.height) + 16));
      const y = Math.round(top ?? 40 + topPad);
      return { x, y, width: right - x, height: bottom - y };
    },
    async settings(section) {
      await page.getByText("Settings", { exact: true }).last().click();
      // The section list is icons only in a narrower window; each is labelled.
      await page.locator(`[aria-label="${section}"]`).or(page.getByText(section, { exact: true })).first().click();
      await wait(1200);
    },
    // hideSidebar folds the sidebar to its rail of icons; RAIL is its width,
    // left out of a shot that starts at the pane.
    async hideSidebar() {
      await page.getByRole("button", { name: "Hide the sidebar" }).click();
      await wait(500);
    },
    async openWorktree(name) {
      await page.getByText(name, { exact: true }).first().click();
      await wait(2000);
    },
    async foldTasks() {
      const open = page.locator("section[aria-label=Tasks] button[aria-expanded=true]");
      if (await open.count()) await open.first().click();
      await wait(300);
    },
    async dismissTasks() {
      const away = page.getByRole("button", { name: "Put the task list away" });
      if (await away.count()) await away.first().click();
      await wait(300);
    },
    // capabilities gives the fixtures' boxes what a newer berthd has, and
    // answers for the requests in `answers` ({box: {"GET path": value}}).
    async capabilities(caps, answers = {}) {
      await page.evaluate(
        async ({ caps, answers }) => {
          const { useStore } = await import("/src/lib/store.ts");
          const c = useStore.getState().client;
          const box = c.box;
          c.box = async (name, method, path, ...rest) => {
            const a = answers[name]?.[`${method} ${path}`];
            if (a !== undefined) return structuredClone(a);
            const r = await box(name, method, path, ...rest);
            if (r && Array.isArray(r.capabilities)) r.capabilities = [...new Set([...r.capabilities, ...caps])];
            return r;
          };
          await useStore.getState().refreshAll();
        },
        { caps, answers },
      );
    },
  };
  return s;
}

async function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) {
    const p = process.env.PLAYWRIGHT_CORE;
    tries.push(existsSync(p) && statSync(p).isDirectory() ? join(p, "index.mjs") : p);
  }
  tries.push(join(import.meta.dirname, "node_modules", "playwright-core", "index.mjs"));
  tries.push(join(root, "site", "scripts", "node_modules", "playwright-core", "index.mjs"));
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
    throw new Error("playwright-core not found. Run `npm install --prefix scripts/docs-shots --no-save playwright-core`, or set PLAYWRIGHT_CORE to its folder.");
  }
}

async function launch(chromium) {
  if (process.env.CHROME_CHANNEL) return chromium.launch({ channel: process.env.CHROME_CHANNEL, headless: true });
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

function startVite() {
  if (!args.includes("--skip-plugins")) {
    const r = spawnSync(process.execPath, [join(appDir, "scripts", "build-plugins.mjs")], { cwd: appDir, stdio: "inherit" });
    if (r.status !== 0) throw new Error("building the built-in plugins failed");
  }
  const vite = join(appDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw new Error("app/node_modules is missing: run `pnpm -C app install` first");
  const child = spawn(process.execPath, [vite, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: appDir, stdio: ["ignore", "pipe", "pipe"], detached: true });
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
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (vite.child.exitCode !== null) throw new Error(`Vite exited:\n${vite.log()}`);
    try {
      const r = await fetch(appUrl);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite did not answer on port ${port}:\n${vite.log()}`);
}

// encode turns a 2x PNG of the clip into a WebP at most maxWidth wide, in
// the browser.
async function encode(page, png, width) {
  return page.evaluate(
    async ({ b64, width, quality }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const w = Math.min(img.width, width);
      const h = Math.round((img.height * w) / img.width);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      return { w, h, data: c.toDataURL("image/webp", quality).split(",")[1] };
    },
    { b64: png.toString("base64"), width, quality },
  );
}

// The live demo's drawing of a worktree's dev server, for pages a browser
// pane opens (app/src/demo/dev-server.ts), read once from the app.
let devServerPage;

async function main() {
  if (args.includes("--list")) {
    for (const s of scenes) console.log(`${s.name.padEnd(18)} ${s.page}`);
    return;
  }
  const unknown = only?.filter((n) => !scenes.some((s) => s.name === n));
  if (unknown?.length) throw new Error(`no scene named ${unknown.join(", ")} (--list shows them)`);
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

  const sizes = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  let failed = 0;
  let browser;
  try {
    if (vite) await waitForServer(vite);
    browser = await launch(chromium);
    const encoder = await browser.newPage();
    for (const scene of scenes) {
      if (only && !only.includes(scene.name)) continue;
      for (const theme of themes) {
        const viewport = scene.viewport;
        const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: theme === "light" ? "light" : "dark", reducedMotion: "reduce" });
        // The laptop agent's ports: a page there is drawn in place, the rest
        // refused. Nothing reaches a real agent.
        await ctx.route(/^https?:\/\/[^/]*:(1377|1378|1379)(\/|$)/, (route) => {
          const r = route.request();
          if (devServerPage && r.resourceType() === "document") return route.fulfill({ status: 200, contentType: "text/html", body: devServerPage(r.url()) });
          return route.abort();
        });
        // Terminal Light or Terminal Dark, and the scene's own settings, before the
        // app reads them.
        await ctx.addInitScript(
          ({ origin, ui, prefs }) => {
            if (location.origin !== origin) return;
            try {
              localStorage.setItem("berth.ui", JSON.stringify(ui));
              if (prefs) localStorage.setItem("berth.prefs", JSON.stringify(prefs));
            } catch {}
          },
          { origin: new URL(appUrl).origin, ui: { themeId: `berth-${theme}` }, prefs: scene.prefs },
        );
        const page = await ctx.newPage();
        const errors = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        page.on("pageerror", (e) => errors.push(e.message));
        const s = helpers(page, viewport);
        try {
          await page.goto(start);
          await page.getByRole("button", { name: "Home" }).first().waitFor({ timeout: 20_000 });
          await s.wait(1500);
          if (!devServerPage) {
            const html = await page.evaluate(async () => (await import("/src/demo/dev-server.ts")).demoDevServer("http://3001.x/"));
            devServerPage = (url) => html.replaceAll("localhost:3001", `localhost:${/^https?:\/\/(\d+)\./.exec(url)?.[1] ?? "3001"}`);
          }
          await page.addStyleTag({ content: QUIET });
          const clip = await scene.stage(s);
          await s.wait(1000);
          const png = await page.screenshot({ clip });
          if (pngDir) writeFileSync(join(pngDir, `${scene.name}-${theme}.png`), png);
          const r = await encode(encoder, png, maxWidth);
          const file = join(outDir, `${scene.name}-${theme}.webp`);
          writeFileSync(file, Buffer.from(r.data, "base64"));
          sizes[scene.name] = { width: Math.round(clip.width), height: Math.round(clip.height) };
          console.log(`${scene.name}-${theme}.webp  ${r.w}x${r.h}  ${(statSync(file).size / 1024).toFixed(0)} KB`);
          if (errors.length) {
            failed++;
            console.error(`${scene.name} (${theme}): console errors in the app:\n  ${errors.join("\n  ")}`);
          }
        } catch (err) {
          failed++;
          console.error(`${scene.name} (${theme}) failed: ${err.message.split("\n")[0]}`);
          if (pngDir) await page.screenshot({ path: join(pngDir, `${scene.name}-${theme}-failed.png`) }).catch(() => {});
        } finally {
          await ctx.close();
        }
      }
    }
  } finally {
    await browser?.close();
    cleanup();
  }
  // Sorted, so a rerun of one scene changes one line.
  const sorted = Object.fromEntries(Object.keys(sizes).sort().map((k) => [k, sizes[k]]));
  writeFileSync(manifest, `${JSON.stringify(sorted, null, 2)}\n`);
  if (failed) {
    console.error(`${failed} scene(s) failed or logged errors`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
