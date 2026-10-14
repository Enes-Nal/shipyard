import { expect, mockOnly, test } from "./fixtures";

// The built-in Canvas reuses the app's live panes and keeps its layout per
// worktree. The mock's acme shop has an agent, a service terminal and a web
// server in checkout-fix, so the default board is useful on first open.
test("canvas arranges live work and remembers edits", async ({ app }) => {
  mockOnly();
  await app.open();
  await app.openWorktree("devl/checkout-fix");
  await app.page.getByRole("button", { name: "More", exact: true }).click();
  await app.page.getByRole("menuitem", { name: "Canvas" }).click();

  const agent = app.page.locator('section[aria-label="Fix checkout webhook retries canvas node"]');
  const terminal = app.page.locator('section[aria-label="Next.js canvas node"]');
  const preview = app.page.locator('section[aria-label="Preview · 3001 canvas node"]');
  await expect(agent).toBeVisible();
  await expect(terminal).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(agent.getByTestId("chat")).toBeVisible();
  await expect(preview.locator("[data-testid=browser-pane]")).toBeVisible();

  await agent.getByRole("button", { name: "Show terminal" }).click();
  await expect(agent.getByRole("button", { name: "Show chat" })).toBeVisible();
  await agent.getByRole("button", { name: "Show chat" }).click();
  await expect(agent.getByTestId("chat")).toBeVisible();

  const before = await agent.boundingBox();
  expect(before).not.toBeNull();
  const header = agent.locator("header");
  const rect = await header.boundingBox();
  expect(rect).not.toBeNull();
  await app.page.mouse.move(rect!.x + 70, rect!.y + 20);
  await app.page.mouse.down();
  await app.page.mouse.move(rect!.x + 145, rect!.y + 75, { steps: 6 });
  await app.page.mouse.up();
  await expect.poll(async () => (await agent.boundingBox())?.x ?? 0).toBeGreaterThan(before!.x + 50);

  await agent.getByRole("button", { name: "Link from this node" }).click();
  await terminal.locator("header").click({ position: { x: 100, y: 18 } });
  const saved = await app.stored("berth.plugin.canvas.boards") as Record<string, { nodes: { id: string; x: number }[]; links: unknown[] }>;
  const board = Object.values(saved)[0];
  expect(board.links).toHaveLength(1);
  expect(board.nodes.find((n) => n.id === "session:devl:checkout-fix-claude")?.x).toBeGreaterThan(150);

  await app.page.reload();
  await app.page.getByRole("button", { name: "More", exact: true }).click();
  await app.page.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(agent).toBeVisible();
  await expect(app.page.getByRole("button", { name: "Remove visual link" })).toBeVisible();
  const restored = await app.stored("berth.plugin.canvas.boards") as typeof saved;
  expect(Object.values(restored)[0].links).toHaveLength(1);
  expect(Object.values(restored)[0].nodes.find((n) => n.id === "session:devl:checkout-fix-claude")?.x).toBeGreaterThan(150);

  await app.page.getByRole("button", { name: "Add node" }).click();
  await app.page.getByRole("menuitem", { name: "Preview · port 5555" }).click();
  const extra = app.page.locator('section[aria-label="Preview · 5555 canvas node"]');
  await expect(extra).toBeVisible();
  await extra.getByRole("button", { name: "Remove node" }).click();
  await expect(extra).toHaveCount(0);

  await app.page.getByRole("button", { name: "Remove visual link" }).click();
  const unlinked = await app.stored("berth.plugin.canvas.boards") as typeof saved;
  expect(Object.values(unlinked)[0].links).toHaveLength(0);
  await app.page.getByRole("button", { name: "Zoom in" }).click();
  await expect(app.page.getByText("110%", { exact: true })).toBeVisible();
  const position = await agent.boundingBox();
  await app.page.mouse.move(300, 830);
  await app.page.mouse.down();
  await app.page.mouse.move(370, 860, { steps: 5 });
  await app.page.mouse.up();
  await expect.poll(async () => (await agent.boundingBox())?.x ?? 0).toBeGreaterThan(position!.x + 55);

  await app.page.getByRole("button", { name: "Add node" }).click();
  await app.page.getByRole("menuitem", { name: "New terminal" }).click();
  await expect.poll(async () => {
    const saved = await app.stored("berth.plugin.canvas.boards") as typeof restored;
    return Object.values(saved)[0].nodes.length;
  }).toBe(4);
});

