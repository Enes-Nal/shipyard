// The forge view: what a project's GitLab knows that its checkout does not,
// from the box (GET /v1/locations/{name}/forge, internal/box/forgeview.go).
// GitLab is asked through glab, signed in on the box; nothing here holds a
// token. These are its types and the plain logic Project activity uses.

export interface ForgeCommit {
  sha: string;
  short: string;
  subject: string;
  author: string;
  time: string;
}

export interface ForgePipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  url: string;
  updated: string;
}

export interface MergeRequest {
  iid: number;
  title: string;
  state: "opened" | "merged" | "closed" | string;
  draft?: boolean;
  source_branch: string;
  target_branch: string;
  author?: string;
  url: string;
  sha?: string;
  updated: string;
  pipeline?: ForgePipeline;
}

export interface RemoteBranch {
  name: string;
  default?: boolean;
  ahead: number;
  behind: number;
  last_commit?: ForgeCommit;
}

export type ForgeProblem = "glab_missing" | "signed_out" | "failed";

export interface ForgeView {
  kind: "gitlab" | "github" | "git";
  host?: string;
  project?: { path: string; url: string; default_branch?: string };
  merge_requests: MergeRequest[];
  pipelines: ForgePipeline[];
  branches: RemoteBranch[];
  problem?: ForgeProblem;
  detail?: string;
  fetched: string;
}

// PipelineTone is how a pipeline's status reads at a glance.
export type PipelineTone = "passed" | "failed" | "running" | "waiting" | "other";

export function pipelineTone(status: string | undefined): PipelineTone {
  switch (status) {
    case "success":
      return "passed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "created":
    case "pending":
    case "preparing":
    case "waiting_for_resource":
    case "scheduled":
    case "manual":
      return "waiting";
    default:
      return "other";
  }
}

export const toneLabel: Record<PipelineTone, string> = { passed: "Passed", failed: "Failed", running: "Running", waiting: "Waiting", other: "Other" };

// mrForBranch is the merge request a branch is the source of: an open one,
// else the most recently updated.
export function mrForBranch(view: ForgeView | undefined, branch: string | undefined): MergeRequest | undefined {
  if (!view || !branch) return undefined;
  const mine = view.merge_requests.filter((m) => m.source_branch === branch);
  return mine.find((m) => m.state === "opened") ?? [...mine].sort((a, b) => b.updated.localeCompare(a.updated))[0];
}

// defaultPipeline is the latest pipeline on the project's default branch.
export function defaultPipeline(view: ForgeView | undefined): ForgePipeline | undefined {
  const def = view?.project?.default_branch;
  return def ? view?.pipelines.find((p) => p.ref === def) : undefined;
}

// problemCopy says what kept GitLab from answering, and the command that
// fixes it, run on the box (in Ubuntu, for this PC's WSL box: wsl).
export function problemCopy(view: ForgeView, box: string, wsl = false): { title: string; text: string; command?: string } | undefined {
  const host = view.host && view.host !== "gitlab.com" ? view.host : undefined;
  const there = wsl ? "in Ubuntu" : `on ${box}`;
  switch (view.problem) {
    case "glab_missing":
      return { title: `glab isn't installed on ${box}`, text: `Shipyard asks GitLab through glab, the GitLab CLI. Install it ${there}, then sign in.`, command: "sudo apt install -y glab" };
    case "signed_out":
      return {
        title: `Sign in to GitLab on ${box}`,
        text: `glab isn't signed in, so merge requests and pipelines can't be read. Run this ${there} once; Shipyard never sees the token.`,
        command: host ? `glab auth login --hostname ${host}` : "glab auth login",
      };
    case "failed":
      return { title: "GitLab didn't answer", text: view.detail || "glab couldn't read this project. Refresh to try again." };
  }
  return undefined;
}

export interface Attributed<T> {
  item: T;
  agents: string[];
}

// timeline merges each task's own commits, newest first, each with the
// agents that worked in that task's worktree.
export function timeline<C extends { sha: string; time: string }>(perTask: { commits: C[]; agents: string[] }[], limit = 20): Attributed<C>[] {
  const seen = new Set<string>();
  const out: Attributed<C>[] = [];
  for (const t of perTask) {
    for (const c of t.commits) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      out.push({ item: c, agents: t.agents });
    }
  }
  return out.sort((a, b) => b.item.time.localeCompare(a.item.time)).slice(0, limit);
}
