// node --experimental-strip-types --test src/lib/preview-frames.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS, fitScale, flagged, framesOf, LABEL, MAX_FRAMES, normalizeSettings, packedHeight, PAD, parseMessage, proxied, relay, scales, sheetLayout, sortSizes, unflagged } from "./preview-frames.ts";

test("Tailwind's breakpoints are their real widths, at the chosen height; phones and tablets their own size, and turn sideways", () => {
  const s = normalizeSettings({ sizes: ["phone", "sm", "md", "lg", "xl", "2xl", "tablet", "phone-max"], rotated: ["phone", "md"], height: 800 });
  const f = framesOf(s);
  assert.deepEqual(
    f.map((x) => [x.id, x.w, x.h]),
    [
      ["phone", 844, 390],
      ["sm", 640, 800],
      ["md", 768, 800],
      ["lg", 1024, 800],
      ["xl", 1280, 800],
      ["2xl", 1536, 800],
      ["tablet", 820, 1180],
      ["phone-max", 430, 932],
    ],
  );
  // A breakpoint never turns: only devices do.
  assert.equal(f.find((x) => x.id === "md")!.rotated, false);
});

test("custom widths join the sizes, within limits, and a frame can have its own theme", () => {
  const s = normalizeSettings({ sizes: ["w500", "w99999", "lg", "nonsense", "w500"], custom: [500, 99999, "1700", 120], theme: "dark", themes: { lg: "light", sm: "auto", x: "purple" } });
  assert.deepEqual(s.custom, [500, 1700]);
  assert.deepEqual(s.sizes, ["w500", "lg"]);
  const f = framesOf(s);
  assert.deepEqual(
    f.map((x) => [x.label, x.w, x.theme]),
    [
      ["500", 500, "dark"],
      ["lg", 1024, "light"],
    ],
  );
  assert.deepEqual(s.themes, { lg: "light" });
});

test("settings saved by hand or an older version fall back to defaults piece by piece", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("junk"), DEFAULT_SETTINGS);
  const s = normalizeSettings({ layout: "grid", sync: false, strategy: "class", scroll: "anchor", height: 5, sizes: [] });
  assert.equal(s.layout, "grid");
  assert.equal(s.sync, false);
  assert.equal(s.strategy, "class");
  assert.equal(s.scroll, "anchor");
  assert.equal(s.height, DEFAULT_SETTINGS.height);
  assert.deepEqual(s.sizes, DEFAULT_SETTINGS.sizes);
  const many = normalizeSettings({ sizes: ["phone", "phone-max", "tablet", "sm", "md", "lg", "xl", "2xl", "w300", "w400", "w500"], custom: [300, 400, 500] });
  assert.equal(many.sizes.length, MAX_FRAMES);
});

test("sizes sort devices first, then by width", () => {
  assert.deepEqual(sortSizes(["2xl", "w700", "sm", "tablet", "phone"]), ["phone", "tablet", "sm", "w700", "2xl"]);
});

test("a filmstrip fills the pane's height; a grid shares one scale so sizes compare honestly; nothing is shown bigger than it is", () => {
  const frames = [
    { w: 390, h: 844 },
    { w: 1280, h: 900 },
  ];
  const avail = { w: 1000, h: 600 };
  const row = scales(frames, "row", avail);
  assert.ok(Math.abs(row[0] * 844 - (600 - 2 * PAD - LABEL)) < 1e-9);
  assert.ok(Math.abs(row[1] * 900 - (600 - 2 * PAD - LABEL)) < 1e-9);
  const grid = scales(frames, "grid", avail);
  assert.equal(grid[0], grid[1]);
  assert.ok(Math.abs(grid[0] * 1280 - (1000 - 2 * PAD)) < 1e-9);
  assert.deepEqual(scales([{ w: 300, h: 300 }], "grid", { w: 4000, h: 4000 }), [1]);
  assert.deepEqual(scales([{ w: 300, h: 300 }], "row", { w: 4000, h: 4000 }), [1]);
});

