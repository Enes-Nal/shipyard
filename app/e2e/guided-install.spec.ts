import type { Page } from "@playwright/test";

import { type App, expect, mockOnly, test } from "./fixtures";

// The guided install (views/onboarding/guided-install.tsx) is adding a box
// from Team setup: the plan, full screen, with the agents to choose and the
// team's steps after Terminal's, then berth add ssh --guided in a terminal here
// beside a checklist the step markers keep up to date, then the team's
// setup on the new box in the same screen. (Adding a box anywhere else is
// the quick install: quick-install.spec.ts.) The mock (lib/mock-install.ts)
// plays a fresh Ubuntu box: Enter to start, sudo asking for a password, a
// word in the host picking a path ("flaky" fails a step once, "newkey" an
// unknown host key). The team is the mock's Acme (?team=acme).

test.beforeEach(() => mockOnly("the guided install's terminal is a mock fixture"));
test.describe.configure({ timeout: 60_000 });

const guided = (page: Page) => page.getByTestId("guided-install");
const step = (page: Page, id: string) => guided(page).getByTestId(`step-${id}`);
const advance = (page: Page, name: string) => page.evaluate((n) => (window as unknown as { __teamMock: { advance(n: string): void } }).__teamMock.advance(n), name);

// openPlan adds a box from Acme's Team setup page, which opens the guided
// install's plan.
async function openPlan(app: App, host: string) {
  const { page } = app;
  await app.open({ params: { team: "acme", "team-page": "acme" } });
  await page.getByRole("button", { name: "Add a box" }).locator("visible=true").first().click();
  await page.getByText("Or let Terminal set it up over SSH").click();
  await page.getByLabel("SSH host, like me@my-box").fill(host);
  // Team setup's add a box has the agents in the plan, not inline.
  await expect(page.getByTestId("inline-agents")).toHaveCount(0);
  await page.getByTestId("ssh-set-up").click();
  await expect(guided(page)).toHaveAttribute("data-stage", "plan");
  await expect(page.getByTestId("install-plan")).toBeVisible();
  await expect(page.getByTestId("quick-install")).toHaveCount(0);
}

async function startRun(page: Page) {
  await page.getByTestId("install-start").click();
  await expect(guided(page)).toHaveAttribute("data-stage", "run");
  await expect(page.getByTestId("install-banner")).toHaveAttribute("data-waiting", "enter");
  // The terminal takes the keyboard once it has drawn itself.
  await page.getByTestId("install-terminal").click();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest("[data-testid=install-terminal]"))).toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("install-banner")).not.toHaveAttribute("data-waiting", "enter");
}

test("from Team setup: the whole plan, the terminal, sudo's password, then the team's setup on the new box", async ({ app }) => {
  const { page } = app;
  await openPlan(app, "demo@my-box");
  await expect(guided(page)).toContainText("Set up demo@my-box for Acme");
  // The plan says what runs, which steps need sudo, and the exact commands.
  const plan = page.getByTestId("install-plan");
  await expect(plan.getByTestId("plan-connect")).toContainText("Connect to demo@my-box");
  await expect(plan.getByTestId("sudo-badge")).toHaveCount(2);
  await plan.getByTestId("plan-tools").getByRole("button").click();
  await expect(page.getByTestId("plan-commands-tools")).toContainText("sudo apt-get install -y -q git");
  await expect(page.getByTestId("plan-commands-tools")).toContainText("~/.local/bin/tmux");
  // Claude Code is ticked the first time.
  await expect(page.getByTestId("agent-claude")).toHaveAttribute("data-checked", "true");
  await expect(plan.getByTestId("plan-agents")).toContainText("Claude Code");
  // Then the team's own steps, after Terminal's.
  const team = page.getByTestId("install-plan-team");
  await expect(guided(page)).toContainText("Then Acme's setup");
  await expect(team.getByTestId("plan-team-packages")).toContainText("System packages");
  await expect(team.getByTestId("plan-team-1password")).toBeVisible();

  await startRun(page);
  // sudo asks on the box: the checklist and the banner say so.
  await expect(page.getByTestId("install-banner")).toHaveAttribute("data-waiting", "password", { timeout: 15_000 });
  await expect(step(page, "linger")).toHaveAttribute("data-state", "running");
  await expect(step(page, "linger").getByTestId("step-waiting")).toBeVisible();
  await expect(step(page, "berthd")).toHaveAttribute("data-state", "done");
  await page.keyboard.type("s3cret-pw");
  await page.keyboard.press("Enter");
  // The box is ready, and Acme's setup starts on it in the same screen.
  const phase = page.getByTestId("team-phase");
  await expect(phase).toBeVisible({ timeout: 30_000 });
  for (const id of ["connect", "berthd", "linger", "tools", "agents", "integrations", "pair"]) await expect(guided(page).getByTestId(`step-${id}`)).toHaveAttribute("data-state", "done");
  await expect(phase.getByTestId("team-step-update")).toHaveAttribute("data-state", "running", { timeout: 10_000 });
  await advance(page, "sudo");
  await expect(phase.getByTestId("team-step-github")).toHaveAttribute("data-state", /done|running/, { timeout: 15_000 });
  await expect(guided(page).getByTestId("install-continue")).toBeVisible({ timeout: 20_000 });
  // The password went to the box's terminal and nowhere the app keeps.
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.body.innerText)).not.toContain("s3cret-pw");
  await guided(page).getByTestId("install-continue").click();
  await expect(guided(page)).toHaveCount(0);
  // Back on Team setup, on the new box.
  await expect(page.getByTestId("team-page")).toBeVisible();
  await expect(page.getByTestId("team-sidebar")).toContainText("Acme on my-box");
});

