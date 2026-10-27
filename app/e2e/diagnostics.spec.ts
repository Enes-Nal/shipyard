import { expect, live, test } from "./fixtures";

// Copy diagnostics (Settings › About › Help): one short, redacted report to
// paste into a chat. `berth doctor --report` prints the same text
// (internal/doctor/testdata/diagnostics.golden holds both to it).

test("Copy diagnostics copies a short, redacted report", async ({ app }) => {
  await app.open();
  const about = await app.openSettings("about");
  await about.getByTestId("copy-diagnostics").click();
  await expect(app.page.getByText("Diagnostics copied")).toBeVisible();
  const text = await app.page.evaluate(() => navigator.clipboard.readText());

  const lines = text.trimEnd().split("\n");
  expect(lines[0]).toMatch(/^Shipkit diagnostics · \d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  expect(lines.length).toBeLessThanOrEqual(70);
  for (const section of [/^App: /m, /^Agent: running/m, /^Terminal: /m, /^Look: theme berth-dark · Labs on/m, /^Laptop \(berth doctor\)$/m, /^Boxes \(\d+\)$/m, /^Recent errors/m, /^Recent toasts/m]) expect(text).toMatch(section);
  // Nothing that identifies the person or opens their accounts.
  expect(text).not.toMatch(/\/Users\/[^/\s]+|\/home\/[^/\s]+/);
  expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  expect(text).not.toMatch(/op:\/\/(?!\[redacted\])/);
  if (live) return;

  // The mock's checks carry a home folder, an email and an op:// reference.
  expect(text).toContain("✓ image generation  codex at ~/.local/bin/codex, key from op://[redacted]");
  expect(text).toContain("✗ work  signed out ([email]) → berth network login work");
  expect(text).toMatch(/^ {2}devl · online · 0\.1\.0 \(b9758a308077\) · caps: diff turns queue ask answer/m);
  expect(text).toContain("old-vps · offline · last error: dial tcp: i/o timeout");
});
