import type { Client } from "@/lib/api";

// A worktree's state as the box sees it, for managing many at once: how far
// it is from its base, what is uncommitted, its last commit, and whether its
// agents are paused. See internal/box/worktreeops.go.

export interface Commit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  time: string;
  refs?: string;
  // False for a commit not on the base branch yet.
  on_base?: boolean;
  // Two or more for a merge.
  parents?: string[];
}

export interface WorktreeStatus {
  location: string;
  name: string;
  title?: string;
  path: string;
  remote?: string;
  branch?: string;
  main?: boolean;
  port?: number;
  base?: string;
  ahead: number;
  behind: number;
  upstream?: string;
  // Commits waiting to push to, or pull from, this branch's upstream.
  outgoing?: number;
  incoming?: number;
  published?: boolean;
  changed: number;
  untracked: number;
  last_commit?: Commit;
  paused?: boolean;
  sessions: number;
  error?: string;
}

export type SyncMode = "rebase" | "merge" | "pull";

export interface SyncResult {
  mode: SyncMode;
  base: string;
  ok: boolean;
  output: string;
  // Files that conflicted; the box has already aborted, so nothing changed.
  conflicts?: string[];
  ahead: number;
  behind: number;
}

const enc = encodeURIComponent;
const at = (loc: string, wt: string) => `locations/${enc(loc)}/worktrees/${enc(wt)}`;

export const worktreesApi = {
  list: async (c: Client, box: string) => (await c.box<WorktreeStatus[] | null>(box, "GET", "worktrees")) ?? [],
  // graph adds the base's own commits, in topological order with HEAD's, so
  // the two can be drawn as a graph.
  log: (c: Client, box: string, loc: string, wt: string, limit = 50, graph = false) =>
    c.box<{ base: string; commits: Commit[] | null }>(box, "GET", `${at(loc, wt)}/log?limit=${limit}${graph ? "&graph=1" : ""}`),
  sync: (c: Client, box: string, loc: string, wt: string, mode: SyncMode) => c.box<SyncResult>(box, "POST", `${at(loc, wt)}/sync`, { mode }),
  pause: (c: Client, box: string, loc: string, wt: string, on: boolean) => c.box<WorktreeStatus>(box, "POST", `${at(loc, wt)}/${on ? "pause" : "resume"}`),
  remove: (c: Client, box: string, loc: string, wt: string, opts: { force?: boolean; branch?: boolean }) => {
    const q = new URLSearchParams({ ...(opts.force ? { force: "1" } : {}), ...(opts.branch ? { delete_branch: "1" } : {}) }).toString();
    return c.box(box, "DELETE", `${at(loc, wt)}${q ? `?${q}` : ""}`);
  },
};

export const SYNC_MODES: { value: SyncMode; label: string; hint: string }[] = [
  { value: "rebase", label: "Rebase", hint: "Replay its commits on top of the base" },
  { value: "merge", label: "Merge", hint: "Merge the base into it" },
  { value: "pull", label: "Fast-forward only", hint: "Only if it has no commits of its own" },
];
