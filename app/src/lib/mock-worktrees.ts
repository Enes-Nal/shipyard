import type { BerthEvent, Location, Session } from "@/lib/api";
import type { Commit, SyncMode, SyncResult, WorktreeStatus } from "@/lib/worktrees";

// Mock mode's worktree status, history, sync and pause, over mock.ts's own
// locations and sessions, so the sidebar and the Worktrees view agree.

type Emit = (e: Omit<BerthEvent, "time">) => void;
interface World {
  locations: Record<string, Location[]>;
  sessions: Record<string, Session[]>;
}

interface Git {
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  paused?: boolean;
  outgoing?: number;
  incoming?: number;
  published?: boolean;
  // A rebase or merge of this one stops on these files.
  conflicts?: string[];
  subjects?: string[];
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const git: Record<string, Git> = {
  "devl/shop/checkout-fix": {
    ahead: 3,
    behind: 12,
    changed: 4,
    untracked: 1,
    outgoing: 2,
    incoming: 1,
    published: true,
    conflicts: ["apps/web/lib/payments/webhook.ts", "db/schema.sql"],
    subjects: ["fix(payments): add an idempotency key to the payment webhook", "test(payments): two retries create one order", "chore: migration for idempotency_key"],
  },
  "devl/shop/qa-deck": { ahead: 1, behind: 0, changed: 0, untracked: 0, outgoing: 0, published: true, subjects: ["docs: QA deck outline"] },
  "devl/shop/search-perf": {
    ahead: 5,
    behind: 2,
    changed: 0,
    untracked: 0,
    paused: true,
    subjects: ["perf(search): memoise facet counts", "perf(search): virtualise the results grid", "perf: drop moment from the search bundle", "test: search render budget", "chore: bundle report"],
  },
  "gpu/evals/judge-v2": { ahead: 2, behind: 30, changed: 1, untracked: 3, outgoing: 1, incoming: 3, published: true, subjects: ["feat(judge): rubric v2", "feat(judge): pairwise mode"] },
  "gpu/shop/ci-flake": { ahead: 2, behind: 0, changed: 0, untracked: 0, outgoing: 0, incoming: 0, published: true, subjects: ["fix(ci): isolate billing test state", "test(ci): cover the ledger retry"] },
};

const baseSubjects = [
  "fix(api): return 404 for unknown products",
  "feat(admin): low-stock report",
  "chore(deps): bump next to 15.3.1",
  "fix(search): filter select keeps focus",
  "refactor(api): split the orders router",
  "docs: running it locally",
  "fix(cart): quantity after a coupon is removed",
  "feat(emails): shipping update emails",
  "chore: release v2.8.0",
  "fix(checkout): address form height on small screens",
  "test(e2e): flaky cart spec",
  "feat(payments): saved cards",
];
const authors = ["me", "ada-m", "jun-p", "priya-n", "tomas-r", "lena-f"];

function gitOf(box: string, loc: string, wt: string): Git {
  return (git[`${box}/${loc}/${wt}`] ??= { ahead: 0, behind: 0, changed: 0, untracked: 0 });
}

function shaFor(seed: string): string {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return Array.from({ length: 5 }, (_, i) => ((h >>> 0) * (i + 7)).toString(16).padStart(8, "0").slice(0, 8)).join("");
}

interface Node extends Commit {
  parents: string[];
  // Reachable from the worktree's HEAD.
  mine: boolean;
}

// history builds a small but real graph: the base's commits (with a pull
// request merged every few commits), the worktree's branch leaving it
// `behind` commits ago, and, for some, a side branch merged into it.
function history(box: string, loc: string, wt: string, branch: string | undefined): Node[] {
  const g = gitOf(box, loc, wt);
  const N = 24;
  const fork = N - 1 - g.behind; // the merge base's index
  const base: Node[] = [];
  const out: Node[] = [];
  const at = (i: number) => minutesAgo((N - i) * 70 + 40);
  for (let i = 0; i < N; i++) {
    const prev = base[i - 1];
    const pr = i > 0 && i % 5 === 0;
    let parents = prev ? [prev.sha] : [];
    if (pr) {
      // A pull request: one side commit off the previous base commit, merged.
      const sideSha = shaFor(`${loc}:pr:${i}`);
      const side: Node = { sha: sideSha, short: sideSha.slice(0, 7), subject: baseSubjects[(i + 3) % baseSubjects.length], author: authors[(i + 1) % authors.length], time: minutesAgo((N - i) * 70 + 60), on_base: true, parents: [prev.sha], mine: false };
      out.push(side);
      parents = [prev.sha, sideSha];
    }
    const sha = shaFor(`${loc}:base:${i}`);
    const node: Node = {
      sha,
      short: sha.slice(0, 7),
      subject: pr ? `Merge pull request #${14200 + i} from acme/${baseSubjects[(i + 3) % baseSubjects.length].split(":")[0].replace(/[()]/g, "-")}` : baseSubjects[(i + wt.length) % baseSubjects.length],
      author: authors[i % authors.length],
      time: at(i),
      on_base: true,
      parents,
      mine: false,
    };
    base.push(node);
    out.push(node);
  }
  base[N - 1].refs = "origin/main, main";
  base[Math.max(0, N - 9)].refs = "tag: v2.8.0";
  // HEAD's history: everything up to the merge base…
  const mark = (n: Node) => {
    n.mine = true;
    for (const p of n.parents) {
      const m = out.find((x) => x.sha === p);
      if (m && !m.mine) mark(m);
    }
  };
  mark(base[Math.max(fork, 0)]);
  // …then the branch's own commits, one of them a merge of a side branch.
  let parent = base[Math.max(fork, 0)];
  const subjects = (g.subjects ?? []).slice(0, g.ahead);
  subjects.forEach((subject, j) => {
    const time = new Date(new Date(parent.time).getTime() + 25 * 60_000).toISOString();
    let parents = [parent.sha];
    if (j === 1 && subjects.length > 2) {
      const sideSha = shaFor(`${wt}:side:${j}`);
      out.push({ sha: sideSha, short: sideSha.slice(0, 7), subject: "wip: try a second approach", author: "me", time: new Date(new Date(parent.time).getTime() + 10 * 60_000).toISOString(), on_base: false, parents: [parent.sha], mine: true, refs: `${branch}-alt` });
      parents = [parent.sha, sideSha];
    }
    const sha = shaFor(`${wt}:${subject}`);
    const node: Node = { sha, short: sha.slice(0, 7), subject: j === 1 && subjects.length > 2 ? `Merge branch '${branch}-alt' into ${branch}` : subject, author: "me", time, on_base: false, parents, mine: true };
    out.push(node);
    parent = node;
  });
  if (branch && g.ahead > 0) parent.refs = `HEAD -> ${branch}`;
  else if (branch) base[Math.max(fork, 0)].refs = [`HEAD -> ${branch}`, base[Math.max(fork, 0)].refs].filter(Boolean).join(", ");
  // Newest first; every child is newer than its parents, so this is topological.
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

function commits(box: string, loc: string, wt: string, branch: string | undefined, limit: number, graph = false): Commit[] {
  return history(box, loc, wt, branch)
    .filter((n) => graph || n.mine)
    .slice(0, limit)
    .map(({ mine: _, ...c }) => c);
}

function statusOf(world: World, box: string, loc: Location, idx: number): WorktreeStatus {
  const wt = loc.worktrees![idx];
  const g = wt.main ? { ahead: 0, behind: 0, changed: 0, untracked: 0 } : gitOf(box, loc.name, wt.name);
  const last = commits(box, loc.name, wt.name, wt.branch, 1)[0];
  const sessions = (world.sessions[box] ?? []).filter((s) => s.dir === wt.path && !s.exited).length;
  const published = !!wt.main || !!g.published;
  return {
    location: loc.name,
    name: wt.name,
    title: wt.title,
    path: wt.path,
    remote: loc.remote,
    branch: wt.branch,
    main: wt.main,
    port: 3000 + idx * 10 + (box === "gpu" ? 800 : 0),
    base: "origin/main",
    ahead: g.ahead,
    behind: g.behind,
    upstream: published && wt.branch ? `origin/${wt.branch}` : undefined,
    outgoing: g.outgoing ?? g.ahead,
    incoming: g.incoming ?? 0,
    published,
    changed: g.changed,
    untracked: g.untracked,
    last_commit: last,
    paused: !wt.main && !!g.paused,
    sessions,
  };
}

// commitDetail answers the history sheet's `git show` for one commit: its
// message (with a body for some) and a stat. Other commands fall through.
function commitDetail(box: string, req: { location: string; command: string }, locs: Location[], delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  const sha = /^git show -s --format=%B '([0-9a-f]+)'/.exec(req.command)?.[1];
  if (!sha) return undefined;
  const [locName, wtName] = req.location.split("/");
  const loc = locs.find((l) => l.name === locName);
  const wt = loc?.worktrees?.find((w) => (wtName ? w.name === wtName : w.main));
  const c = loc && wt ? history(box, loc.name, wt.name, wt.branch).find((n) => n.sha === sha) : undefined;
  if (!c) return delay({ exit_code: 128, output: `fatal: bad object ${sha}\n` });
  const seed = parseInt(sha.slice(0, 6), 16);
  const body = c.parents.length > 1 ? "" : seed % 3 === 0 ? "" : `${["Keeps the old path working while the new one rolls out.", "Found while chasing a flaky e2e run; the fix is small."][seed % 2]}\n\nCo-authored-by: Claude <noreply@anthropic.com>`;
  const files = 1 + (seed % 9);
  const stat = ` ${files} file${files === 1 ? "" : "s"} changed, ${(seed % 180) + 4} insertions(+), ${seed % 61} deletions(-)`;
  return new Promise((r) => setTimeout(() => r({ exit_code: 0, output: `${c.subject}\n\n${body}\n\n--berth-stat--\n${stat}\n` }), 250));
}

// worktreesCall answers the worktree status, log, sync and pause routes, or
// returns undefined for anything else.
export function worktreesCall(box: string, method: string, path: string, body: unknown, world: World, emit: Emit, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  const [route, query = ""] = path.split("?");
  const locs = world.locations[box] ?? [];
  if (method === "POST" && route === "exec") return commitDetail(box, body as { location: string; command: string }, locs, delay);
  if (method === "GET" && route === "worktrees") {
    const only = new URLSearchParams(query).get("location");
    return delay(locs.filter((l) => !only || l.name === only).flatMap((l) => (l.worktrees ?? []).map((_, i) => statusOf(world, box, l, i))));
  }
  const m = route.match(/^locations\/([^/]+)\/worktrees\/([^/]+)\/(log|sync|pause|resume)$/);
  if (!m) return undefined;
  const [locName, wtName, action] = [decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3]];
  const loc = locs.find((l) => l.name === locName);
  const idx = loc?.worktrees?.findIndex((w) => w.name === wtName) ?? -1;
  if (!loc || idx < 0) return Promise.reject(new Error("no worktree with that name"));
  const wt = loc.worktrees![idx];
  const g = gitOf(box, loc.name, wt.name);

  if (action === "log" && method === "GET") {
    const q = new URLSearchParams(query);
    return delay({ base: "origin/main", commits: commits(box, loc.name, wt.name, wt.branch, Number(q.get("limit") ?? 50), q.get("graph") === "1") });
  }
  if (action === "sync" && method === "POST") {
    const mode = ((body as { mode?: SyncMode })?.mode ?? "rebase") as SyncMode;
    let res: SyncResult;
    if (wt.main) res = { mode, base: "origin/main", ok: true, output: "Already up to date.", ahead: 0, behind: 0 };
    else if (mode === "pull" && g.ahead > 0) res = { mode, base: "origin/main", ok: false, output: "fatal: Not possible to fast-forward, aborting.", ahead: g.ahead, behind: g.behind };
    else if (g.conflicts && g.behind > 0 && mode !== "pull") {
      res = {
        mode,
        base: "origin/main",
        ok: false,
        output: `CONFLICT (content): Merge conflict in ${g.conflicts[0]}\nerror: could not apply 3f2a91c… ${g.subjects?.[0] ?? ""}\n${mode === "rebase" ? "git rebase --abort" : "git merge --abort"}: the worktree is as it was.`,
        conflicts: g.conflicts,
        ahead: g.ahead,
        behind: g.behind,
      };
    } else {
      if (mode === "merge" && g.behind > 0) g.ahead += 1;
      const was = g.behind;
      g.behind = 0;
      res = { mode, base: "origin/main", ok: true, output: was ? `Successfully ${mode === "rebase" ? "rebased" : mode === "merge" ? "merged" : "fast-forwarded"} onto origin/main (${was} new commits).` : "Already up to date.", ahead: g.ahead, behind: 0 };
    }
    emit({ type: "worktree.synced", box, data: { location: loc.name, name: wt.name, mode, ok: res.ok, base: res.base } });
    return new Promise((r) => setTimeout(() => r(structuredClone(res)), 500 + Math.random() * 500));
  }
  if ((action === "pause" || action === "resume") && method === "POST") {
    if (wt.main) return Promise.reject(new Error("the main checkout can't be paused"));
    g.paused = action === "pause";
    emit({ type: `worktree.${action === "pause" ? "paused" : "resumed"}`, box, data: { location: loc.name, name: wt.name, path: wt.path } });
    return delay(statusOf(world, box, loc, idx));
  }
  return undefined;
}
