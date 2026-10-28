import { expect, mockOnly, test } from "./fixtures";

// First run: what a new install, an older install and a person who turned
// Labs off each get (lib/prefs.ts migratePrefs).

type Saved = { labs?: boolean; labsChosen?: boolean; closeAgents?: string; version?: number };

test("a fresh install starts with Labs on and the harbour home", async ({ app }) => {
  await app.open();
  const prefs = (await app.stored("berth.prefs")) as Saved;
  expect(prefs).toMatchObject({ labs: true, labsChosen: false, closeAgents: "stop", version: 4 });
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
  await expect(app.page.getByRole("heading", { name: "What should your agents work on?" })).toBeVisible();
});

test("a fresh install gets the project rail", async ({ app }) => {
  await app.open({ params: { sidebar: "" } });
  await expect(app.page.getByTestId("project-rail")).toBeVisible();
  expect(((await app.stored("berth.prefs")) as { sidebarLayout?: string }).sidebarLayout).toBe("rail");
});

test("prefs an older Terminal saved move to this version's defaults", async ({ app }) => {
  // Version 2 saved Labs off and "keep" only as the defaults of the day.
  await app.open({ prefs: { labs: false, closeAgents: "keep", agentCloseTips: 2, version: 2 } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: true, version: 4 });
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
});

test("prefs from before version 2 drop the old close default too", async ({ app }) => {
  await app.open({ prefs: { labs: false, closeAgents: "keep" } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: true, closeAgents: "stop", agentCloseTips: 0, version: 4 });
});

test("Labs turned off in Settings stays off", async ({ app }) => {
  await app.open({ prefs: { labs: false, labsChosen: true, version: 3 } });
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: false, labsChosen: true });
  // Without Labs, the first place is the Agent Dashboard under its own name.
  await expect(app.page.getByTestId("nav-home")).toHaveText(/Agent Dashboard/);
  await expect(app.page.getByTestId("nav-dashboard")).toHaveCount(0);
});

test("Labs can be turned off and on in Settings", async ({ app }) => {
  await app.open();
  const labs = await app.openSettings("labs");
  const toggle = labs.getByRole("switch", { name: "Harbour home and conversations" });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect.poll(() => app.stored("berth.prefs")).toMatchObject({ labs: false, labsChosen: true });
  // Settings has the window; the sidebar is back once it closes.
  await app.leaveSettings();
  await expect(app.page.getByTestId("nav-home")).toHaveText(/Agent Dashboard/);
  await app.openSettings("labs");
  await toggle.click();
  await app.leaveSettings();
  await expect(app.page.getByTestId("nav-home")).toHaveText(/New task/);
});

test("a new account with no boxes is shown onboarding", async ({ app }) => {
  mockOnly("a new account is a mock fixture (?fresh)");
  await app.page.goto("/?mock=1&fresh=1");
  // Onboarding is the whole window until a box is added: no sidebar.
  await expect(app.page.getByTestId("nav-home")).toHaveCount(0);
  await expect(app.page.locator("main")).toContainText(/box/i);
});

test("Windows without WSL says how to set it up and checks again", async ({ app }) => {
  mockOnly("a Windows PC without WSL is a mock fixture (?thismac=nowsl&platform=windows)");
  await app.page.goto("/?mock=1&fresh=1&platform=windows&thismac=nowsl");
  const card = app.page.getByRole("region", { name: "Use this computer" });
  await expect(card).toBeVisible();
  await expect(card.getByText("wsl --install -d Ubuntu")).toBeVisible();
  await expect(card.getByRole("button", { name: "Check again" })).toBeEnabled();
  await expect(app.page.getByRole("button", { name: "Connect a box" })).toBeVisible();
});

test("Windows with WSL offers this computer as the box", async ({ app }) => {
  mockOnly("a Windows PC with WSL is a mock fixture (?platform=windows)");
  await app.page.goto("/?mock=1&fresh=1&platform=windows");
  await expect(app.page.getByRole("region", { name: "Use this computer" })).toContainText("Agents run in WSL");
  await expect(app.page.getByRole("button", { name: "Start on this computer" })).toBeEnabled();
});

test("Windows without a native agent reports the missing build instead of opening placeholders", async ({ app }) => {
  mockOnly("the missing Windows helper is a mock startup state");
  await app.page.goto("/?mock=offline&binary=missing&platform=windows");
  await expect(app.page.getByText("The Shipyard agent isn't running", { exact: true })).toBeVisible();
  await expect(app.page.getByText("This Windows build is missing Shipyard's local background service.")).toBeVisible();
  await expect(app.page.getByRole("button", { name: "Open guided workspace" })).toHaveCount(0);
  await expect(app.page.getByRole("button", { name: "Copy command" })).toBeVisible();
});

test("the Terminal tutorial explains the GitLab branch workflow and can be reopened", async ({ app }) => {
  mockOnly("the guided workspace uses the normal mock fixtures");
  await app.page.goto("/?mock=1&tutorial=1");

  await expect(app.page.getByRole("heading", { name: "Welcome to Terminal" })).toBeVisible();
  await expect(app.page.getByText("Terminal turns repository branches into a simple workflow you can scan without reading terminal logs.")).toBeVisible();
  await expect(app.page.getByText("This practice workspace is safe to explore. Actions stay here and do not change a real repository.")).toBeVisible();
  await app.page.getByRole("button", { name: "Show project activity" }).click();
  await expect(app.page.getByRole("heading", { name: "Connect your GitLab project" })).toBeVisible();
  await app.page.getByRole("button", { name: "Next" }).click();
  await expect(app.page.getByRole("heading", { name: "Read the Todo board" })).toBeVisible();
  await app.page.getByRole("button", { name: "Next" }).click();
  await expect(app.page.getByRole("heading", { name: "Follow every push and pull" })).toBeVisible();
  await app.page.getByRole("button", { name: "Next" }).click();
  await expect(app.page.getByRole("heading", { name: "Guide the agent to done" })).toBeVisible();
  await app.page.getByRole("button", { name: "Finish" }).click();
  await expect(app.page.getByRole("heading", { name: "Guide the agent to done" })).toHaveCount(0);

  await app.page.getByRole("button", { name: "Tutorial" }).click();
  await expect(app.page.getByRole("heading", { name: "Welcome to Terminal" })).toBeVisible();
});
