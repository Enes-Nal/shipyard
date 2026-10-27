import { type ChatBackground, downscale } from "@/lib/chat-background";
import { type Field, gradientField, patternField, SEA } from "@/lib/chat-background-fields";

// Drawing a chat background. Everything becomes ink: how far each cell
// rises from the page toward the theme's text, at most `strength` of the
// way, so it always lies between the two and follows light and dark. A
// pattern or gradient is computed (chat-background-fields.ts); a scene or
// picture becomes ink by its lightness, light parts under a dark theme and
// dark parts under a light one. The ink is then dithered (ordered, Bayer)
// in dots of 2 or 4 CSS px, like the harbour art, or left smooth.
//
// It is drawn once into the canvas it is given, at a cell per dot (up to
// 1.5x the screen's pixels when smooth), and redrawn only when the
// picture, the effects, the theme or the size change. Nothing runs between.
//
// It also measures the result: the reading sheet behind the conversation
// (chat-background.tsx) is only as opaque as body text needs for 7:1 and
// muted text for 4.5:1 over the worst of it, which for the built-ins at
// their default strength is little or nothing.

export type RGB = [number, number, number];

export interface ThemeColours {
  bg: RGB;
  fg: RGB;
  muted: RGB;
  dark: boolean;
}

export type Img = CanvasImageSource & { width: number; height: number };

export type Source = { kind: "pattern" | "gradient"; id: string } | { kind: "image"; img: Img };

export interface RenderResult {
  // Draw the canvas with hard pixels (dithered) or smooth.
  pixelated: boolean;
  // The reading sheet's opacity, 0 to 1.
  sheet: number;
}

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63,
  31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

// The most pixels a background is drawn with.
const MAX_PIXELS = 2560 * 1600;
// Steps of ink the dither moves between.
const LEVELS = 4;

// amountOf is how far toward the text colour full ink goes.
export const amountOf = (strength: number) => 0.04 + 0.36 * strength;

// render draws src into out for a pane of w×h CSS px. unit scales the
// design (a pattern's spacing, a dot's size) for a preview smaller than a
// pane.
export function render(out: HTMLCanvasElement, src: Source, w: number, h: number, dpr: number, o: ChatBackground, theme: ThemeColours, unit = 1): RenderResult {
  const original = src.kind === "image" && o.original;
  const smooth = original || o.dither === "off";
  const device = 1 / Math.min(Math.max(dpr, 1), 1.5);
  let cell = smooth ? device : Math.max(0.5, (o.dither === "coarse" ? 4 : 2) * unit);
  let ww = Math.max(1, Math.round(w / cell));
  let wh = Math.max(1, Math.round(h / cell));
  if (ww * wh > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (ww * wh));
    ww = Math.max(1, Math.round(ww * k));
    wh = Math.max(1, Math.round(wh * k));
  }
  cell = w / ww;

  const frame = new ImageData(ww, wh);
  const data = frame.data;
  const { bg, fg } = theme;
  if (src.kind === "image") {
    const px = placed(src.img, ww, wh, o, bg);
    if (original) {
      // As it is, faded toward the page by less as strength rises.
      const k = 0.3 + 0.7 * o.strength;
      for (let i = 0; i < px.length; i += 4) {
        data[i] = bg[0] + (px[i] - bg[0]) * k;
        data[i + 1] = bg[1] + (px[i + 1] - bg[1]) * k;
        data[i + 2] = bg[2] + (px[i + 2] - bg[2]) * k;
        data[i + 3] = 255;
      }
    } else {
      // Dithered, a picture of your own keeps its forms, not its detail: it
      // is softened to about a seventh first, so a busy photo reads as light
      // and shade. Shipkit's own scenes are calm already and keep theirs.
      const soft = o.source === "image" ? softened(src.img, ww, wh, o, bg) : placed(src.img, ww, wh, o, bg);
      ink(data, ww, wh, imageField(soft, ww * wh, theme.dark), o, theme, (p, c) => mixInto(c, fg, [soft[p * 4], soft[p * 4 + 1], soft[p * 4 + 2]], 0.6));
    }
  } else {
    const f = src.kind === "gradient" ? gradientField(src.id, ww, wh) : patternField(src.id, ww, wh, cell / unit);
    const hue = f.hue;
    // A gradient's hue under a light theme is the tint itself; under a
    // dark one it is lifted toward the text so it glows rather than muddies.
    const lift = theme.dark ? 0.85 : 1;
    // A gradient is soft and slow, so it takes more; a pattern's dark lines
    // on a light page read stronger than light ones on a dark page.
    // Lines read as strokes through letters, so they are the faintest; a
    // dot grid less so.
    const scale = hue ? (theme.dark ? 1.9 : 1.5) : src.id === "dots" ? (theme.dark ? 0.9 : 0.75) : theme.dark ? 0.6 : 0.5;
    ink(data, ww, wh, f, o, theme, hue ? (p, c) => mixInto(c, fg, [hue[p * 3], hue[p * 3 + 1], hue[p * 3 + 2]], lift) : (_p, c) => mixInto(c, fg, SEA, 0.5), scale);
  }

  out.width = ww;
  out.height = wh;
  out.getContext("2d")!.putImageData(frame, 0, 0);
  return { pixelated: !smooth, sheet: sheetFor(out, theme) };
}

