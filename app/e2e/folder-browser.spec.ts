import { expect, mockOnly, test } from "./fixtures";

test.beforeEach(() => mockOnly("the practice filesystem is a mock fixture"));

test("the Windows folder browser uses Windows paths and controls", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { platform: "windows" } });

  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitem", { name: "Add a project…" }).click();
  await page.getByLabel("Path, git URL, owner/repo or new name").fill("C:\\Users\\dev\\Projects\\shop");
  await page.getByRole("button", { name: "Browse" }).click();

  await expect(page.getByRole("heading", { name: "Browse folders" })).toBeVisible();
  await expect(page.getByLabel("Path")).toHaveValue("C:\\Users\\dev\\Projects");

  const crumbs = page.getByRole("navigation", { name: "Folder" });
  await expect(crumbs.getByRole("button").allTextContents()).resolves.toEqual(["C:", "Users", "dev", "Projects"]);
  await expect(page.getByText("Enter opens a folder or adds a repository")).toBeVisible();
  await expect(page.getByText("↵ opens a folder or adds a repository")).toHaveCount(0);

  await crumbs.getByRole("button", { name: "C:" }).click();
  await expect(page.getByLabel("Path")).toHaveValue("C:\\");
  await expect(page.getByRole("option", { name: "Users" })).toBeVisible();
});

test("the Windows folder browser can switch drives", async ({ app }) => {
  const { page } = app;
  await app.open({ params: { platform: "windows" } });

  await page.getByTestId("nav-more").click();
  await page.getByRole("menuitem", { name: "Add a project…" }).click();
  await page.getByRole("button", { name: "Browse" }).click();

  await page.getByLabel("Path").fill("E:\\Code");
  await page.getByLabel("Path").press("Enter");

  await expect(page.getByRole("option", { name: "New folder me/new-folder" })).toBeVisible();
  await expect(page.getByLabel("Path")).toHaveValue("E:\\Code");
  await expect(page.getByRole("navigation", { name: "Folder" }).getByRole("button").allTextContents()).resolves.toEqual(["E:", "Code"]);
});
