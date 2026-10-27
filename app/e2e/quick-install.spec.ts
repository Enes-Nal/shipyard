import type { Locator, Page } from "@playwright/test";

import { type App, expect, mockOnly, test } from "./fixtures";

// The quick install (views/onboarding/quick-install.tsx) is adding a box
// anywhere but Team setup: no plan to read and no Enter to press, a compact
// dialog with a short checklist, and the agents chosen inline beside the
// host. The terminal opens inline only for a step that needs sudo's
// password, and only for that step. The mock (lib/mock-install.ts) plays a
// box; a word in the host picks a path: "nogit" (git is missing, so its step
// asks for the password), "rootlinger" (keeping berthd running after logout
// needs root, and nothing else does), "newkey" (a host key this computer
// hasn't met).

test.beforeEach(() => mockOnly("the quick install's terminal is a mock fixture"));
test.describe.configure({ timeout: 60_000 });

const dialog = (page: Page) => page.getByTestId("quick-install");
const step = (page: Page, id: string) => dialog(page).getByTestId(`quick-step-${id}`);

// watchTerminal notes, from now on, whether the dialog's terminal ever
// showed, and which steps were running when it did.
async function watchTerminal(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __terminalSeen: string[][] };
    w.__terminalSeen = [];
    let shown = false;
    new MutationObserver(() => {
      const t = document.querySelector("[data-testid=quick-terminal]");
      if (t && !shown) w.__terminalSeen.push([...document.querySelectorAll("[data-testid^=quick-step-][data-state=running]")].map((e) => e.getAttribute("data-testid")!.replace("quick-step-", "")));
      shown = !!t;
    }).observe(document.body, { childList: true, subtree: true });
  });
}
const terminalSeen = (page: Page) => page.evaluate(() => (window as unknown as { __terminalSeen: string[][] }).__terminalSeen);

// typeIn gives the dialog's terminal the keyboard, once it has drawn itself.
async function typeIn(page: Page, term: Locator) {
  await expect(async () => {
    await term.getByTestId("install-terminal").click();
    expect(await page.evaluate(() => !!document.activeElement?.closest("[data-testid=install-terminal]"))).toBe(true);
  }).toPass();
}

async function addBox(app: App, host: string) {
  const { page } = app;
  await app.open();
  await app.openSettings("boxes");
  await page.getByRole("button", { name: "Add a box" }).first().click();
  await page.getByText("Or let Terminal set it up over SSH").click();
  await page.getByLabel("SSH host, like me@my-box").fill(host);
  await watchTerminal(page);
  await page.getByTestId("ssh-set-up").click();
  await expect(dialog(page)).toBeVisible();
  // No plan, full screen or otherwise.
  await expect(page.getByTestId("guided-install")).toHaveCount(0);
}

test("adding a box is quiet: a short checklist, no plan, no terminal, and it's ready", async ({ app }) => {
  const { page } = app;
  await addBox(app, "demo@my-box");
  await expect(dialog(page)).toContainText("Setting up my-box");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(dialog(page)).toContainText("my-box is ready");
  for (const id of ["connect", "berthd", "linger", "tools", "agents", "integrations", "pair"]) await expect(step(page, id)).toHaveAttribute("data-state", "done");
  // Lingering went on without sudo; nothing needed a password.
  await expect(step(page, "linger")).toContainText("on, without sudo");
  await expect(dialog(page).getByText("sudo", { exact: true })).toHaveCount(0);
  expect(await terminalSeen(page)).toEqual([]);
  await dialog(page).getByTestId("quick-continue").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("settings-boxes")).toContainText("my-box");
});

