import { expect, mockOnly, test } from "./fixtures";

// A worktree's display name (lib/worktree-names.ts): a label shown in its
// name's place, kept on the box, its branch and folder untouched. The
// fixtures have one named after a pasted link, https-linear-app-acme on
// devl, and gpu runs a berthd too old to keep names.

const SLUG = "devl/https-linear-app-acme";

test("renamed from its menu, it is called by the new name everywhere, and ⌘K still finds its own", async ({ app }) => {
  mockOnly();
  await app.open({ params: { view: "conversation" } });
  const page = app.page;
  const row = app.worktree(SLUG);
  await expect(row).toContainText("https-linear-app-acme");

  // Rename… in its menu turns the row into a field, which says the branch
  // stays as it is and offers the name its agent's task gives.
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename…/ }).click();
  const field = page.getByRole("textbox", { name: "Display name for https-linear-app-acme" });
  await expect(field).toBeFocused();
  await expect(page.getByTestId("worktree-rename")).toContainText("The branch stays https-linear-app-acme.");
  await page.getByRole("button", { name: /Use “Fix the cart badge after a refund”/ }).click();
  await expect(field).toHaveValue("Fix the cart badge after a refund");
  await field.fill("Cart badge after refund");
  await field.press("Enter");

  // The sidebar, with its own name kept in the tip.
  await expect(row).toHaveAttribute("data-title", "Cart badge after refund");
  await expect(row).toContainText("Cart badge after refund");
  await row.hover();
  await expect(page.locator("[data-slot=tooltip-popup]")).toContainText("https-linear-app-acme");

  // Opened: the status bar, the breadcrumb and the window's title.
  await row.click();
  await expect(page.getByTestId("status-worktree")).toHaveText("Cart badge after refund");
  await expect(page).toHaveTitle("shop / Cart badge after refund — Shipyard");

  // A tab group of it beside another worktree (⌥-click) is called by it.
  await app.worktree("devl/search-perf").click({ modifiers: ["Alt"] });
  await expect(page.locator('[data-group-label="devl:/home/me/work/shop-https-linear-app-acme"]')).toContainText("Cart badge after refund");

  // ⌘K: by the new name, and by its own, which shows beside it.
  await page.getByRole("button", { name: /^Search/ }).click();
  const palette = page.getByPlaceholder("Jump to a session, worktree, or command…");
  await palette.fill("https-linear");
  const item = page.getByRole("option", { name: /^shop \/ Cart badge after refund\s*https-linear-app-acme/ });
  await expect(item).toBeVisible();
  await palette.fill("cart badge after");
  await expect(item).toBeVisible();
  await page.keyboard.press("Escape");

  // Kept on the box (PATCH …/worktrees/{name}): nothing is saved on this laptop.
  expect(await app.stored("berth.worktreeTitles")).toBeNull();
});

test("F2 and double-click rename in place; Esc leaves it, and an empty name shows its own again", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  const row = app.worktree(SLUG);

  // F2 on the focused row; Esc puts it back unchanged.
  await row.focus();
  await page.keyboard.press("F2");
  const field = page.getByRole("textbox", { name: "Display name for https-linear-app-acme" });
  await expect(field).toBeFocused();
  await field.fill("Not this");
  await field.press("Escape");
  await expect(field).toBeHidden();
  await expect(row).not.toHaveAttribute("data-title");
  await expect(row).toContainText("https-linear-app-acme");

  // Double-click, name it.
  await row.dblclick();
  await expect(field).toBeFocused();
  await field.fill("Refund badge");
  await field.press("Enter");
  await expect(row).toHaveAttribute("data-title", "Refund badge");

  // Its menu offers its own name back; so does an emptied field.
  await row.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Show as https-linear-app-acme" })).toBeVisible();
  await page.keyboard.press("Escape");
  await row.dblclick();
  await expect(field).toHaveValue("Refund badge");
  await field.fill("");
  await field.press("Enter");
  await expect(row).not.toHaveAttribute("data-title");
  await expect(row).toContainText("https-linear-app-acme");
});

test("the folded rail renames from a tile's menu or F2, and its card says both names", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await page.getByRole("button", { name: "Hide the sidebar" }).click();
  const rail = page.getByRole("navigation", { name: "Agents" });
  const tile = rail.locator('[data-testid=rail-agent][data-session="devl/checkout-fix-claude"]');
  await expect(tile).toContainText("checkout-fix");

  await tile.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Rename worktree…/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("The branch stays me/checkout-fix.");
  await dialog.getByRole("textbox").fill("Webhook retries");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  await expect(tile).toContainText("Webhook retries");
  await expect(tile).toHaveAccessibleName(/in shop \/ Webhook retries on devl/);
  await tile.hover();
  const card = page.getByTestId("rail-card");
  await expect(card).toContainText("shop / Webhook retries");
  await expect(card).toContainText("checkout-fix");

  // F2 on a focused tile asks too.
  await tile.focus();
  await page.keyboard.press("F2");
  await expect(dialog.getByRole("textbox")).toHaveValue("Webhook retries");
  await page.keyboard.press("Escape");
});

test("a box too old to keep names keeps it on this laptop, says so once, and it survives a reload", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  const row = app.worktree("gpu/ci-flake");
  await row.dblclick();
  const field = page.getByRole("textbox", { name: "Display name for ci-flake" });
  await expect(page.getByTestId("worktree-rename")).toContainText("Kept on this laptop: gpu is older.");
  await field.fill("Ledger move");
  await field.press("Enter");
  await expect(row).toHaveAttribute("data-title", "Ledger move");
  await expect(page.getByText("Named on this laptop only")).toBeVisible();
  expect(await app.stored("berth.worktreeTitles")).toEqual({ gpu: { "/home/me/shop-ci-flake": "Ledger move" } });

  await page.reload();
  await expect(app.worktree("gpu/ci-flake")).toHaveAttribute("data-title", "Ledger move");
});
