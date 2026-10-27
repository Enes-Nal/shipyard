import type { Page } from "@playwright/test";

import { type App, expect, mockOnly, test } from "./fixtures";

// What's new (components/whats-new, lib/whats-new.ts): once after an
// update a note at the foot of the sidebar opens the card; a new install
// gets neither; Settings › About and ⌘K open the card again; its Show me
// buttons go where they say; it pages from the keyboard. Mock mode plays
// an update with ?version= (the release in lib/whats-new-releases.ts is
// 0.3.10) and prefs saved by the version before.

const UPDATED = { prefs: { whatsNewSeen: "0.3.9", version: 3 }, params: { version: "0.3.10" } };

test.beforeEach(() => mockOnly("plays an update with the mock's ?version="));

const card = (page: Page) => page.getByRole("dialog", { name: "What's new" });
const nudge = (page: Page) => page.getByTestId("whats-new-nudge");

async function fromAbout(app: App) {
  await app.openSettings("about");
  const button = app.page.getByTestId("about-whats-new");
  await button.click();
  await expect(card(app.page)).toBeVisible();
  return button;
}

async function fromPalette(page: Page) {
  await page.keyboard.press("Meta+k");
  await page.getByRole("combobox").fill("what's new");
  await page.getByRole("option", { name: "What's new in Terminal" }).click();
  await expect(card(page)).toBeVisible();
}

test("a new install shows nothing and counts this version as seen", async ({ app }) => {
  await app.open({ params: { version: "0.3.10" } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ whatsNewSeen: "0.3.10" });
  await expect(nudge(app.page)).toHaveCount(0);
  await expect(card(app.page)).toHaveCount(0);
});

test("after an update, a note opens the card, once", async ({ app }) => {
  await app.open(UPDATED);
  await expect(nudge(app.page)).toContainText("New in Terminal 0.3.10");
  // Quiet: nothing covers the app until the note is clicked.
  await expect(card(app.page)).toHaveCount(0);
  await nudge(app.page).getByRole("button", { name: "See what's new" }).click();
  await expect(card(app.page)).toBeVisible();
  await expect(card(app.page).getByRole("tab")).toHaveCount(6);
  await expect(nudge(app.page)).toHaveCount(0);
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ whatsNewSeen: "0.3.10" });
  await app.page.keyboard.press("Escape");
  await expect(card(app.page)).toHaveCount(0);

  // Started again: seen.
  await app.page.reload();
  await expect(app.page.getByTestId("nav-home")).toBeVisible();
  await app.page.waitForTimeout(1500);
  await expect(nudge(app.page)).toHaveCount(0);
  await expect(card(app.page)).toHaveCount(0);
});

test("the note's × puts it away for good; an unanswered note comes back", async ({ app }) => {
  await app.open(UPDATED);
  await expect(nudge(app.page)).toBeVisible();
  // Not acted on: it is there again next time.
  await app.page.reload();
  await expect(nudge(app.page)).toBeVisible();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ whatsNewSeen: "0.3.9" });
  await nudge(app.page).getByRole("button", { name: "Dismiss" }).click();
  await expect(nudge(app.page)).toHaveCount(0);
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ whatsNewSeen: "0.3.10" });
  await app.page.reload();
  await expect(app.page.getByTestId("nav-home")).toBeVisible();
  await app.page.waitForTimeout(1500);
  await expect(nudge(app.page)).toHaveCount(0);
});

test("with the sidebar folded the card opens by itself", async ({ app }) => {
  // Folded, the sidebar has no Home for app.open to wait on.
  await app.context.addInitScript((prefs) => localStorage.getItem("berth.prefs") ?? localStorage.setItem("berth.prefs", prefs), JSON.stringify({ ...UPDATED.prefs, sidebarCollapsed: true }));
  await app.page.goto("/?mock=1&version=0.3.10");
  await expect(card(app.page)).toBeVisible();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ whatsNewSeen: "0.3.10" });
});

test("Settings › About and ⌘K open it again, and closing gives the keyboard back", async ({ app }) => {
  await app.open();
  const about = await fromAbout(app);
  await expect(card(app.page).getByRole("heading", { name: "Artifacts" })).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(card(app.page)).toHaveCount(0);
  await expect(about).toBeFocused();

  await fromPalette(app.page);
  await card(app.page).getByRole("button", { name: "Close" }).click();
  await expect(card(app.page)).toHaveCount(0);
});

