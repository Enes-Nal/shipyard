import { vdiffChat } from "@/lib/art/mock-vdiff-chat";
import type { TranscriptItem } from "@/lib/transcript";

// Mock mode's chat side of artifacts (the content is lib/art/mock-
// artifacts.ts, loaded only when asked): the search-perf agent's turn
// where it made them.

export const ART_BOX = "devl";
export const ART_SESSION = "search-perf-claude";

let n = 0;
const id = () => `mock-artchat-${++n}`;
const card = (art: string, title: string): TranscriptItem => ({ kind: "artifact", id: id(), tool: `art-${art}`, text: title, local: art, version: 1, done: true });
const run = (target: string): TranscriptItem => ({ kind: "tools", id: id(), verb: "Run", done: true, items: [{ verb: "Run", target }] });

// artChat is the turn where they were made, after the session's earlier
// work.
export function artChat(): TranscriptItem[] {
  return [
    // Earlier in the turn: the agent's UI change, checked with visual diffs.
    ...vdiffChat(),
    { kind: "user", id: id(), text: "Show me the numbers here in Terminal as you go: where the time goes, what you change, and how it moves." },
    { kind: "crew", id: id(), names: ["Explore: map search"] },
    run('berthd artifact add notes/search-map.mmd --title "How acme search is wired" --by "Explore: map search"'),
    card("a1f3c0d2e4", "How acme search is wired"),
    run('psql -f perf/p95_by_hour.sql > perf/slow-endpoints.json && berthd artifact add perf/slow-endpoints.json --title "Slow endpoints by hour"'),
    card("b7c2a9e1f0", "Slow endpoints by hour"),
    { kind: "text", id: id(), text: "Two things stand out: **/search** and **/api/recs** both fall back to `LIKE '%q%'` on 1.2M products, and they peak together from 08:00 to 20:00. Here's the plan." },
    card("c4d9e2b7a1", "Search speed-up plan"),
    run('pnpm bench:search --requests 2000 && berthd artifact add perf/p95.json --title "p95 before and after" --note "trigram index only"'),
    card("d2e8f1a0b3", "p95 before and after"),
    run('pnpm test --reporter=csv > perf/tests.csv && berthd artifact add perf/tests.csv --title "Search test results"'),
    card("e5a1b2c3d4", "Search test results"),
    { kind: "text", id: id(), text: "/search p95 is down from 1,240 ms to 410 ms. Three tests fail: the ranking one is real, the other two are the region filter in recs and a slow cache invalidation. The reindex runs on staging; the page below follows it." },
    card("f9b4c8d7e6", "Reindex progress"),
    run("berthd artifact add perf/trend.json perf/flow.json perf/cache.json …"),
    card("a3c7d9e1b2", "Search p95 over two weeks"),
    card("b8d6e4f2a0", "Where a search request goes"),
    card("c1e2f3a4b5", "Suggest cache hit rate"),
    { kind: "text", id: id(), text: "The rest are on the worktree's board: the search-to-checkout funnel, traffic by hour, where /search spends its time, and searches by source." },
  ];
}

