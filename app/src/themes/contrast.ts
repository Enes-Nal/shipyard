import type { Theme } from "@/lib/api";
import { contrast, distance, over } from "./color.ts";

// What a theme must meet to ship with Terminal (contrast.test.ts runs it over
// every built-in theme; a theme of your own is not held to it):
//
// - Text is AA, 4.5:1: body text on every surface it sits on, muted text
//   on the page, the sidebar, cards, menus and a highlighted row (a menu's
//   item under the keyboard, a hovered row), the sidebar's text on its
//   selected row, a button's label on the button, links, and the
//   terminal's text on its background.
// - The focus ring is 3:1 on every surface it is drawn on (WCAG's bar for
//   UI that isn't text), so the keyboard's place is always seen.
// - A state's text colour (success, warning, destructive, info) is 4.5:1
//   on its own tint, the 16% wash badges and banners put behind it.
// - A state's own colour, a dot or a spinner, is 3:1 on the page and the
//   sidebar (WCAG's bar for UI that isn't text).
// - Done, waiting, failed and running look different from each other, and
//   the first three from the theme's primary colour.

export interface Check {
  what: string;
  value: number;
  min: number;
}

export const TEXT = 4.5;
export const UI = 3;
// OKLab distance: two state dots this far apart read as different colours;
// a state and the primary colour (a button, a selected row) a little less.
export const APART = 0.1;
export const APART_PRIMARY = 0.08;
// The wash behind a state's text (bg-warning/15, bg-info/16 and the like).
export const TINT = 0.16;

const STATES = ["success", "warning", "destructive", "info"] as const;

export function checks(t: Theme): Check[] {
  const c = t.colors;
  const out: Check[] = [];
  const text = (what: string, fg: string, bg: string) => out.push({ what, value: contrast(fg, bg), min: TEXT });

  for (const [name, bg] of [["background", c.background], ["sidebar", c.sidebar], ["card", c.card], ["popover", c.popover], ["muted", c.muted], ["accent", c.accent]] as const) {
    text(`foreground on ${name}`, c.foreground, bg);
  }
  text("sidebarForeground on sidebar", c.sidebarForeground, c.sidebar);
  for (const [name, bg] of [["background", c.background], ["sidebar", c.sidebar], ["card", c.card], ["popover", c.popover]] as const) {
    text(`mutedForeground on ${name}`, c.mutedForeground, bg);
  }
  // A highlighted row: the accent over the page, over a menu, and the chip
  // (muted) wash.
  text("mutedForeground on a highlighted row", c.mutedForeground, over(c.accent, c.background));
  text("mutedForeground on a highlighted menu item", c.mutedForeground, over(c.accent, c.popover));
  text("mutedForeground on muted", c.mutedForeground, over(c.muted, c.background));
  text("sidebarForeground on the sidebar's selected row", c.sidebarForeground, over(c.accent, c.sidebar));
  for (const [name, bg] of [["background", c.background], ["sidebar", c.sidebar], ["card", c.card], ["popover", c.popover]] as const) {
    out.push({ what: `ring on ${name}`, value: contrast(c.ring, bg), min: UI });
  }
  text("accentForeground on accent", c.accentForeground, c.accent);
  text("primaryForeground on primary", c.primaryForeground, c.primary);
  if (c.link) text("link on background", c.link, c.background);
  if (c.selection) text("foreground on selection", c.foreground, c.selection);
  text("terminal foreground on its background", t.terminal.foreground, t.terminal.background);
  text("terminal's selected text on its selection", t.terminal.selectionForeground ?? t.terminal.foreground, t.terminal.selectionBackground);

  for (const s of STATES) {
    const colour = c[s];
    if (!colour) continue;
    for (const [name, bg] of [["background", c.background], ["sidebar", c.sidebar]] as const) {
      out.push({ what: `${s} on ${name}`, value: contrast(colour, bg), min: UI });
    }
    const fg = c[`${s}Foreground`];
    if (!fg) continue;
    for (const [name, bg] of [["background", c.background], ["sidebar", c.sidebar], ["card", c.card]] as const) {
      text(`${s}Foreground on its tint over ${name}`, fg, over(colour, bg, TINT));
    }
  }

  const states = STATES.filter((s) => c[s]);
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      out.push({ what: `${states[i]} apart from ${states[j]}`, value: distance(c[states[i]] as string, c[states[j]] as string), min: APART });
    }
  }
  // Running and primary are often both the theme's blue; the rest are not.
  for (const s of ["success", "warning", "destructive"] as const) {
    out.push({ what: `${s} apart from primary`, value: distance(c[s], c.primary), min: APART_PRIMARY });
  }
  return out;
}

export function failures(t: Theme): Check[] {
  return checks(t).filter((x) => x.value + 1e-9 < x.min);
}