test("the agents chosen are installed, and remembered for the next box", async ({ app }) => {
  const { page } = app;
  await openPlan(app, "demo@my-box");
  await page.getByTestId("agent-codex").click();
  await expect(page.getByTestId("plan-agents")).toContainText("Claude Code and Codex");
  // Gemini needs Node, so Terminal says how instead of offering it.
  await expect(page.getByTestId("agent-gemini")).toContainText("npm install -g @google/gemini-cli");
  expect(((await app.stored("berth.prefs")) as { installAgents: string[] }).installAgents).toEqual(["claude", "codex"]);
  await page.getByTestId("agent-claude").click();
  await expect(page.getByTestId("plan-agents")).toContainText("Codex");
  await startRun(page);
  await expect(step(page, "agents")).toContainText("Codex");
  await expect(page.getByTestId("install-banner")).toHaveAttribute("data-waiting", "password", { timeout: 15_000 });
  await page.keyboard.type("pw");
  await page.keyboard.press("Enter");
  await expect(step(page, "agents")).toHaveAttribute("data-state", "done", { timeout: 30_000 });
});

test("a failed step offers its command and Retry from it; the steps before stay done", async ({ app }) => {
  const { page } = app;
  await openPlan(app, "demo@flaky-box");
  await startRun(page);
  await expect(page.getByTestId("install-banner")).toHaveAttribute("data-waiting", "password", { timeout: 15_000 });
  await page.keyboard.type("pw");
  await page.keyboard.press("Enter");
  await expect(step(page, "tools")).toHaveAttribute("data-state", "fail", { timeout: 15_000 });
  await expect(page.getByTestId("install-status")).toHaveText("Stopped");
  // The command as it is typed, never made into a sentence.
  const line = step(page, "tools").getByTestId("command-line");
  await expect(line.locator("code")).toHaveText("sudo apt-get install -y -q git");
  await expect(line.getByRole("button", { name: "Run in terminal" })).toBeVisible();
  await expect(step(page, "linger")).toHaveAttribute("data-state", "done");
  await step(page, "tools").getByTestId("retry-tools").click();
  await expect(step(page, "linger")).toHaveAttribute("data-state", "done");
  await expect(step(page, "tools")).toHaveAttribute("data-state", "running");
  await expect(page.getByTestId("team-phase")).toBeVisible({ timeout: 30_000 });
  await expect(step(page, "tools")).toHaveAttribute("data-state", "done");
});

test("a box this computer hasn't met: trust its key, and it goes on", async ({ app }) => {
  const { page } = app;
  await openPlan(app, "demo@newkey-box");
  await page.getByTestId("install-start").click();
  await expect(step(page, "connect")).toHaveAttribute("data-state", "fail");
  await expect(guided(page)).toContainText("SHA256:Zm9yLWRlbW8tb25seS1ub3QtYS1yZWFsLWtleQ");
  await guided(page).getByRole("button", { name: "Trust and connect" }).click();
  await expect(step(page, "connect")).toHaveAttribute("data-state", "done");
  await expect(page.getByTestId("install-banner")).toHaveAttribute("data-waiting", "enter");
});

test("Add agents from a box's settings runs in the same terminal and checklist", async ({ app }) => {
  const { page } = app;
  await app.open();
  const boxes = await app.openSettings("boxes");
  await boxes.getByRole("button", { name: "devl actions" }).click();
  await page.getByTestId("box-add-agents").click();
  const view = page.getByTestId("add-agents");
  await expect(view.getByTestId("agent-claude")).toContainText("Installed on this box");
  await view.getByTestId("agent-cursor").click();
  await view.getByTestId("add-agents-start").click();
  await expect(view).toHaveAttribute("data-stage", "run");
  await expect(view.getByTestId("step-agent-cursor")).toHaveAttribute("data-state", "done", { timeout: 15_000 });
  await expect(view.getByTestId("step-integrations")).toHaveAttribute("data-state", "done");
  await view.getByTestId("add-agents-done").click();
  await expect(view).toHaveCount(0);
});
