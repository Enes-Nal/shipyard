import type { AgentMessage, CrewMember, MessageSender, TranscriptItem } from "@/lib/transcript";

// The demo's chats with messages from other agents (gpu/ci-flake): what
// berthd sends for them once internal/transcript/peer.go has read Claude
// Code's record. The story (default) has helpers, a background command, a
// mid-turn note and another session's question; ?scene=busy is a teammate
// on a team, with four helpers, three teammates, the lead and Shipkit. All of
// acme and everyone in it is made up.

export const MESSAGES_SESSION = "ci-flake-claude";

const LEDGER_REPORT = `# Ledger writes in acme/billing

I didn't change any files. Every write to \`ledger_entries\` goes through three paths, and two of them have no idempotency key, so a retried refund can write the same row twice.

## Where the writes are

| Path | File | Keyed | Writes a day |
|---|---|---|---|
| Invoice settle | \`services/billing/settle.go:88\` | yes | ~41k |
| Refund | \`services/billing/refund.go:132\` | **no** | ~2.3k |
| Retry worker | \`services/billing/retry/worker.go:57\` | **no** | ~900 |

## Recent commits that touch them

- \`4e1a9c2\` billing: settle invoices in one transaction (Mara Lind, 3 days ago)
- \`b07d3f1\` refund: write the ledger row before the provider call (Theo Okafor, last week)
- \`91c55ae\` retry: re-enqueue on 5xx without a key (Theo Okafor, 2 weeks ago)

## What I'd do

1. Add \`idempotency_key\` to \`ledger_entries\`, nullable at first, and backfill it from the key \`settle.go\` already has.
2. Thread a key through \`refund.go\` and the retry worker. \`91c55ae\` is where the double writes came from.
3. Make the column \`NOT NULL\` once both paths write it.

Read these first: \`services/billing/ledger/write.go\`, \`services/billing/retry/worker.go\` and \`db/migrations/0142_ledger_v2.sql\`.`;

// The busy scene's ledger report is longer than a screen: every call site.
const LEDGER_FULL = `${LEDGER_REPORT}

## Every call site

| # | Caller | Line | Path |
|---|---|---|---|
${Array.from({ length: 34 }, (_, i) => `| ${i + 1} | \`services/billing/${["settle", "refund", "retry/worker", "invoice", "credit"][i % 5]}.go\` | ${40 + i * 7} | ${["settle", "refund", "retry", "settle", "refund"][i % 5]} |`).join("\n")}`;

const EXPORT_REPORT = `## Export reads of the ledger

