import { expect, mockOnly, test } from "./fixtures";

// Structured agents left Labs (lib/prefs-migrate.ts, version 4): on by
// default, turned off in Settings › Agents, with Permissions beside it.

type Saved = { structuredClaude?: boolean; approvals?: string; version?: number };

test("agents run in chat by default, and Labs no longer has the switch", async ({ app }) => {
  await app.open();
  await expect.poll(() => app.stored("berth.prefs") as Promise<Saved>).toMatchObject({ structuredClaude: true, version: 4 });
  const labs = await app.openSettings("labs");
  await expect(labs.getByRole("switch", { name: "Harbour home and conversations" })).toBeVisible();
  await expect(labs.getByText("Structured agents")).toHaveCount(0);
  await expect(labs.getByText("Permissions", { exact: true })).toHaveCount(0);
  const agents = await app.openSettings("agents");
  await expect(agents.getByRole("switch", { name: "Run agents in chat" })).toBeChecked();
  await expect(agents.getByText("Permissions", { exact: true })).toBeVisible();
});

test("structured agents an older Shipyard saved off are turned on once", async ({ app }) => {
  await app.open({ prefs: { structuredClaude: false, approvals: "ask", version: 3 } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ structuredClaude: true, approvals: "ask", version: 4 });
  const agents = await app.openSettings("agents");
  await expect(agents.getByRole("switch", { name: "Run agents in chat" })).toBeChecked();
});

test("running agents in their terminals is kept once chosen", async ({ app }) => {
  await app.open();
  const agents = await app.openSettings("agents");
  const toggle = agents.getByRole("switch", { name: "Run agents in chat" });
  await toggle.click();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ structuredClaude: false, version: 4 });
  // Permissions are for agents in chat: gone while they run in terminals.
  await expect(agents.getByText("Permissions", { exact: true })).toHaveCount(0);
  await app.page.reload();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ structuredClaude: false, version: 4 });
  const again = await app.openSettings("agents");
  await expect(again.getByRole("switch", { name: "Run agents in chat" })).not.toBeChecked();
});

test("an agent running in chat opens as its conversation with Labs off", async ({ app }) => {
  mockOnly("the demo's structured session is a mock fixture (?structured)");
  // ?structured: search-perf's Claude runs through its stream.
  await app.open({ prefs: { labs: false, labsChosen: true, version: 4 }, params: { structured: "1" } });
  await app.openWorktree("devl/search-perf");
  await expect(app.chat).toBeVisible();
  await expect(app.composer.getByRole("textbox", { name: "Reply" })).toBeVisible();
});
