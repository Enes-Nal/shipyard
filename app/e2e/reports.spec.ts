import { expect, mockOnly, test } from "./fixtures";

// When work an agent started ends, Terminal types a <berth-notification> into
// its session (internal/box/notify.go). The agent's chat draws each report
// as a card, never the tagged text and never as the person's prompt.

test.beforeEach(async ({ app }) => {
  await app.open({ params: { view: "conversation" } });
});

test("a report from Terminal reads as a card with a way to the agent", async ({ app }) => {
  mockOnly();
  await app.openWorktree("devl/order-export");
  const reports = app.chat.locator("[data-testid=chat-item][data-kind=report]");
  await expect(reports).toHaveCount(2);

  const done = app.chat.locator("[data-report=finished]");
  await expect(done).toContainText("search-perf");
  // The head agents' messages have (agent-message): a chip says how it went.
  await expect(done.locator("[data-chip]")).toHaveText("Finished");
  await expect(done).toContainText("+48");
  await expect(done).toContainText("−12");
  await expect(done).toContainText("Search is 3× faster");

  const waiting = app.chat.locator("[data-report=waiting]");
  await expect(waiting).toContainText("checkout-fix");
  await expect(waiting.locator("[data-chip]")).toHaveText("Needs you");
  await expect(waiting).toContainText("pnpm prisma migrate dev");

  // Never the tagged text, never a prompt of the person's.
  await expect(app.chat).not.toContainText("berth-notification");
  await expect(app.chat.locator("[data-kind=user]").filter({ hasText: "Search is 3×" })).toHaveCount(0);
  // The agent's reply to it follows, as its own turn.
  await expect(app.chat.getByText("The checkout fix needs you to allow its migration")).toBeVisible();

  // The answer opens in full; Open goes to the agent it is about.
  const more = done.getByRole("button", { expanded: false });
  await more.click();
  await expect(done.getByRole("button", { expanded: true })).toContainText("the bench and the migration are on the branch");
  await done.getByRole("button", { name: "Open" }).click();
  await expect(app.worktree("devl/search-perf")).toHaveAttribute("data-active", "true");
});
