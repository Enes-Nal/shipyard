import type { TranscriptItem } from "@/lib/transcript";

// The demo's reports back: order-export-claude handed two pieces of work to
// other agents and ended its turn; Terminal told it how each went, as one
// <berth-notification> (internal/box/notify_text.go), and it carried on.
export function mockReports(session: string): TranscriptItem[] {
  if (session !== "order-export-claude") return [];
  return [
    {
      kind: "report",
      id: "mock-report-search",
      report: {
        kind: "task",
        session: "search-perf-claude",
        worktree: "shop/search-perf",
        branch: "search-perf",
        status: "finished",
        duration: "4m12s",
        files: 3,
        added: 48,
        removed: 12,
        summary: "shop/search-perf finished its turn.",
        answer: "Search is 3× faster: a trigram index on products.name and the typeahead debounced to 150 ms. The p95 for the ten slowest queries went from 840 ms to 260 ms; the bench and the migration are on the branch.",
      },
    },
    {
      kind: "report",
      id: "mock-report-checkout",
      report: {
        kind: "turn",
        session: "checkout-fix-claude",
        worktree: "shop/checkout-fix",
        branch: "checkout-fix",
        status: "waiting",
        duration: "52m",
        summary: "shop/checkout-fix is waiting for a person (a permission or a question).",
        needs: "permission to use Bash: pnpm prisma migrate dev --name idempotency_key · why: The fix needs a column for idempotency keys",
      },
    },
    { kind: "text", id: "mock-report-reply", text: "Search is done: I'll review **search-perf** and merge it. The checkout fix needs you to allow its migration before it can go on." },
  ];
}