test("git missing: the terminal opens for that step alone, sudo's password goes to it, then it closes", async ({ app }) => {
  const { page } = app;
  await addBox(app, "demo@nogit-box");
  await expect(dialog(page)).toHaveAttribute("data-needs", "password", { timeout: 15_000 });
  // Only the step that needs it: the ones before are done, the rest wait.
  await expect(step(page, "tools")).toHaveAttribute("data-state", "running");
  await expect(step(page, "tools")).toHaveAttribute("data-needs", "password");
  await expect(step(page, "tools").getByTestId("quick-password")).toContainText("nothing shows as you type");
  await expect(step(page, "berthd")).toHaveAttribute("data-state", "done");
  await expect(step(page, "linger")).toHaveAttribute("data-state", "done");
  await expect(step(page, "agents")).toHaveAttribute("data-state", "todo");
  await expect(dialog(page)).toContainText("sudo needs demo's password on nogit-box for this step.");
  const term = dialog(page).getByTestId("quick-terminal");
  await expect(term).toBeVisible();
  expect(await terminalSeen(page)).toEqual([["tools"]]);
  await typeIn(page, term);
  await page.keyboard.type("s3cret-pw");
  await page.keyboard.press("Enter");
  // The terminal goes once the password is in, and the rest run quietly.
  await expect(term).toHaveCount(0, { timeout: 10_000 });
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(step(page, "tools")).toHaveAttribute("data-state", "done");
  expect(await terminalSeen(page)).toEqual([["tools"]]);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.body.innerText)).not.toContain("s3cret-pw");
});

test("lingering alone needs root: it asks first, and Skip goes on without a terminal", async ({ app }) => {
  const { page } = app;
  await addBox(app, "demo@rootlinger-box");
  await expect(dialog(page)).toHaveAttribute("data-needs", "ask", { timeout: 15_000 });
  const choice = step(page, "linger").getByTestId("quick-linger");
  await expect(choice).toContainText("needs root to keep berthd running after you log out");
  await choice.getByTestId("quick-linger-skip").click();
  await expect(step(page, "linger")).toHaveAttribute("data-state", "skip");
  await expect(step(page, "linger")).toContainText("berthd stops when you log out");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  expect(await terminalSeen(page)).toEqual([]);
});

test("lingering alone needs root: Keep it running opens the terminal for its password", async ({ app }) => {
  const { page } = app;
  await addBox(app, "demo@rootlinger-box");
  await step(page, "linger").getByTestId("quick-linger-yes").click({ timeout: 15_000 });
  await expect(dialog(page)).toHaveAttribute("data-needs", "password");
  const term = dialog(page).getByTestId("quick-terminal");
  await expect(term).toBeVisible();
  await typeIn(page, term);
  await page.keyboard.type("pw");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(step(page, "linger")).toHaveAttribute("data-state", "done");
  expect(await terminalSeen(page)).toEqual([["linger"]]);
});

test("the agents are chosen inline, Claude Code first, and remembered for the next box", async ({ app }) => {
  const { page } = app;
  await app.open();
  await app.openSettings("boxes");
  await page.getByRole("button", { name: "Add a box" }).first().click();
  await page.getByText("Or let Terminal set it up over SSH").click();
  const agents = page.getByTestId("inline-agents");
  await expect(agents.getByTestId("inline-agent-claude")).toHaveAttribute("data-checked", "true");
  await expect(agents.getByTestId("inline-agent-codex")).not.toHaveAttribute("data-checked", "true");
  // Gemini needs Node, which Terminal doesn't install: it isn't offered here.
  await expect(agents.getByTestId("inline-agent-gemini")).toHaveCount(0);
  await agents.getByTestId("inline-agent-codex").getByRole("checkbox").click();
  expect(((await app.stored("berth.prefs")) as { installAgents: string[] }).installAgents).toEqual(["claude", "codex"]);
  await page.getByLabel("SSH host, like me@my-box").fill("demo@my-box");
  await page.getByTestId("ssh-set-up").click();
  await expect(step(page, "agents")).toContainText("Claude Code and Codex");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});

test("a box this computer hasn't met: trust its key in the dialog, and it goes on", async ({ app }) => {
  const { page } = app;
  await addBox(app, "demo@newkey-box");
  await expect(step(page, "connect")).toHaveAttribute("data-state", "fail");
  await expect(dialog(page)).toContainText("SHA256:Zm9yLWRlbW8tb25seS1ub3QtYS1yZWFsLWtleQ");
  await dialog(page).getByRole("button", { name: "Trust and connect" }).click();
  await expect(step(page, "connect")).toHaveAttribute("data-state", "done");
  await expect(dialog(page)).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
});
