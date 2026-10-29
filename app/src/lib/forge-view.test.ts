import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultPipeline, type ForgeView, mrForBranch, pipelineTone, problemCopy, timeline } from "./forge-view.ts";

const view = (over: Partial<ForgeView> = {}): ForgeView => ({ kind: "gitlab", merge_requests: [], pipelines: [], branches: [], fetched: "", ...over });

test("a pipeline's status reads as passed, failed, running or waiting", () => {
  assert.equal(pipelineTone("success"), "passed");
  assert.equal(pipelineTone("failed"), "failed");
  assert.equal(pipelineTone("running"), "running");
  assert.equal(pipelineTone("pending"), "waiting");
  assert.equal(pipelineTone("manual"), "waiting");
  assert.equal(pipelineTone("canceled"), "other");
  assert.equal(pipelineTone(undefined), "other");
});

test("a branch's merge request is its open one, else its latest", () => {
  const v = view({
    merge_requests: [
      { iid: 1, title: "old", state: "merged", source_branch: "fix", target_branch: "main", url: "", updated: "2026-01-01T00:00:00Z" },
      { iid: 2, title: "new", state: "merged", source_branch: "fix", target_branch: "main", url: "", updated: "2026-02-01T00:00:00Z" },
      { iid: 3, title: "open", state: "opened", source_branch: "feat", target_branch: "main", url: "", updated: "2026-01-01T00:00:00Z" },
    ],
  });
  assert.equal(mrForBranch(v, "fix")?.iid, 2);
  assert.equal(mrForBranch(v, "feat")?.iid, 3);
  assert.equal(mrForBranch(v, "none"), undefined);
  assert.equal(mrForBranch(undefined, "fix"), undefined);
});

test("the default branch's pipeline is its latest", () => {
  const v = view({
    project: { path: "acme/shop", url: "", default_branch: "main" },
    pipelines: [
      { id: 3, status: "running", ref: "fix", sha: "c", url: "", updated: "" },
      { id: 2, status: "success", ref: "main", sha: "b", url: "", updated: "" },
      { id: 1, status: "failed", ref: "main", sha: "a", url: "", updated: "" },
    ],
  });
  assert.equal(defaultPipeline(v)?.id, 2);
  assert.equal(defaultPipeline(view()), undefined);
});

test("a signed-out glab says to sign in, on the box's own GitLab", () => {
  assert.equal(problemCopy(view({ problem: "signed_out", host: "gitlab.com" }), "holy")?.command, "glab auth login");
  assert.equal(problemCopy(view({ problem: "signed_out", host: "git.acme.dev" }), "holy")?.command, "glab auth login --hostname git.acme.dev");
  assert.match(problemCopy(view({ problem: "glab_missing" }), "holy")!.title, /glab isn't installed on holy/);
  assert.match(problemCopy(view({ problem: "signed_out" }), "holy", true)!.text, /Run this in Ubuntu once/);
  assert.match(problemCopy(view({ problem: "signed_out" }), "devbox")!.text, /Run this on devbox once/);
  assert.equal(problemCopy(view({ problem: "failed", detail: "404 Project Not Found" }), "holy")?.text, "404 Project Not Found");
  assert.equal(problemCopy(view(), "holy"), undefined);
});

test("the timeline is every task's commits, newest first, with who made them", () => {
  const t = timeline(
    [
      { commits: [{ sha: "a", time: "2026-01-02T00:00:00Z" }, { sha: "b", time: "2026-01-01T00:00:00Z" }], agents: ["claude"] },
      { commits: [{ sha: "c", time: "2026-01-03T00:00:00Z" }, { sha: "a", time: "2026-01-02T00:00:00Z" }], agents: ["codex"] },
    ],
    3,
  );
  assert.deepEqual(
    t.map((x) => [x.item.sha, x.agents.join()]),
    [
      ["c", "codex"],
      ["a", "claude"],
      ["b", "claude"],
    ],
  );
});
