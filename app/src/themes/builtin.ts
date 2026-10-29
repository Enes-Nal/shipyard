import type { Theme } from "@/lib/api";

import { vscodeThemes } from "./vscode.ts";

// Built-in themes. More come from ~/.berth/themes/*.json through the agent,
// and from plugins; a theme with a built-in's id replaces it.

// Accessibility pass: focus ring #5b5d66 → #6c6e77, muted text #8a8c95 →
// #91939c (focus rings 3:1, muted text 4.5:1 on popovers and highlighted
// rows).
export const berthDark: Theme = {
  id: "berth-dark",
  name: "Terminal Dark",
  appearance: "dark",
  colors: {
    background: "#1d1e22",
    foreground: "#e3e4e8",
    sidebar: "#18191c",
    sidebarForeground: "#a9abb3",
    muted: "#25262b",
    mutedForeground: "#91939c",
    border: "#2c2d33",
    accent: "#2a2b31",
    accentForeground: "#f1f2f4",
    primary: "#e3e4e8",
    primaryForeground: "#18191c",
    card: "#212226",
    popover: "#222328",
    ring: "#6c6e77",
    success: "#3fb950",
    warning: "#e8a33d",
    destructive: "#f0564a",
    // The app's own blue for running, and Tailwind's 400s for the states'
    // text, as the app drew them before themes could set them.
    info: "#2b7fff",
    successForeground: "#00d492",
    warningForeground: "#ffb900",
    destructiveForeground: "#ff6467",
    infoForeground: "#51a2ff",
  },
  terminal: {
    background: "#1d1e22",
    foreground: "#dcdde2",
    cursor: "#e3e4e8",
    selectionBackground: "#3a3c45",
    black: "#1d1e22",
    red: "#f0564a",
    green: "#3fb950",
    yellow: "#e8a33d",
    blue: "#6d9eff",
    magenta: "#c88bf0",
    cyan: "#4fc1d6",
    white: "#c9cad0",
    brightBlack: "#6b6d76",
    brightRed: "#ff7b70",
    brightGreen: "#5fd36f",
    brightYellow: "#f5c063",
    brightBlue: "#8db4ff",
    brightMagenta: "#dba8f7",
    brightCyan: "#7ad6e6",
    brightWhite: "#f4f5f7",
  },
};

// Accessibility pass: focus ring #a3a5ad → #888a92 (focus rings 3:1, muted
// text 4.5:1 on popovers and highlighted rows).
export const berthLight: Theme = {
  id: "berth-light",
  name: "Terminal Light",
  appearance: "light",
  colors: {
    background: "#ffffff",
    foreground: "#26272b",
    sidebar: "#f1f1f3",
    sidebarForeground: "#5d5f67",
    muted: "#f2f2f4",
    // 4.8:1 on the sidebar, 5.4:1 on the page: AA for small text on both.
    mutedForeground: "#686a73",
    border: "#e6e6ea",
    accent: "#ececef",
    accentForeground: "#1d1e22",
    primary: "#26272b",
    primaryForeground: "#fafafa",
    card: "#ffffff",
    popover: "#ffffff",
    ring: "#888a92",
    success: "#1f9d55",
    warning: "#c27a12",
    destructive: "#d93a2e",
    // The app's own blue for running, and Tailwind's 700s and 800s for the
    // states' text, as the app drew them before themes could set them
    // (green a shade darker, for 4.5:1 on its tint).
    info: "#2b7fff",
    successForeground: "#00714e",
    warningForeground: "#973c00",
    destructiveForeground: "#c10007",
    infoForeground: "#1447e6",
  },
  terminal: {
    background: "#ffffff",
    foreground: "#2b2c31",
    cursor: "#26272b",
    selectionBackground: "#dbe3f5",
    black: "#26272b",
    red: "#c9372c",
    green: "#1f8a46",
    yellow: "#a96a08",
    blue: "#2f63c9",
    magenta: "#8a3fc0",
    cyan: "#137f91",
    white: "#c4c5cb",
    brightBlack: "#7a7c85",
    brightRed: "#e0483d",
    brightGreen: "#2aa458",
    brightYellow: "#c4840f",
    brightBlue: "#4a7de0",
    brightMagenta: "#a259d4",
    brightCyan: "#1a98ad",
    brightWhite: "#ffffff",
  },
};

