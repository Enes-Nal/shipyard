import type { Location } from "@/lib/api";
import type { ForgeView, MergeRequest } from "@/lib/forge-view";
import { forgeOf } from "@/lib/forge";

// The forge view in mock mode (?mock=1): a GitLab project's merge requests,
// pipelines and branches, made from its worktrees' branches so the GitLab
// tab and the board agree. ?forge=signedout is a box whose glab isn't
// signed in; ?forge=noglab one without glab.

const mode = new URLSearchParams(location.search).get("forge");
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const sha = (seed: string) => [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0").repeat(5);

export function mockForge(loc: Location): ForgeView {
  const forge = forgeOf(loc.remote);
  const def = loc.default_branch || "main";
  const tasks = (loc.worktrees ?? []).filter((w) => !w.main && w.branch);
  const branches = [
    { name: def, default: true, ahead: 0, behind: 0, last_commit: { sha: sha(def), short: sha(def).slice(0, 7), subject: "Merge branch 'rubric-scoring' into 'main'", author: "dana", time: minutesAgo(180) } },
    ...tasks.map((w, i) => ({
      name: w.branch!,
      ahead: 2 + i,
      behind: i,
      last_commit: { sha: sha(w.branch!), short: sha(w.branch!).slice(0, 7), subject: `wip: ${w.name.replace(/-/g, " ")}`, author: "me", time: minutesAgo(20 + i * 35) },
    })),
    { name: "me/cache-datasets", ahead: 2, behind: 4, last_commit: { sha: sha("cache"), short: sha("cache").slice(0, 7), subject: "Cache eval datasets between runs", author: "me", time: minutesAgo(300) } },
  ];
  const view: ForgeView = { kind: forge.kind, host: forge.host, merge_requests: [], pipelines: [], branches, fetched: new Date().toISOString() };
  if (forge.kind !== "gitlab") return view;
  if (mode === "signedout" || mode === "noglab") return { ...view, problem: mode === "signedout" ? "signed_out" : "glab_missing", detail: mode === "signedout" ? "glab: 401 Unauthorized" : "glab is not installed on this box" };

  const slug = loc.slug ?? "acme/evals";
  const web = `https://${forge.host ?? "gitlab.com"}/${slug}`;
  const statuses = ["running", "failed", "success"];
  const mrs: MergeRequest[] = [
    ...tasks.map((w, i) => ({ iid: 12 - i, title: titleOf(w.name), state: "opened", source_branch: w.branch!, target_branch: def, author: "me", url: `${web}/-/merge_requests/${12 - i}`, sha: sha(w.branch!), updated: minutesAgo(15 + i * 30) })),
    { iid: 10, title: "Draft: Cache eval datasets between runs", state: "opened", draft: true, source_branch: "me/cache-datasets", target_branch: def, author: "me", url: `${web}/-/merge_requests/10`, sha: sha("cache"), updated: minutesAgo(290) },
    { iid: 9, title: "Add rubric scoring", state: "merged", source_branch: "rubric-scoring", target_branch: def, author: "dana", url: `${web}/-/merge_requests/9`, sha: sha("rubric"), updated: minutesAgo(185) },
  ];
  const pipelines = [
    ...mrs.map((m, i) => ({ id: 400 - i, status: m.state === "merged" ? "success" : statuses[i % statuses.length], ref: m.source_branch, sha: m.sha!, url: `${web}/-/pipelines/${400 - i}`, updated: m.updated })),
    { id: 380, status: "success", ref: def, sha: sha(def), url: `${web}/-/pipelines/380`, updated: minutesAgo(178) },
  ];
  for (const m of mrs) m.pipeline = pipelines.find((p) => p.sha === m.sha);
  return { ...view, project: { path: slug, url: web, default_branch: def }, merge_requests: mrs, pipelines };
}

const titleOf = (name: string) => {
  const words = name.replace(/[-_/]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
