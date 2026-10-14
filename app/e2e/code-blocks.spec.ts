import type { Page } from "@playwright/test";

import { expect, mockOnly, test } from "./fixtures";

// A reply's mermaid and diff blocks, drawn (components/conversation/code-
// blocks.tsx): a flowchart as its diagram, with its source a click away;
// other Mermaid as written; a diff as the chat's edits are drawn. A draft
// stays text until it lands. Replies land through the demo's
// window.__berthDraft (lib/mock-conversation).

const BOX = "gpu";
const AGENT = "judge-v2-claude";

const FENCE = "```";

const DIAGRAM_REPLY = [
  "## How a judged sample flows",
  "",
  `${FENCE}mermaid`,
  "flowchart LR",
  "  A[Sample] --> B{Cached?}",
  "  B -->|yes| C[Reuse score]",
  "  B -->|no| D[Judge v2]",
  "  D --> E[(acme-scores)]",
  FENCE,
  "",
  "And the order the calls go in:",
  "",
  `${FENCE}mermaid`,
  "sequenceDiagram",
  "  Runner->>Judge: score(sample)",
  "  Judge-->>Runner: 4",
  FENCE,
].join("\n");

const DIFF_REPLY = [
  "## The fix",
  "",
  `${FENCE}diff`,
  "--- a/src/acme/judge.ts",
  "+++ b/src/acme/judge.ts",
  "@@ -12,4 +12,5 @@ export function score(sample: Sample) {",
  "   const rubric = loadRubric();",
  "-  return judge(sample, rubric);",
  "+  const pairs = pairwise(sample);",
  "+  return judge(pairs, rubric);",
  " }",
  FENCE,
  "",
  "Or, in short:",
  "",
  `${FENCE}diff`,
  "- timeout: 10",
  "+ timeout: 30",
  "  retries: 3",
  FENCE,
].join("\n");

type DraftHook = { show(b: string, s: string, t: string): void; land(b: string, s: string, t: string): void; clear(b: string, s: string): void };
const draftHook = (page: Page, fn: "show" | "land" | "clear", text = "") =>
  page.evaluate(([fn, b, s, t]) => {
    const h = (window as unknown as { __berthDraft: DraftHook }).__berthDraft;
    if (fn === "show") h.show(b, s, t);
    else if (fn === "land") h.land(b, s, t);
    else h.clear(b, s);
  }, [fn, BOX, AGENT, text] as const);

test("a mermaid flowchart in a reply draws as its diagram, with its source a click away", async ({ app }) => {
  mockOnly("lands a reply on the demo's agent");
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree("gpu/judge-v2");
  await draftHook(app.page, "land", DIAGRAM_REPLY);
  const md = app.chat.locator("[data-kind=text] .cv-md").filter({ hasText: "How a judged sample flows" });
  const [flow, sequence] = [md.locator(".cv-pre").nth(0), md.locator(".cv-pre").nth(1)];

  await expect(flow.locator("svg[role=img]")).toBeVisible();
  await expect(flow.locator("svg[role=img]")).toHaveAttribute("aria-label", "Diagram: Sample, Cached?, Reuse score, Judge v2, acme-scores");
  await expect(flow.locator(":scope > pre")).toBeHidden();
  await expect(flow.locator(".cv-pre-lang")).toHaveText("Mermaid");

  await flow.getByRole("button", { name: "Source" }).click();
  await expect(flow.locator(":scope > pre")).toBeVisible();
  await expect(flow.locator(":scope > pre")).toContainText("A[Sample] --> B{Cached?}");
  await expect(flow.locator("svg[role=img]")).toBeHidden();
  await flow.getByRole("button", { name: "Diagram" }).click();
  await expect(flow.locator("svg[role=img]")).toBeVisible();

  // Mermaid other than a flowchart is its source, said so.
  await expect(sequence.locator(":scope > pre")).toBeVisible();
  await expect(sequence.locator("svg[role=img]")).toHaveCount(0);
  await expect(sequence.locator(".cv-pre-note")).toHaveText("Shown as written: Shipyard draws flowcharts");
});

test("a diff in a reply draws as the chat's edits do: a patch with its file, bare lines without numbers", async ({ app }) => {
  mockOnly("lands a reply on the demo's agent");
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree("gpu/judge-v2");
  await draftHook(app.page, "land", DIFF_REPLY);
  const md = app.chat.locator("[data-kind=text] .cv-md").filter({ hasText: "The fix" });
  const [patch, bare] = [md.locator(".cv-pre").nth(0), md.locator(".cv-pre").nth(1)];

  // The renderer loads on first use; then both blocks are drawn.
  await expect(patch).toHaveAttribute("data-drawn", "diff");
  await expect(bare).toHaveAttribute("data-drawn", "diff");
  await expect(patch.locator(".cv-pre-lang")).toHaveText("Diff");
  await expect(patch.locator(".cv-pre-file")).toContainText("src/acme/judge.ts");
  await expect(patch.locator(".cv-pre-file")).toContainText("+2");
  await expect(patch.locator(".cv-pre-file")).toContainText("−1");
  await expect(patch.locator(":scope > pre")).toBeHidden();
  // Numbered by the file's own lines; the bare lines number nothing.
  await expect(patch.locator("[data-column-number]").first()).toBeVisible();
  await expect(patch.locator("[data-column-number]", { hasText: /^12$/ }).first()).toBeVisible();
  await expect(bare.locator("pre[data-diff]")).toHaveAttribute("data-disable-line-numbers", "");
  await expect(patch.locator("pre[data-diff]")).not.toHaveAttribute("data-disable-line-numbers");
  await expect(bare.locator(".cv-pre-file")).not.toContainText("change");
});

test("a reply still being written keeps its diagram as text until it lands", async ({ app }) => {
  mockOnly("drives the demo's screen");
  await app.open({ params: { view: "conversation" } });
  await app.openWorktree("gpu/judge-v2");
  await draftHook(app.page, "show", DIAGRAM_REPLY);
  const draft = app.chat.locator("[data-draft] .cv-md").filter({ hasText: "How a judged sample flows" });
  await expect(draft.locator(".cv-pre").first().locator("pre")).toBeVisible();
  await expect(draft.locator("svg[role=img]")).toHaveCount(0);
  await draftHook(app.page, "land", DIAGRAM_REPLY);
  await draftHook(app.page, "clear");
  const md = app.chat.locator("[data-kind=text] .cv-md").filter({ hasText: "How a judged sample flows" });
  await expect(md.locator(".cv-pre").first().locator("svg[role=img]")).toBeVisible();
});