test("fit all is the largest common scale at which every frame fits without scrolling", () => {
  const frames = [
    { w: 390, h: 844 },
    { w: 768, h: 900 },
    { w: 1024, h: 900 },
    { w: 1280, h: 900 },
  ];
  const avail = { w: 1400, h: 800 };
  const [s] = scales(frames, "fit", avail);
  const w = avail.w - 2 * PAD;
  const h = avail.h - 2 * PAD;
  assert.ok(packedHeight(frames, s, w) <= h, "fits");
  assert.ok(packedHeight(frames, s + 0.01, w) > h, "and no larger scale does");
  assert.equal(fitScale([{ w: 100, h: 100 }], 1000, 1000), 1);
  // A frame wider than the pane at a scale doesn't fit at all.
  assert.equal(packedHeight([{ w: 2000, h: 10 }], 1, 1000), Infinity);
});

test("a frame's first address carries the flag that asks the proxy for the preview script; reported addresses never do", () => {
  assert.equal(flagged("http://checkout.shop.devl.localhost:1377/cart?x=1#top"), "http://checkout.shop.devl.localhost:1377/cart?x=1&__berth_preview=1#top");
  assert.equal(unflagged("http://checkout.shop.devl.localhost:1377/cart?x=1&__berth_preview=1#top"), "http://checkout.shop.devl.localhost:1377/cart?x=1#top");
  assert.equal(unflagged("http://a.localhost/"), "http://a.localhost/");
  assert.equal(proxied("http://checkout.shop.devl.localhost:1377/"), true);
  assert.equal(proxied("http://localhost:3000/"), true);
  assert.equal(proxied("https://github.com/"), false);
  assert.equal(proxied("not a url"), false);
});

test("only Terminal's own frame messages are read", () => {
  assert.equal(parseMessage({ type: "nav", url: "x" }), undefined);
  assert.equal(parseMessage({ berth: "preview", id: "md", type: "nav" }), undefined);
  assert.equal(parseMessage({ berth: "preview", id: "md", type: "eval", code: "x" }), undefined);
  assert.equal(parseMessage("berth"), undefined);
  assert.deepEqual(parseMessage({ berth: "preview", id: "md", type: "scroll", sel: "", x: 0, y: 0.5 }), { berth: "preview", id: "md", type: "scroll", sel: "", x: 0, y: 0.5 });
});

test("synced frames follow navigation and scrolling, clicks and typing only when mirrored; isolated frames nothing", () => {
  const nav = { type: "nav" as const, url: "http://a.localhost/b" };
  const click = { type: "click" as const, sel: "body>button:nth-of-type(1)" };
  const scroll = { type: "scroll" as const, sel: "", x: 0, y: 0.25, anchor: "#pricing", frac: 0.5 };
  const synced = { sync: true, mirror: false, scroll: "anchor" as const };
  assert.deepEqual(relay(nav, synced), { type: "navigate", url: "http://a.localhost/b" });
  assert.deepEqual(relay(scroll, synced), { type: "scroll", sel: "", x: 0, y: 0.25, anchor: "#pricing", frac: 0.5, mode: "anchor" });
  assert.equal(relay(click, synced), undefined);
  assert.deepEqual(relay(click, { ...synced, mirror: true }), { type: "click", sel: click.sel });
  assert.equal(relay(nav, { ...synced, sync: false }), undefined);
  assert.equal(relay({ type: "input", sel: "input", value: "x" }, { ...synced, sync: false, mirror: true }), undefined);
});

test("the screenshot lays frames side by side at one scale, wrapping under a width", () => {
  const { tiles, width, height } = sheetLayout(
    [
      { w: 400, h: 800 },
      { w: 1000, h: 600 },
      { w: 1000, h: 600 },
    ],
    { scale: 0.5, gap: 20, label: 30, pad: 10, maxWidth: 1200 },
  );
  assert.deepEqual(tiles, [
    { x: 10, y: 40, w: 200, h: 400 },
    { x: 230, y: 40, w: 500, h: 300 },
    { x: 10, y: 490, w: 500, h: 300 },
  ]);
  assert.equal(width, 740);
  assert.equal(height, 460 + 330 + 10);
});
