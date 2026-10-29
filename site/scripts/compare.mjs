// The Compare loop (assets/loops/compare.mp4): the app's Compare tab in mock
// mode, checkout-fix beside search-perf, its Chat, Diff and Terminal lanes in
// turn, each held 2 s and crossfaded, back to Chat so it loops without a seam.
// The app's own footage has no Compare (it landed after the film), so this
// is stills of the real UI rather than a recording.
//
//   (cd app && node node_modules/vite/bin/vite.js --port 1438 --host 127.0.0.1) &
//   node site/scripts/compare.mjs [--url http://127.0.0.1:1438/]
//   node site/scripts/posters.mjs
//
// Needs ffmpeg, Google Chrome and playwright-core (as for capture.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const site = join(import.meta.dirname, "..");
const ui = process.argv.includes("--url") ? process.argv[process.argv.indexOf("--url") + 1] : "http://127.0.0.1:1438/";
const out = join(site, "assets/loops/compare.mp4");

async function loadPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_CORE) {
    const p = process.env.PLAYWRIGHT_CORE;
    tries.push(statSync(p).isDirectory() ? join(p, "index.mjs") : p);
  }
  tries.push(join(import.meta.dirname, "node_modules", "playwright-core", "index.mjs"));
  const npx = join(homedir(), ".npm", "_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) tries.push(join(npx, d, "node_modules", "playwright-core", "index.mjs"));
  for (const f of tries) if (existsSync(f)) return import(pathToFileURL(f).href);
  return import("playwright-core");
}

const { chromium } = await loadPlaywright();
const tmp = mkdtempSync(join(tmpdir(), "compare-"));
const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome" });
try {
  // The film's footage is Terminal Dark at 1280x800, 2x; so is this.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: "dark" });
  // Nothing reaches a real laptop agent.
  await ctx.route(/^https?:\/\/[^/]*:(1377|1378|1379)(\/|$)/, (r) => r.abort());
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("berth.ui", JSON.stringify({ themeId: "berth-dark" }));
    } catch {}
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(new URL("?mock=1&shots=1&labs=1&view=conversation", ui).href);
  await page.getByRole("button", { name: "Home" }).first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.getByText("checkout-fix", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await page.keyboard.press("Meta+Alt+KeyC");
  await page.locator("[role=dialog]").getByText("shop / search-perf").first().click();
  await page.waitForTimeout(2500);
  const fold = page.getByRole("button", { name: "Fold" }).first();
  if (await fold.count()) await fold.click();
  for (const lane of ["Diff", "Terminal", "Chat"]) {
    await page.getByRole("button", { name: `${lane} lane`, exact: true }).first().click();
    await page.waitForTimeout(2200);
    await page.mouse.move(640, 790);
    await page.screenshot({ path: join(tmp, `${lane.toLowerCase()}.png`) });
  }
  if (errors.length) console.error(`The app logged errors:\n  ${errors.join("\n  ")}`);
  const still = (n) => ["-loop", "1", "-t", "2.4", "-framerate", "30", "-i", join(tmp, `${n}.png`)];
  const fit = (i, o) => `[${i}]scale=1600:1000:flags=lanczos,format=yuv420p,setsar=1[${o}]`;
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    ...still("chat"), ...still("diff"), ...still("terminal"), ...still("chat"),
    "-filter_complex",
    `${fit(0, "a")};${fit(1, "b")};${fit(2, "c")};${fit(3, "d")};` +
      "[a][b]xfade=transition=fade:duration=0.4:offset=2.0[ab];[ab][c]xfade=transition=fade:duration=0.4:offset=4.0[abc];" +
      "[abc][d]xfade=transition=fade:duration=0.4:offset=6.0,trim=0:6.4,setpts=PTS-STARTPTS[v]",
    "-map", "[v]", "-c:v", "libx264", "-preset", "slower", "-crf", "25", "-tune", "animation", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out,
  ]);
  console.log(`assets/loops/compare.mp4  ${(statSync(out).size / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
