import { expect, mockOnly, test } from "./fixtures";

// Settings › Boxes says which agent CLIs each box found, where, and how they
// were installed: an npm install under nvm reads as such (the mock's devl
// has Claude Code from npm and Codex from Terminal's installer), with Look
// again for one installed since.

test.beforeEach(() => mockOnly("the box's agent paths are mock fixtures"));

test("a box's agent CLIs show with their version, path and install, and Look again asks the box", async ({ app }) => {
  const { page } = app;
  await app.open();
  const boxes = await app.openSettings("boxes");
  const agents = boxes.getByTestId("box-agents").first();
  await expect(agents).toContainText("Claude Code 2.1.3");
  await expect(agents).toContainText("~/.nvm/…/bin/claude");
  await expect(agents).toContainText("(npm)");
  await expect(agents).toContainText("Codex 0.46.0");
  await agents.getByTestId("box-agents-refresh").click();
  await expect(agents.getByTestId("box-agents-refresh")).toBeEnabled();
  await expect(agents).toContainText("Claude Code 2.1.3");
  await expect(page.getByText("Couldn't look for agents")).toHaveCount(0);
});