The nightly export (\`services/export/ledger_csv.go\`) still reads \`ledger_v1\` in two places:

- \`ledger_csv.go:41\` selects from \`ledger_v1\` for invoices older than 90 days
- \`ledger_csv.go:77\` joins \`ledger_v1\` for refunds

Both can move to \`ledger_entries\` once the backfill is done; the column names match except \`amount_cents\` → \`amount\`.`;

let n = 0;
const id = (p = "am") => `mock-${p}-${++n}`;
const text = (t: string): TranscriptItem => ({ kind: "text", id: id("t"), text: t });
const msg = (m: AgentMessage): TranscriptItem => ({ kind: "agent-message", id: id(), msg: m });
const ping = (m: AgentMessage): TranscriptItem => ({ kind: "ping", id: id("p"), msg: m });

const helper = (c: CrewMember): MessageSender => ({ id: `a${c.id}`, name: c.name, kind: "helper", helper: c.id });
const harness = (task: string): MessageSender => ({ id: task, name: "Background command", kind: "harness" });

function story(t: number): { items: TranscriptItem[]; crew: CrewMember[] } {
  const crew: CrewMember[] = [
    { id: "toolu_ledger", name: "Map ledger writes", kind: "subagent", agent: "claude", state: "finished", doing: "Found 3 write paths, 2 unkeyed", since: t - 13 * 60_000, until: t - 8 * 60_000 },
    { id: "toolu_retry", name: "Fix retry tests", kind: "subagent", agent: "claude", state: "finished", doing: "Stalled: no progress for 600s", since: t - 13 * 60_000, until: t - 7 * 60_000 },
    { id: "toolu_index", name: "Check index sizes", kind: "subagent", agent: "claude", state: "finished", doing: "Every index fits in memory", since: t - 13 * 60_000, until: t - 10 * 60_000 },
  ];
  const [ledger, retry, index] = crew;
  const items: TranscriptItem[] = [
    { kind: "user", id: id("u"), text: "Move acme billing onto the new ledger. Send helpers to map every ledger write, fix the flaky retry tests and check the index sizes, and check with the payments-api session whether its webhook change has landed before we touch the column." },
    text("I’ll split this up: three helpers here, the billing tests and the linter in the background, and a word with the payments-api session about its webhook change."),
    { kind: "tools", id: id("r"), verb: "Read", done: true, items: [{ verb: "Read", target: "ledger/write.go", file: true }, { verb: "Read", target: "0142_ledger_v2.sql", file: true }] },
    { kind: "crew", id: id("c"), names: crew.map((c) => c.name) },
    { kind: "tools", id: id("r"), verb: "Run", done: true, items: [{ verb: "Run", target: "go test ./services/billing/..." }, { verb: "Run", target: "golangci-lint run ./services/billing/..." }] },
    text("The helpers are out, and the billing tests and the linter are running in the background."),
    ping({ from: harness("b4kq7m2xz"), status: "done", summary: "Run the billing tests completed (exit code 0)", task: "b4kq7m2xz", at: t - 11 * 60_000 }),
    ping({ from: harness("b7lint0q2"), status: "done", summary: "Lint acme/billing completed (exit code 0)", task: "b7lint0q2", at: t - 10.5 * 60_000 }),
    ping({ from: helper(index), status: "done", summary: "Check index sizes finished", task: "aindex", at: t - 10 * 60_000 }),
    msg({ from: helper(ledger), intent: "report", status: "finished", title: "Ledger writes in acme/billing", summary: "Every write to ledger_entries goes through three paths, and two of them have no idempotency key, so a retried refund can write the same row twice.", body: LEDGER_REPORT, at: t - 8 * 60_000 }),
    text("The ledger map is back: **3 write paths**, and the refund and retry paths write without a key. That matches the double refunds. I’ll add the column as nullable first."),
    ping({ from: helper(retry), status: "failed", summary: "Fix retry tests failed: Agent stalled: no progress for 600s", task: "aretry", repeat: 2, at: t - 7 * 60_000 }),
    { kind: "user", id: id("u"), text: "Leave ledger_v1 in place until Friday’s deploy, the export job still reads it.", midTurn: true },
    text("Understood: `ledger_v1` stays until Friday. The retry-test helper stalled, so I’ll take the retry tests myself after the migration."),
    { kind: "edit", id: id("e"), file: "db/migrations/0143_ledger_idempotency_key.sql", added: 14, removed: 0 },
    msg({
      from: { id: "payments-api", name: "payments-api", kind: "session" },
      intent: "question",
      summary: "Has the ledger migration merged yet?",
      body: "Has the ledger migration merged yet? Webhook v2 writes to the ledger and I'm holding the release on it.\n\nWhich name will the column have: `ledger_entries.idempotency_key` or `ledger_entries.request_key`?",
      at: t - 3 * 60_000,
    }),
    text("payments-api is holding its release on the column name. I’d go with `idempotency_key`, which matches `settle.go`; say the word and I’ll tell it, or answer it yourself."),
    ping({ from: { id: "claude-code", name: "Claude Code", kind: "harness" }, status: "info", summary: 'Not watching Artifact: "Ledger migration plan" (watch limit reached)', at: t - 2 * 60_000 }),
  ];
  return { items, crew };
}

function busy(t: number): { items: TranscriptItem[]; crew: CrewMember[] } {
  const crew: CrewMember[] = [
    { id: "toolu_ledger", name: "Map ledger writes", kind: "subagent", agent: "claude", state: "finished", doing: "Found 3 write paths, 2 unkeyed", since: t - 14 * 60_000, until: t - 2 * 60_000 },
    { id: "toolu_export", name: "Audit export reads", kind: "subagent", agent: "claude", state: "finished", doing: "2 reads still on ledger_v1", since: t - 14 * 60_000, until: t - 6 * 60_000 },
    { id: "toolu_index", name: "Check index sizes", kind: "subagent", agent: "claude", state: "finished", doing: "Indexes fit in memory", since: t - 14 * 60_000, until: t - 12 * 60_000 },
    { id: "toolu_dry", name: "Dry-run the migration", kind: "subagent", agent: "claude", state: "running", doing: "Copying 1.2M rows to a scratch table", since: t - 5 * 60_000 },
  ];
  const [ledger, exportReads, index] = crew;
  const schema: MessageSender = { id: "schema-review", name: "schema-review", kind: "teammate", color: "blue" };
  const exportJob: MessageSender = { id: "export-job", name: "export-job", kind: "teammate", color: "green" };
  const webhook: MessageSender = { id: "webhook-v2", name: "webhook-v2", kind: "teammate", color: "yellow" };
  const items: TranscriptItem[] = [
    { kind: "user", id: id("u"), text: "You’re on the ledger migration, with schema-review, export-job and webhook-v2 as teammates. Keep the lead posted and don’t merge without a review." },
    text("Starting with the schema. Four helpers are going out: the writes, the export reads, the index sizes and a dry run."),
    { kind: "crew", id: id("c"), names: crew.map((c) => c.name) },
    ping({ from: helper(index), status: "done", summary: "Check index sizes finished", task: "aindex", at: t - 12 * 60_000 }),
    msg({ from: schema, intent: "update", summary: "Schema is fine; one nit on the down migration", body: "Schema looks right to me. One nit: the down migration drops the index before the column, so a rollback under load locks `ledger_entries` for longer than it needs to. Swap the two lines and it's good to go.", at: t - 11 * 60_000 }),
    msg({ from: { id: "lead", name: "Lead", kind: "lead" }, intent: "instruction", summary: "Hold the backfill until export-job confirms its reads are on ledger_v2.", body: "Hold the backfill until export-job confirms its reads are on ledger_v2. Don't touch `services/export/`, export-job owns it.", at: t - 10 * 60_000 }),
    text("Holding the backfill. I’ll fix the down migration while I wait."),
    { kind: "edit", id: id("e"), file: "db/migrations/0143_ledger_idempotency_key.down.sql", added: 2, removed: 2 },
    msg({ from: helper(exportReads), intent: "report", status: "finished", title: "Export reads of the ledger", summary: "The nightly export (services/export/ledger_csv.go) still reads ledger_v1 in two places.", body: EXPORT_REPORT, at: t - 6 * 60_000 }),
    msg({ from: exportJob, intent: "question", body: "Do you want me to switch the export reads to `ledger_entries` now, or after your backfill? Switching first means two days of dual reads, but it unblocks you today.", summary: "Switch the export reads now or after the backfill?", answered: true, at: t - 5 * 60_000 }),
    ping({ from: webhook, status: "info", summary: "webhook-v2 is free", at: t - 4.5 * 60_000 }),
    {
      kind: "report",
      id: id("berth"),
      report: { kind: "task", session: "billing-docs-claude", worktree: "acme/billing-docs", status: "finished", duration: "6m40s", files: 2, added: 31, removed: 4, summary: "acme/billing-docs finished its turn.", answer: "The ledger runbook now covers the idempotency key and the Friday cut-over, with a rollback section for the down migration." },
    },
    msg({ from: helper(ledger), intent: "report", status: "finished", title: "Ledger writes in acme/billing", summary: "Every write to ledger_entries goes through three paths, and two of them have no idempotency key, so a retried refund can write the same row twice.", body: LEDGER_FULL, at: t - 2 * 60_000 }),
    ping({ from: harness("b9x2k7q1m"), status: "stopped", summary: "Dry-run the backfill was stopped after reaching its background time limit", task: "b9x2k7q1m", repeat: 2, at: t - 60_000 }),
    { kind: "tools", id: id("r"), verb: "Run", done: true, items: [{ verb: "Run", target: "SendMessage export-job" }] },
    text("export-job: switch after the backfill. Two days of dual reads isn’t worth it for one day saved. I’ll tell the lead the schema is reviewed and the backfill is next."),
  ];
  return { items, crew };
}

// messagesChat is the demo's chat for gpu/ci-flake.
export function messagesChat(scene: string | null, t = Date.now()): { items: TranscriptItem[]; crew: CrewMember[] } {
  return scene === "busy" ? busy(t) : story(t);
}