test("it pages from the keyboard, and Tab stays in it", async ({ app }) => {
  await app.open();
  await fromAbout(app);
  const page = app.page;
  const tab = (name: string) => card(page).getByRole("tab", { name });
  await expect(tab("Artifacts")).toHaveAttribute("aria-selected", "true");
  // → and ← page from anywhere in the card.
  await page.keyboard.press("ArrowRight");
  await expect(tab("Visual diffs")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(tab("Console and network")).toHaveAttribute("aria-selected", "true");
  // A key hint where there is one.
  await expect(card(page).getByText("⌘⌥I", { exact: true }).last()).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tab("Visual diffs")).toHaveAttribute("aria-selected", "true");
  // In the list, ↓ and ↑ move too.
  await tab("Visual diffs").focus();
  await page.keyboard.press("ArrowDown");
  await expect(tab("Console and network")).toBeFocused();
  await expect(tab("Console and network")).toHaveAttribute("aria-selected", "true");
  // Next to the end, where it is Done.
  for (let i = 0; i < 3; i++) await card(page).getByRole("button", { name: "Next" }).click();
  await expect(tab("Quicker and steadier")).toHaveAttribute("aria-selected", "true");
  await expect(card(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  // Focus stays in the card. Base UI's focus guards at its edges hand it
  // back a moment after Tab lands on them.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(() => page.evaluate(() => (document.activeElement?.closest("[role=dialog]") ? "in" : document.activeElement?.outerHTML.slice(0, 120)))).toBe("in");
  }
  await card(page).getByRole("button", { name: "Done" }).click();
  await expect(card(page)).toHaveCount(0);
});

test("Show me opens the board, a visual diff, the console and a rename", async ({ app }) => {
  await app.open();
  const page = app.page;
  await app.openWorktree("devl/search-perf");

  // Artifacts: the worktree's board.
  await fromPalette(page);
  await card(page).getByRole("button", { name: "Open the board" }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator("[data-testid=pane][data-pane-kind=artifact]:visible")).toBeVisible();
  await expect(page.locator("[data-tab-strip] [data-tab]").filter({ hasText: "Artifacts" })).toBeVisible();

  // Visual diffs: the newest that found changes (the newer one against the
  // accepted baseline found none).
  await fromPalette(page);
  await page.keyboard.press("ArrowRight");
  await card(page).getByRole("button", { name: "Open a visual diff" }).click();
  await expect(page.locator("[data-tab-strip] [data-tab]").filter({ hasText: "vs main" })).toBeVisible();

  // Console and network: a Browser tab on the dev server, its drawer open.
  await app.openWorktree("devl/checkout-fix");
  await fromPalette(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await card(page).getByRole("button", { name: "Open the console" }).click();
  const browser = page.locator("[data-testid=browser-pane]:visible");
  await expect(browser).toBeVisible();
  await expect(browser.getByRole("textbox", { name: "Address" })).toHaveValue(/checkout-fix|3001/);
  await expect(page.getByTestId("devtools-drawer")).toBeVisible();

  // Display names: the worktree you are in; its row turns into its name field.
  await fromPalette(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await card(page).getByRole("button", { name: "Rename checkout-fix" }).click();
  await expect(page.getByRole("textbox", { name: "Display name for checkout-fix" })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("from Home, Show me renames the worktree with the hardest name to read", async ({ app }) => {
  await app.open();
  await fromAbout(app);
  for (let i = 0; i < 3; i++) await app.page.keyboard.press("ArrowRight");
  await card(app.page).getByRole("button", { name: "Rename https-linear-app-acme" }).click();
  await expect(app.page.getByRole("textbox", { name: "Display name for https-linear-app-acme" })).toBeFocused();
});

test("an item with no place in the app offers its guide", async ({ app }) => {
  await app.open();
  await fromAbout(app);
  const page = app.page;
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  // Messages from other agents has no place of its own: its guide.
  await expect(card(page).getByRole("button", { name: "Read the guide" })).toBeVisible();
});
