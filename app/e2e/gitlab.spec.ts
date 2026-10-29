import { expect, mockOnly, test } from "./fixtures";

// The GitLab tab of Project activity: each project's merge requests with
// their pipelines and agents, what agents committed, its pipelines and
// origin's branches, all read on the box through glab.
test("the GitLab tab shows merge requests, pipelines, branches and who committed what", async ({ app }) => {
  mockOnly("the forge view is a mock fixture");
  await app.open();
  const page = app.page;
  await page.getByTestId("nav-worktrees").click();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();

  const evals = page.getByRole("region", { name: "evals on GitLab" });
  const mrs = evals.getByRole("region", { name: "Merge requests" });
  const judge = mrs.getByRole("listitem", { name: /!12 Judge v2/ });
  await expect(judge).toContainText("judge-v2 → main");
  await expect(judge).toContainText("Running");
  await expect(judge).toContainText("Claude Code");
  await expect(judge.getByRole("button", { name: "Open task" })).toBeVisible();
  await expect(mrs.getByRole("listitem", { name: /!10 Draft/ })).toContainText("Failed");
  await expect(mrs.getByRole("listitem", { name: /!9 Add rubric scoring/ })).toContainText("Merged");

  await expect(evals.getByRole("region", { name: "Pipelines" })).toContainText("me/cache-datasets");
  await expect(evals.getByRole("region", { name: "What agents committed" })).toContainText("Claude Code");
  const branches = evals.getByRole("region", { name: "Branches on origin" });
  await expect(branches.getByRole("listitem", { name: "Branch main" })).toContainText("default");
  await expect(branches.getByRole("listitem", { name: "Branch me/cache-datasets" }).getByRole("button", { name: "Work on it" })).toBeVisible();

  // A project on GitHub keeps its branches, and says why there's no more.
  await expect(page.getByRole("region", { name: "notes on GitLab" })).toContainText("notes isn't on GitLab");
  await expect(app.stored("berth.activity.mode")).resolves.toBe("gitlab");

  // The board's card for the branch has its merge request and pipeline.
  await page.getByRole("button", { name: "Todo board" }).click();
  const doing = page.getByRole("region", { name: "In progress" });
  await expect(doing.getByRole("button", { name: "!12" })).toBeVisible();
});

test("a box whose glab isn't signed in says how to sign in", async ({ app }) => {
  mockOnly("a signed-out glab is a mock fixture (?forge=signedout)");
  await app.page.goto("/?mock=1&forge=signedout");
  const page = app.page;
  await page.getByTestId("nav-worktrees").click();
  await page.getByRole("button", { name: "GitLab", exact: true }).click();
  const evals = page.getByRole("region", { name: "evals on GitLab" });
  await expect(evals.getByRole("alert")).toContainText("Sign in to GitLab on gpu");
  await expect(evals.getByRole("alert")).toContainText("glab auth login");
  await expect(evals.getByRole("region", { name: "Merge requests" })).toHaveCount(0);
  await expect(evals.getByRole("region", { name: "Branches on origin" })).toBeVisible();
});
