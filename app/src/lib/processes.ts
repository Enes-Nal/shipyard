// A box's browsers and what its sessions use (GET /v1/processes on boxes
// with the "processes" capability; internal/box/boxprocs.go). No `@/`
// imports, so node's test runner can load it (processes.test.ts).
import { bytes } from "./format.ts";

export type BrowserOwner = "agent" | "agent-browser" | "session" | "orphan" | "other";

export interface BoxBrowser {
  id: string;
  engine: string;
  owner: BrowserOwner;
  // "Playwright tests in cal/billing", "Agent browser for cal/billing", …
  label: string;
  via?: string;
  session?: string;
  location?: string;
  worktree?: string;
  pid: number;
  pids: number[];
  processes: number;
  cpu_percent: number;
  memory: number;
  started?: string;
  exe?: string;
  // False for a browser Terminal didn't start (the box user's own).
  stoppable: boolean;
}

export interface ProcUsage {
  memory: number;
  memory_high?: number;
  cpu_s: number;
  cpu_percent?: number;
  processes?: number;
  near_limit?: boolean;
  throttled?: number;
  scoped?: boolean;
}

export interface BoxSessionProcs {
  id: string;
  name: string;
  location?: string;
  title?: string;
  agent?: string;
  scope?: string;
  usage: ProcUsage;
}

export interface BoxProcesses {
  browsers: BoxBrowser[];
  sessions?: BoxSessionProcs[];
  // New sessions on this box run in a systemd scope.
  scopes: boolean;
  at: string;
}

// cpu is a process's CPU use, where 100% is one core: "480%", "0.4%".
export function cpu(pct: number | undefined): string {
  const v = pct ?? 0;
  if (v > 0 && v < 1) return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

// age says how long ago something started: "40s", "12m", "3h", "2d".
export function age(started: string | undefined, now = Date.now()): string {
  if (!started) return "";
  const s = Math.max(0, (now - new Date(started).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// memory is a whole number of GB when it is one: "12 GB", "11.8 GB", "640 MB".
export function memory(n: number): string {
  return bytes(n).replace(/\.0 /, " ");
}

// OWNER_WORDS says who started a browser, for its tag.
export const OWNER_WORDS: Record<BrowserOwner, string> = {
  agent: "Terminal",
  "agent-browser": "agent-browser",
  session: "Session",
  orphan: "Left behind",
  other: "Not Terminal's",
};

// busy says a browser is worth a look: a core or more of CPU, or left by
// a session that ended.
export function busy(b: BoxBrowser): boolean {
  return b.cpu_percent >= 100 || b.owner === "orphan";
}

// summary is the popover's one line: "3 browsers · 1.4 GB · 480% CPU".
export function summary(list: BoxBrowser[]): string {
  if (!list.length) return "No browsers running";
  const mem = list.reduce((n, b) => n + b.memory, 0);
  const pct = list.reduce((n, b) => n + b.cpu_percent, 0);
  return `${list.length} ${list.length === 1 ? "browser" : "browsers"} · ${memory(mem)} · ${cpu(pct)} CPU`;
}

// memoryNote says how near its ceiling a session is: "using 11.8 GB, near
// its 12 GB limit", or undefined when it isn't near one.
export function memoryNote(u: ProcUsage | undefined): string | undefined {
  if (!u?.near_limit || !u.memory_high) return undefined;
  return `using ${memory(u.memory)}, near its ${memory(u.memory_high)} limit`;
}

// SESSION_LIMITS are the per-session memory ceilings Settings offers, in GB.
export const SESSION_LIMITS = [0, 4, 8, 12, 16, 24, 32, 64];