// Accessibility pass: focus ring #4a5b85 → #566792, muted text #7886a6 →
// #7c8aaa (focus rings 3:1, muted text 4.5:1 on popovers and highlighted
// rows).
export const midnight: Theme = {
  id: "midnight",
  name: "Midnight",
  appearance: "dark",
  colors: {
    background: "#0f1420",
    foreground: "#d7deef",
    sidebar: "#0b0f19",
    sidebarForeground: "#93a0bd",
    muted: "#161c2b",
    mutedForeground: "#7c8aaa",
    border: "#1e2639",
    accent: "#1a2236",
    accentForeground: "#e7ecf8",
    primary: "#8fb3ff",
    primaryForeground: "#0b0f19",
    card: "#121828",
    popover: "#141b2c",
    ring: "#566792",
    success: "#4ccf8b",
    warning: "#f2b65a",
    destructive: "#ff6b7a",
    // The app's own blue for running, and Tailwind's 400s for the states'
    // text, as the app drew them before themes could set them.
    info: "#2b7fff",
    successForeground: "#00d492",
    warningForeground: "#ffb900",
    destructiveForeground: "#ff6467",
    infoForeground: "#51a2ff",
  },
  terminal: {
    background: "#0f1420",
    foreground: "#cdd6ee",
    cursor: "#8fb3ff",
    selectionBackground: "#26324d",
    black: "#0f1420",
    red: "#ff6b7a",
    green: "#4ccf8b",
    yellow: "#f2b65a",
    blue: "#6f9bff",
    magenta: "#c592ff",
    cyan: "#5fd0e6",
    white: "#c3cbe0",
    brightBlack: "#56627f",
    brightRed: "#ff8e99",
    brightGreen: "#73e0a7",
    brightYellow: "#f7cc85",
    brightBlue: "#97b7ff",
    brightMagenta: "#d6b1ff",
    brightCyan: "#8be0f0",
    brightWhite: "#f2f5fc",
  },
};

// Accessibility pass: focus ring #b3a68c → #93876e, muted text #746b5d →
// #6d6456 (focus rings 3:1, muted text 4.5:1 on popovers and highlighted
// rows).
export const paper: Theme = {
  id: "paper",
  name: "Paper",
  appearance: "light",
  colors: {
    background: "#fbf8f1",
    foreground: "#3a342a",
    sidebar: "#f3eee2",
    sidebarForeground: "#6d6453",
    muted: "#f0eadc",
    // 4.5:1 on the page, the sidebar and cards.
    mutedForeground: "#6d6456",
    border: "#e4dccb",
    accent: "#ebe3d2",
    accentForeground: "#2e281f",
    primary: "#3a342a",
    primaryForeground: "#fbf8f1",
    card: "#fdfbf6",
    popover: "#fdfbf6",
    ring: "#93876e",
    success: "#4d8a3b",
    warning: "#b8751a",
    destructive: "#b8432f",
    // Its own ink for running, and its state colours darkened for text,
    // 4.5:1 on their tints.
    info: "#3c6a9e",
    successForeground: "#316d1d",
    warningForeground: "#8c5500",
    destructiveForeground: "#a93521",
    infoForeground: "#2f5a8a",
  },
  terminal: {
    background: "#fbf8f1",
    foreground: "#3a342a",
    cursor: "#3a342a",
    selectionBackground: "#e8dcc0",
    black: "#3a342a",
    red: "#b8432f",
    green: "#4d8a3b",
    yellow: "#9a6a12",
    blue: "#3c6a9e",
    magenta: "#8d4f8a",
    cyan: "#2f7f7a",
    white: "#cfc6b4",
    brightBlack: "#8a816f",
    brightRed: "#cf5a44",
    brightGreen: "#62a24d",
    brightYellow: "#b88420",
    brightBlue: "#5585bb",
    brightMagenta: "#a866a4",
    brightCyan: "#3f9993",
    brightWhite: "#ffffff",
  },
};

// Terminal's own, which the picker lists first.
export const berthThemes: Theme[] = [berthDark, berthLight, midnight, paper];

export const builtinThemes: Theme[] = [...berthThemes, ...vscodeThemes];
