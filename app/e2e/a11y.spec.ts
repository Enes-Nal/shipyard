import { appendFileSync, readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";

import { scenes } from "./a11y-scenes";
import { expect, mockOnly, test } from "./fixtures";

// axe-core over the app's screens (a11y-scenes.ts), in Terminal Dark: no serious or critical violation of WCAG 2.2 A and AA, or of axe's
// best practices. The user's own page in a Browser or Preview tab is left
// out (it isn't ours), as are the terminal's canvas rows.
//
// A11Y_REPORT=file.jsonl writes every violation, minor ones too, instead of
// failing; A11Y_FULL=1 adds Terminal Light and every screen's other states
// (scenes marked extra); A11Y_THEMES=all checks the key screens' contrast in
// every built-in theme. check:themes covers each theme's contrast on every run.

const report = process.env.A11Y_REPORT;
const allThemes = process.env.A11Y_THEMES === "all";
const full = process.env.A11Y_FULL === "1";
// Reduce motion from the start, so what animates itself as it mounts (an
// artifact's bklit chart, its heatmap cells) is read at rest, not mid-fade.
test.use({ reducedMotion: "reduce" });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

async function audit(page: import("@playwright/test").Page, only?: string[]) {
  // Animations finish first, so contrast is read at rest.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(250);
  let b = new AxeBuilder({ page }).withTags(TAGS).exclude("iframe").exclude(".xterm-rows").exclude("[data-a11y-skip]");
  if (only) b = b.withRules(only);
  const r = await b.analyze();
  return r.violations;
}

// Every built-in theme's id, read from its source (the app's modules don't
// load in the spec's node).
const builtinIds = () => ["builtin.ts", "vscode.ts"].flatMap((f) => [...readFileSync(new URL(`../src/themes/${f}`, import.meta.url), "utf8").matchAll(/^\s{2,4}id: "([^"]+)",$/gm)].map((m) => m[1]));
const themes = allThemes ? builtinIds() : full ? ["berth-dark", "berth-light"] : ["berth-dark"];

for (const theme of themes) {
  for (const scene of scenes) {
    if (allThemes && !scene.key) continue;
    if (scene.extra && !full && !allThemes) continue;
    test(`${scene.id} in ${theme} has no serious accessibility problems`, async ({ app }) => {
      mockOnly();
      test.setTimeout(90_000);
      await scene.run(app, theme);
      const v = await audit(app.page, allThemes ? ["color-contrast"] : undefined);
      if (report) {
        for (const x of v) {
          appendFileSync(
            report,
            `${JSON.stringify({ scene: scene.id, theme, rule: x.id, impact: x.impact, help: x.help, nodes: x.nodes.map((n) => ({ target: n.target.join(" "), html: n.html.slice(0, 200), summary: n.failureSummary?.slice(0, 300) })) })}\n`,
          );
        }
        return;
      }
      const bad = v.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id} (${x.impact}): ${x.help}\n  ${x.nodes.map((n) => n.target.join(" ")).slice(0, 5).join("\n  ")}`);
      expect(bad, "serious or critical axe violations").toEqual([]);
    });
  }
}
