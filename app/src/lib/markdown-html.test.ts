// node --experimental-strip-types --test src/lib/markdown-html.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import katex from "katex";

import { markdownHtml, type TexRender } from "./markdown-html.ts";

// As the app draws it (components/conversation/markdown.tsx).
const tex: TexRender = (s, displayMode) => katex.renderToString(s, { displayMode, throwOnError: false });
const html = (text: string) => markdownHtml(text, tex).html;
// Each formula as [display or inline: its TeX], to see what was read as what.
const read = (text: string) => markdownHtml(text, (s, display) => `[${display ? "display" : "inline"}:${s}]`).html;

test("$$…$$ is math, a display on a line of its own", () => {
  const out = html("$$x^2$$");
  assert.match(out, /class="katex"/);
  assert.match(out, /katex-display/);
  assert.match(out, /<annotation encoding="application\/x-tex">x\^2<\/annotation>/);
  assert.equal(read("where $$x^2$$ is the area"), "<p>where <span class=\"cv-math\">[inline:x^2]</span> is the area</p>");
  assert.equal(read("$$\n\\frac{1}{2}\n$$\n\nafter"), '<div class="cv-math-block"><span class="cv-math cv-math-display">[display:\\frac{1}{2}]</span></div>\n<p>after</p>');
});

test("\\(…\\) is inline math and \\[…\\] a display", () => {
  assert.equal(read("Inline \\(a+b\\) and \\[a+b\\] too."), '<p>Inline <span class="cv-math">[inline:a+b]</span> and <span class="cv-math cv-math-display">[display:a+b]</span> too.</p>');
  assert.match(html("\\(a+b\\)"), /class="katex"/);
  assert.match(html("\\[\na+b\n\\]"), /katex-display/);
  // TeX's \\ is a line break, not the end.
  assert.equal(read("\\[a \\\\) b\\]"), '<p><span class="cv-math cv-math-display">[display:a \\\\) b]</span></p>');
  // An escaped backslash before a ( is no math.
  assert.equal(read("\\\\(not math\\\\)"), "<p>\\(not math\\)</p>");
  // One that doesn't close stays the escape it was.
  assert.equal(read("a \\(b"), "<p>a (b</p>");
});

test("a single $ is left alone", () => {
  const out = markdownHtml("It costs $5 and $10, or $$$ for both.", tex);
  assert.equal(out.html, "<p>It costs $5 and $10, or $$$ for both.</p>");
  assert.equal(out.math, false);
});

test("math in code stays as written", () => {
  assert.equal(read("`$$x$$` and `\\(a\\)`"), "<p><code>$$x$$</code> and <code>\\(a\\)</code></p>");
  assert.equal(read("```\n\\[x\\]\n$$\ny\n$$\n```"), "<pre><code>\\[x\\]\n$$\ny\n$$\n</code></pre>");
  // Nor does it reach into a link's address.
  assert.equal(read("[docs](https://example.com/a\\(b\\))"), '<p><a href="https://example.com/a(b)">docs</a></p>');
});

test("a formula KaTeX can't read shows as its source, and nothing throws", () => {
  const out = html("A \\(\\frac{1}{\\) and $$\\badcommand$$ here.");
  assert.match(out, /katex-error/);
  assert.match(out, /\\badcommand/);
  // Whatever else a renderer throws shows the source too.
  const thrown = markdownHtml("$$x$$", () => {
    throw new Error("no");
  }).html;
  assert.equal(thrown, '<p><span class="cv-math cv-math-display"><span class="cv-math-source">$$x$$</span></span></p>');
});

test("until KaTeX loads, math shows as its source", () => {
  const out = markdownHtml("Then \\(a < b\\).", undefined);
  assert.equal(out.math, true);
  assert.equal(out.html, '<p>Then <span class="cv-math"><span class="cv-math-source">\\(a &lt; b\\)</span></span>.</p>');
});

test("a $$ block that hasn't closed yet stays text", () => {
  // A draft, as the agent writes it: the rest of the reply isn't taken in.
  assert.equal(read("Area:\n\n$$\nx^2 + **y**"), "<p>Area:</p>\n<p>$$\nx^2 + <strong>y</strong></p>");
  assert.equal(read("$$\na\n$$\n\nthen\n\n$$\nb"), '<div class="cv-math-block"><span class="cv-math cv-math-display">[display:a]</span></div>\n<p>then</p>\n<p>$$\nb</p>');
  // And once it closes, it's math.
  assert.equal(read("Area:\n\n$$\nx^2\n$$"), '<p>Area:</p>\n<div class="cv-math-block"><span class="cv-math cv-math-display">[display:x^2]</span></div>');
});

test("shape sees each formula as one mark, where it goes", () => {
  // The draft's caret goes after the math, not inside KaTeX's markup.
  const out = markdownHtml("so \\(x\\)", tex, (h) => h.replace(/<\/p>$/, "|</p>")).html;
  assert.match(out, /<\/span>\|<\/p>$/);
});