// ink lays the field on the page: each cell moves from the background
// toward its ink colour (the theme's text, or that tinted by a hue) by
// strength times its ink, quantized against a Bayer threshold unless
// smooth.
function ink(data: Uint8ClampedArray, w: number, h: number, f: Field, o: ChatBackground, t: ThemeColours, tinted: (p: number, c: RGB) => RGB, scale = 1) {
  const amount = amountOf(o.strength) * scale;
  const smooth = o.dither === "off";
  const c: RGB = [0, 0, 0];
  for (let y = 0, p = 0; y < h; y++) {
    const row = (y & 7) * 8;
    for (let x = 0; x < w; x++, p++) {
      const v = f.v[p];
      const q = smooth ? v : Math.min(LEVELS, Math.floor(v * LEVELS + BAYER8[row + (x & 7)])) / LEVELS;
      const col = o.tone === "ink" ? t.fg : tinted(p, c);
      const k = amount * q;
      const i = p * 4;
      data[i] = t.bg[0] + (col[0] - t.bg[0]) * k;
      data[i + 1] = t.bg[1] + (col[1] - t.bg[1]) * k;
      data[i + 2] = t.bg[2] + (col[2] - t.bg[2]) * k;
      data[i + 3] = 255;
    }
  }
}

function mixInto(out: RGB, a: RGB, b: RGB, t: number): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

// imageField is a picture's ink: its lightness across its own range, light
// as ink under a dark theme and dark as ink under a light one.
function imageField(px: Uint8ClampedArray, n: number, dark: boolean): Field {
  const Y = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    Y[p] = luma(px[i], px[i + 1], px[i + 2]);
    hist[Math.round(Y[p])]++;
  }
  const lo = percentile(hist, n, 0.02);
  const hi = Math.max(lo + 1, percentile(hist, n, 0.98));
  const v = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const k = Math.min(1, Math.max(0, (Y[p] - lo) / (hi - lo)));
    v[p] = dark ? k : 1 - k;
  }
  return { v };
}

// softened is the picture placed small and drawn back up, smoothly.
function softened(src: Img, ww: number, wh: number, o: ChatBackground, bg: RGB): Uint8ClampedArray {
  const k = 7;
  const sw = Math.max(8, Math.round(ww / k));
  const sh = Math.max(8, Math.round(wh / k));
  const small = placed(src, sw, sh, o, bg);
  const a = document.createElement("canvas");
  a.width = sw;
  a.height = sh;
  const img = a.getContext("2d")!.createImageData(sw, sh);
  img.data.set(small);
  a.getContext("2d")!.putImageData(img, 0, 0);
  const b = document.createElement("canvas");
  b.width = ww;
  b.height = wh;
  const x = b.getContext("2d", { willReadFrequently: true })!;
  x.imageSmoothingQuality = "high";
  x.drawImage(a, 0, 0, ww, wh);
  const px = x.getImageData(0, 0, ww, wh).data;
  a.width = a.height = b.width = b.height = 0;
  return px;
}