test("canvas combines worktrees and gives subagents their own nodes", async ({ app }) => {
  mockOnly();
  await app.open();
  await app.openWorktree("devl/checkout-fix");
  await app.page.getByRole("button", { name: "More", exact: true }).click();
  await app.page.getByRole("menuitem", { name: "Canvas" }).click();

  const board = app.page.getByRole("combobox", { name: "Canvas worktree" });
  const source = app.page.getByRole("combobox", { name: "Source worktree" });
  await expect(board).toHaveValue("devl:/home/me/work/shop-checkout-fix");
  await source.selectOption("devl:/home/me/work/shop-qa-deck");
  await app.page.getByRole("button", { name: "Add node" }).click();
  await app.page.getByRole("menuitem", { name: "Build the QA deck for the release" }).click();
  const otherAgent = app.page.locator('section[aria-label="Build the QA deck for the release canvas node"]');
  await expect(otherAgent).toBeVisible();
  await expect(otherAgent).toContainText("shop / qa-deck · devl");
  await expect(otherAgent.getByTestId("chat")).toBeVisible();
  await expect(app.page.locator('section[aria-label="Fix checkout webhook retries canvas node"]')).toContainText("shop / checkout-fix · devl");

  await app.page.getByRole("button", { name: "Add node" }).click();
  await app.page.getByRole("menuitem", { name: "Preview · port 4789" }).click();
  const otherPreview = app.page.locator('section[aria-label="Preview · 4789 canvas node"]');
  await expect(otherPreview).toContainText("shop / qa-deck · devl");

  await app.page.evaluate(() => {
    (window as unknown as { __berthCrew: { set(box: string, session: string, members: unknown[]): void } }).__berthCrew.set("devl", "checkout-fix-claude", [
      { id: "canvas-helper-1", name: "Explore: retry paths", state: "running", doing: "Reading retry.ts", ago: 25 },
    ]);
  });
  await source.selectOption("devl:/home/me/work/shop-checkout-fix");
  await expect.poll(async () => {
    await app.page.getByRole("button", { name: "Add node" }).click();
    const found = await app.page.getByRole("menuitem", { name: "retry paths" }).count();
    await app.page.keyboard.press("Escape");
    return found;
  }, { timeout: 12_000 }).toBe(1);
  await app.page.getByRole("button", { name: "Add node" }).click();
  await app.page.getByRole("menuitem", { name: "retry paths" }).click();
  const helper = app.page.locator('section[aria-label="retry paths canvas node"]');
  await expect(helper).toContainText("subagent");
  await expect(helper.getByTestId("helper")).toHaveAttribute("data-state", "running");
  await expect(helper.getByText("Read-only", { exact: true })).toBeVisible();
  await expect(app.page.getByTestId("canvas-links").locator("path")).toHaveCount(1);
  await expect(app.page.getByRole("button", { name: "Remove visual link" })).toHaveCount(0);

  await app.page.reload();
  await app.page.getByRole("button", { name: "More", exact: true }).click();
  await app.page.getByRole("menuitem", { name: "Canvas" }).click();
  await expect(otherAgent).toBeVisible();
  await expect(otherPreview).toBeVisible();
  await expect(helper).toBeVisible();
  await expect(app.page.getByTestId("canvas-links").locator("path")).toHaveCount(1);
  await expect(board).toHaveValue("devl:/home/me/work/shop-checkout-fix");
});
