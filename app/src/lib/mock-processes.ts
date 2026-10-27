// Mock GET /v1/processes and POST /v1/processes/{id}/stop for ?mock=1
// (internal/box/boxprocs.go); the guard's session_memory_gb is in
// mock-flows. devl has a session's Playwright tests at 486% CPU, berth's
// own agent browser, one left behind by an ended session, an agent-browser
// session and the box user's own Chrome; the other boxes have none.
import type { BoxBrowser, BoxProcesses, BoxSessionProcs } from "./processes.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

export const LINEAR_USAGE = { memory: 11.8 * GB, memory_high: 12 * GB, cpu_s: 2412, cpu_percent: 512, processes: 23, near_limit: true, throttled: 41, scoped: true };

function browsersFor(box: string): BoxBrowser[] {
  if (box !== "devl") return [];
  const b = (over: Partial<BoxBrowser> & Pick<BoxBrowser, "id" | "label" | "owner">): BoxBrowser => ({ engine: "Headless Chromium", pid: Number(over.id.split("-")[1]), pids: [], processes: 4, cpu_percent: 1, memory: 300 * MB, started: ago(10), stoppable: true, ...over });
  return [
    b({ id: "b-41822-1", owner: "session", label: "Playwright tests in shop/https-linear-app-acme", via: "Playwright tests", session: "https-linear-app-acme-claude", location: "shop/https-linear-app-acme", processes: 7, cpu_percent: 486.2, memory: 1.3 * GB, started: ago(14) }),
    b({ id: "b-39007-1", owner: "orphan", label: "Puppeteer left by ended session order-export-claude", via: "Puppeteer", session: "order-export-claude", processes: 5, cpu_percent: 22.4, memory: 610 * MB, started: ago(190) }),
    b({ id: "b-40211-1", owner: "agent", label: "Agent browser for shop/checkout-fix", location: "shop", worktree: "checkout-fix", cpu_percent: 2.6, memory: 380 * MB, started: ago(6) }),
    b({ id: "b-1201-1", owner: "agent-browser", engine: "Headless Chrome", label: 'agent-browser "qa" of shop/qa-deck', via: "agent-browser", session: "qa-deck-codex", location: "shop/qa-deck", processes: 3, cpu_percent: 0.8, memory: 290 * MB, started: ago(9) }),
    b({ id: "b-777-1", owner: "other", engine: "Chrome", label: "Chrome, not started by Terminal", processes: 6, cpu_percent: 0.4, memory: 520 * MB, started: ago(2900), stoppable: false }),
  ];
}

function sessionsFor(box: string): BoxSessionProcs[] {
  if (box !== "devl") return [];
  return [
    { id: "s-https-linear-app-acme-claude", name: "https-linear-app-acme-claude", location: "shop/https-linear-app-acme", title: "Fix the cart badge after a refund", agent: "claude", scope: "berth-https-linear-app-acme-claude-tq1.scope", usage: LINEAR_USAGE },
    { id: "s-checkout-fix-claude", name: "checkout-fix-claude", location: "shop/checkout-fix", title: "Fix checkout webhook retries", agent: "claude", scope: "berth-checkout-fix-claude-tp9.scope", usage: { memory: 1.1 * GB, memory_high: 12 * GB, cpu_s: 310, cpu_percent: 3.1, processes: 6, scoped: true } },
    { id: "s-svc-shop-checkout-fix-web", name: "svc-shop-checkout-fix-web", location: "shop/checkout-fix", title: "Next.js", scope: "berth-svc-shop-checkout-fix-web-tp8.scope", usage: { memory: 640 * MB, memory_high: 12 * GB, cpu_s: 88, cpu_percent: 1.2, processes: 4, scoped: true } },
  ];
}

const stopped = new Set<string>();

// processesCall answers the routes, or undefined for any other.
export function processesCall(box: string, method: string, path: string, emit: (e: { type: string; box: string; data: Record<string, unknown> }) => void): unknown {
  if (method === "GET" && (path === "processes" || path === "processes?kind=browser")) {
    const list: BoxProcesses = { browsers: browsersFor(box).filter((b) => !stopped.has(b.id)), sessions: path === "processes" ? sessionsFor(box) : undefined, scopes: box !== "gpu", at: new Date().toISOString() };
    return list;
  }
  const stop = method === "POST" ? /^processes\/([^/]+)\/stop$/.exec(path) : null;
  if (stop) {
    const id = decodeURIComponent(stop[1]);
    const b = browsersFor(box).find((x) => x.id === id && !stopped.has(x.id));
    if (!b) throw new Error("no such browser or session on this box now; it may have ended");
    if (!b.stoppable) throw new Error("Terminal didn't start this browser, so it leaves it alone; stop it on the box if you mean to");
    stopped.add(id);
    const text = `Stopped ${b.label} (${b.processes} processes)`;
    emit({ type: "process.stopped", box, data: { id, text } });
    return { stopped: id, text };
  }
  return undefined;
}
