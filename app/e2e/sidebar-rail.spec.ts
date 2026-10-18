import { expect, mockOnly, test } from "./fixtures";

// The rail sidebar, the default layout (components/sidebar/rail-layout.tsx):
// the places and a tile per project on a narrow rail, and the picked
// project's worktrees on a sheet beside it. On the mock fixtures: shop has
// an agent waiting for you, evals one at work, and notes nothing going on.

const rail = { sidebarLayout: "rail" };

test("every project is a tile on the rail that says when it needs you or works", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await expect(page.getByTestId("project-rail")).toBeVisible();
  const tiles = page.getByTestId("rail-project");
  await expect(tiles).toHaveCount(3);
  await expect(page.locator("[data-testid=rail-project][data-project=shop]")).toHaveAttribute("data-state", "waiting");
  await expect(page.locator("[data-testid=rail-project][data-project=evals]")).toHaveAttribute("data-state", "running");
  await expect(page.locator("[data-testid=rail-project][data-project=notes]")).not.toHaveAttribute("data-state");
  // A project with no GitHub owner gets an identicon, never an empty tile.
  await expect(page.locator("[data-testid=rail-project] :is([data-testid=project-avatar], [data-testid=project-identicon])")).toHaveCount(3);
});

test("picking a tile shows that project's worktrees beside the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  const shop = page.locator("[data-testid=rail-project][data-project=shop]");
  await shop.click();
  await expect(shop).toHaveAttribute("aria-current", "true");
  const sheet = page.getByTestId("sidebar").getByRole("region", { name: "shop", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-testid=worktree-row][data-worktree="devl/checkout-fix"]')).toBeVisible();
  // Another project's worktrees stay off the sheet.
  await expect(app.worktree("gpu/judge-v2")).toHaveCount(0);

  await page.locator("[data-testid=rail-project][data-project=notes]").click();
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true }).getByTestId("tasks-empty")).toContainText("No tasks here yet.");
});

test("opening a worktree from elsewhere picks its project on the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=notes]").click();
  await expect(page.getByTestId("sidebar").getByRole("region", { name: "notes", exact: true })).toBeVisible();

  // From the folded sidebar's agents.
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  await page.locator('[data-testid=rail-agent][data-session="devl/checkout-fix-claude"]').click();
  await page.getByRole("button", { name: /Show the sidebar/ }).click();

  await expect(page.locator("[data-testid=rail-project][data-project=shop]")).toHaveAttribute("aria-current", "true");
  await expect(app.worktree("devl/checkout-fix")).toHaveAttribute("data-active", "true");
});

test("the rail's places and Settings go where the sidebar's do", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  const rail_ = page.getByTestId("project-rail");
  await expect(rail_.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await rail_.getByTestId("nav-review").click();
  await expect(rail_.getByTestId("nav-review")).toHaveAttribute("aria-current", "page");
  await rail_.getByTestId("nav-settings").click();
  await expect(rail_.getByTestId("nav-settings")).toHaveAttribute("aria-current", "page");
});

test("an update moves the list sidebar to the rail", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: { version: 3, sidebarLayout: "list" } });
  await expect(app.page.getByTestId("project-rail")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { sidebarLayout: string }).sidebarLayout).toBe("rail");
});

test("an update keeps a two-column sidebar someone chose", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: { version: 3, sidebarLayout: "columns" } });
  await expect(app.page.getByTestId("sidebar-projects")).toBeVisible();
  await expect(app.page.getByTestId("project-rail")).toHaveCount(0);
});

test("the sheet's boxes, their contents and their ends each line up", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  await page.locator("[data-testid=rail-project][data-project=shop]").click();
  await expect(app.worktree("devl/checkout-fix")).toBeVisible();
  const lanes = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-testid=sidebar-sheet]")!.getBoundingClientRect();
      const q = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const row = document.querySelector("[data-testid=worktree-row]")!;
      const label = [...document.querySelectorAll("[data-testid=sidebar-sheet] h3")].find((h) => h.textContent === "Worktrees")!;
      const left = (r: DOMRect) => Math.round(r.left - sheet.left);
      const right = (r: DOMRect) => Math.round(sheet.right - r.right);
      return {
        boxes: [left(q("[data-testid=tasks-heading] > span")), left(q("[data-testid=sheet-search]")), left(row.getBoundingClientRect()), left(q("[data-testid=sidebar-boxes]"))],
        contents: [left(q("[data-testid=sheet-search] svg")), left(label.getBoundingClientRect()), left(row.querySelector("[role=img]")!.getBoundingClientRect()), left(q("[data-testid=sidebar-boxes] > span"))],
        ends: [right(q("[data-testid=sheet-search]")), right(label.parentElement!.querySelector("button")!.getBoundingClientRect()), right(row.getBoundingClientRect())],
      };
    });
  const same = (xs: number[]) => xs.every((x) => x === xs[0]);
  await expect.poll(async () => { const l = await lanes(); return same(l.boxes) && same(l.contents) && same(l.ends); }).toBe(true);
});

test("the sheet's top edge carries on the tab bar's bottom line", async ({ app }) => {
  mockOnly();
  await app.open({ prefs: rail });
  const page = app.page;
  const lined = () =>
    page.evaluate(() => {
      const sheet = document.querySelector("[data-testid=sidebar-sheet]")!.getBoundingClientRect();
      const bar = document.querySelector("[data-tab-bar]")!.getBoundingClientRect();
      return Math.round(sheet.top) === Math.round(bar.bottom - 1);
    });
  await expect.poll(lined).toBe(true);
  // At a larger text size too (⌘+ twice), since both are sized in rem.
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(() => app.stored("berth.prefs").then((p) => (p as { uiFontSize: number }).uiFontSize)).toBe(15);
  await expect.poll(lined).toBe(true);
});
