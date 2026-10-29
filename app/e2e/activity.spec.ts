import { expect, mockOnly, test } from "./fixtures";

// Project activity is the simple overview for work done by agents: task
// stage, forge, branch, commits, files and the branch's push/pull state.
test("Project activity visualizes GitLab branches and their agent and sync state", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await page.getByTestId("nav-worktrees").click();

  await expect(page.getByRole("heading", { name: "Project activity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect GitLab" })).toBeVisible();

  // Each project's own folder is on the board too, with the branch it is on.
  await expect(page.getByRole("region", { name: "Projects" })).toContainText("main folder");
  await expect(page.getByText("No tasks yet.")).toHaveCount(0);

  const todo = page.getByRole("region", { name: "Todo" });
  const doing = page.getByRole("region", { name: "In progress" });
  const done = page.getByRole("region", { name: "Done" });
  await expect(todo).toContainText("me/search-perf");
  await expect(doing).toContainText("me/checkout-fix");
  await expect(doing).toContainText("GitLab");
  await expect(doing).toContainText("2 to push");
  await expect(doing).toContainText("1 to pull");
  await expect(done).toContainText("me/ci-flake");
  await expect(done).toContainText("Synced");

  await page.getByRole("button", { name: "Branches" }).click();
  await expect(page.getByRole("checkbox", { name: "Select qa-deck" })).toBeVisible();
  await expect(app.stored("berth.activity.mode")).resolves.toBe("branches");
});
