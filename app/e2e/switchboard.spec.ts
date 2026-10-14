import { expect, mockOnly, test } from "./fixtures";

test("Switchboard keeps focused work, pickup notes and areas across a reload", async ({ app }) => {
  mockOnly();
  await app.open();
  const page = app.page;
  await page.getByRole("button", { name: /Open Switchboard/ }).click();
  const board = page.getByRole("dialog", { name: "Switchboard" });
  await expect(board).toBeVisible();

  const title = "Fix checkout webhook retries";
  const row = board.locator("article").filter({ hasText: title });
  await row.getByRole("button", { name: `Add ${title} to Focus` }).click();
  await expect(board.getByRole("heading", { name: /Focus/ })).toBeVisible();
  const card = board.locator("article").filter({ hasText: title });
  await card.getByRole("button", { name: "Add pickup note…" }).click();
  await card.getByRole("textbox", { name: `Pickup note for ${title}` }).fill("Decide whether to run the migration");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card).toContainText("Decide whether to run the migration");

  await board.getByRole("button", { name: "Area", exact: true }).click();
  await board.getByRole("textbox", { name: "Area name" }).fill("Launch");
  await board.getByRole("button", { name: "Add", exact: true }).click();
  await card.getByRole("combobox", { name: `Area for ${title}` }).selectOption("Launch");
  await board.getByRole("button", { name: "Launch", exact: true }).click();
  await expect(board.locator("article").filter({ hasText: title })).toBeVisible();

  await page.reload();
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const reopened = page.getByRole("dialog", { name: "Switchboard" });
  await expect(reopened).toContainText("Decide whether to run the migration");
  await expect(reopened.getByRole("button", { name: `Remove ${title} from Focus` })).toBeVisible();
  await reopened.locator("article").filter({ hasText: title }).getByRole("button", { name: `${title} shop / checkout-fix` }).click();
  await expect(reopened).toBeHidden();
  await expect(page.getByTestId("status-worktree")).toContainText("checkout-fix");
});