// placed is the picture fitted to the canvas, as pixels: cover crops it,
// contain shows all of it over a soft wash of itself.
function placed(src: Img, ww: number, wh: number, o: ChatBackground, bg: RGB): Uint8ClampedArray {
  const work = document.createElement("canvas");
  work.width = ww;
  work.height = wh;
  const ctx = work.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = `rgb(${bg.join(",")})`;
  ctx.fillRect(0, 0, ww, wh);
  const pos = o.position === "top" ? 0 : o.position === "bottom" ? 1 : 0.5;
  const draw = (scale: number) => {
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));
    const scaled = dw < src.width ? downscale(src, dw, dh) : null;
    ctx.drawImage(scaled ?? src, Math.round((ww - dw) / 2), Math.round((wh - dh) * pos), dw, dh);
    if (scaled) scaled.width = scaled.height = 0;
  };
  if (o.fit === "contain") {
    const tiny = downscale(src, 24, Math.max(1, Math.round((24 * src.height) / src.width)));
    const s = Math.max(ww / tiny.width, wh / tiny.height);
    ctx.drawImage(tiny, (ww - tiny.width * s) / 2, (wh - tiny.height * s) / 2, tiny.width * s, tiny.height * s);
    tiny.width = tiny.height = 0;
    draw(Math.min(ww / src.width, wh / src.height));
  } else draw(Math.max(ww / src.width, wh / src.height));
  const px = ctx.getImageData(0, 0, ww, wh).data;
  work.width = work.height = 0;
  return px;
}

function percentile(hist: Uint32Array, n: number, q: number): number {
  const want = n * q;
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen >= want) return v;
  }
  return 255;
}

export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function lin(c: number) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
export const luminance = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: RGB, b: RGB) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// sheetFor is how opaque the clean column over the background must be,
// at least SHEET_FLOOR. Under text the background may only whisper: over
// its most contrasting colour (the background as text sees it, averaged
// over a few px so a 1-dot line counts as the faint line it reads as),
// the sheet leaves at most UNDER_TEXT of contrast against the plain page,
// and body text 7:1, muted text 4.5:1.
const SHEET_FLOOR = 0.86;
const UNDER_TEXT = 1.06;
function sheetFor(c: HTMLCanvasElement, t: ThemeColours): number {
  const sw = Math.min(c.width, 160);
  const sh = Math.max(1, Math.round((sw * c.height) / c.width));
  const small = downscale(c, sw, sh);
  const px = small.getContext("2d")!.getImageData(0, 0, sw, sh).data;
  small.width = small.height = 0;
  const all: { c: RGB; k: number }[] = [];
  for (let i = 0; i < px.length; i += 4) {
    const col: RGB = [px[i], px[i + 1], px[i + 2]];
    all.push({ c: col, k: contrast(t.bg, col) });
  }
  all.sort((a, b) => b.k - a.k);
  // The worst 0.5%: a line is a small share of a pattern's pixels.
  const worst = all[Math.floor(all.length * 0.005)]?.c ?? t.bg;
  let a = sheetOver(worst, t);
  while (a < 0.99 && contrast(mix(worst, t.bg, a), t.bg) > UNDER_TEXT) a += 0.01;
  return Math.max(SHEET_FLOOR, Math.min(0.99, a));
}

// sheetOver is the least opacity at which the theme's text reads over the
// sheet laid on colour c; 0 when it reads on c itself. A theme whose own
// muted text is below 4.5:1 on its page is held to (nearly) its own.
export function sheetOver(c: RGB, t: ThemeColours): number {
  const body = Math.min(7, contrast(t.fg, t.bg) * 0.95);
  const muted = Math.min(4.5, contrast(t.muted, t.bg) * 0.95);
  const ok = (under: RGB) => contrast(t.fg, under) >= body && contrast(t.muted, under) >= muted;
  if (ok(c)) return 0;
  for (let a = 0.1; a < 0.97; a += 0.02) if (ok(mix(c, t.bg, a))) return a;
  return 0.97;
}
