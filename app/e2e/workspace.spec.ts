import { agentWorktree, expect, live, mockOnly, test } from "./fixtures";

// The workspace: tabs, groups of worktrees, splits, and the panes a tab
// can hold.

test.beforeEach(async ({ app }) => {
  await app.open({ params: { view: "conversation" } });
});

test("⌥-click on a second worktree adds its tabs as a group", async ({ app }) => {
  mockOnly();
  await app.openWorktree("devl/checkout-fix");
  const strip = app.page.locator("[data-tab-strip]");
  await expect(strip.locator("[data-tab]").first()).toBeVisible();
  await expect(strip.locator("[data-group]")).toHaveCount(0);
  await app.worktree("devl/search-perf").click({ modifiers: ["Alt"] });
  const groups = strip.locator("[data-group]");
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0)).toHaveAttribute("data-group", "devl:/home/me/work/shop-checkout-fix");
  await expect(groups.nth(1)).toHaveAttribute("data-group", "devl:/home/me/work/shop-search-perf");
  // Each group's tabs are its own worktree's.
  await expect(groups.nth(1).locator("[data-tab]").first()).toHaveAttribute("data-ws", "devl:/home/me/work/shop-search-perf");
  // The new group comes to the front, showing its agent.
  await expect(app.chat.locator("[data-kind=artifact]").first()).toBeAttached();
});

test("a worktree dragged onto a pane's edge splits its agent in beside it", async ({ app }) => {
  mockOnly();
  await app.openWorktree("devl/checkout-fix");
  await expect(app.panes).toHaveCount(1);
  const area = (await app.page.locator("[data-pane-area]").boundingBox())!;
  const row = (await app.worktree("devl/search-perf").boundingBox())!;
  const m = app.page.mouse;
  await m.move(row.x + row.width / 2, row.y + row.height / 2);
  await m.down();
  // Past the drag threshold, then over the pane's right edge.
  await m.move(row.x + row.width / 2 + 20, row.y + row.height / 2, { steps: 4 });
  await m.move(area.x + area.width * 0.9, area.y + area.height * 0.5, { steps: 12 });
  // The overlay shows where it will land before letting go.
  const overlay = app.page.locator("[data-berth-overlay] > div");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("search-perf");
  await m.up();
  await expect(app.page.locator("[data-berth-overlay]")).toHaveCount(0);
  await expect(app.panes).toHaveCount(2);
  // Side by side: the new pane on the right.
  const [a, b] = await Promise.all([app.panes.nth(0).boundingBox(), app.panes.nth(1).boundingBox()]);
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(Math.abs(a!.x - b!.x)).toBeGreaterThan(200);
  await expect(app.page.locator("[data-pane-area] [data-testid=chat]")).toHaveCount(2);
});

test("the Diff panel shows the worktree's changes", async ({ app }) => {
  mockOnly("the Diff panel runs its git script on the box");
  await app.openWorktree("devl/checkout-fix");
  await app.page.getByRole("button", { name: "New tab" }).click();
  await app.page.getByRole("option", { name: "Diff", exact: true }).click();
  const panel = app.page.locator("[data-testid=panel][data-panel^='diff/']:visible");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("me/fix-payment-retries");
  await expect(panel).toContainText("24 files");
  await expect(panel.getByText("retry.ts", { exact: true }).first()).toBeVisible();
  // The first file's diff, drawn and highlighted.
  await expect(panel.locator("diffs-container").first()).toBeAttached();
  await expect(panel.locator("diffs-container [style*='--diffs-token']").first()).toBeAttached();
  await expect(app.page.locator("[data-tab-strip] [data-tab]").filter({ hasText: "Diff" })).toBeVisible();
});

test("a browser tab shows a worktree's dev server in a frame", async ({ app }) => {
  const wt = await agentWorktree(app, "devl/checkout-fix");
  await app.openWorktree(wt);
  await app.page.getByRole("button", { name: "New tab" }).click();
  await app.page.getByRole("option", { name: /New browser tab/ }).click();
  const pane = app.page.locator("[data-testid=browser-pane]:visible");
  // Outside the Terminal app there is no native webview: the page is an iframe.
  await expect(pane).toHaveAttribute("data-mode", "iframe");
  if (live) return;
  // A port typed in the address bar opens that worktree's server through
  // the laptop's proxy (served here by a stand-in page).
  await expect(pane).toContainText("Running in this worktree");
  const address = pane.locator("form input").first();
  await address.fill("3001");
  await address.press("Enter");
  const frame = pane.locator("iframe");
  // The frame asks the proxy for the console script (internal/proxy/devtools.go).
  await expect(frame).toHaveAttribute("src", "http://checkout-fix.shop.devl.localhost:1377/?__berth_devtools=1");
  await expect(pane.frameLocator("iframe").getByRole("heading", { name: "Stub dev server" })).toBeVisible();
});
