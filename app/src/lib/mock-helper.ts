import type { HelperState, HelperStatus } from "@berth/plugin";

import { ApiError } from "@/lib/api";
import { helperRelayed } from "@/lib/helper-path";

// Mock mode's plugin helpers, behaving like the laptop agent's
// /v1/plugins/{id}/helper and a box's helpers/{plugin}/api/ closely enough
// to build on. Leadline's helper runs on devl and is off on gpu; turning one
// on takes a moment (installing, starting, running), as a download does.
//
// What a running helper answers is src/lib/fixtures/leadline.json: the real
// berth-leadline's answers to made-up "acme" telemetry for one worktree,
// shop / checkout-fix on devl (scripts/capture-leadline-fixtures.mjs wrote
// it). shop's main checkout on devl, which has no agent, answers the same
// under its own name; every other worktree has sent nothing yet. Times are
// moved so the newest is a few seconds old whenever it is read.
//
// ?helper=unsupported is a fleet whose boxes run a berthd from before
// helpers, ?helper=failed fails every install, and ?helper=update has devl
// on an older build than the plugin carries.

type Delay = <T>(v: T) => Promise<T>;

const scenario = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("helper");
const LATEST = "0.1.0";

interface Helper {
  state: HelperState;
  version?: string;
  error?: string;
  // What it recorded was removed, so it holds nothing.
  purged?: boolean;
  timers: number[];
}

const helpers = new Map<string, Helper>();

function helperOf(plugin: string, box: string): Helper {
  const key = `${plugin}\n${box}`;
  let h = helpers.get(key);
  if (!h) {
    const on = plugin === "leadline" && box === "devl";
    const off = plugin === "leadline" && box === "gpu";
    h = { state: scenario === "unsupported" ? "unsupported" : on ? "running" : off ? "off" : "none", version: on ? (scenario === "update" ? "0.0.9" : LATEST) : undefined, timers: [] };
    helpers.set(key, h);
  }
  return h;
}

function statusOf(plugin: string, box: string): HelperStatus {
  const h = helperOf(plugin, box);
  const update = h.state === "running" && h.version !== LATEST;
  return { plugin, box, state: h.state, platform: "linux-amd64", version: h.version, latest: LATEST, ...(update ? { update: true as const } : {}), error: h.error };
}

// helperLaptopCall answers the laptop agent's helper routes, or undefined
// for any other path. online says whether a box can be reached.
export function helperLaptopCall(method: string, path: string, online: (box: string) => boolean, delay: Delay): Promise<unknown> | undefined {
  const m = /^\/v1\/plugins\/([^/]+)\/helper\?(.*)$/.exec(path);
  if (!m) return undefined;
  const plugin = decodeURIComponent(m[1]);
  const query = new URLSearchParams(m[2]);
  const box = query.get("box") ?? "";
  if (!online(box)) return delay(null).then(() => Promise.reject(new ApiError(`${box} is offline`, 503)));
  const h = helperOf(plugin, box);
  if (method === "GET") return delay(statusOf(plugin, box));
  if (h.state === "unsupported") return delay(null).then(() => Promise.reject(new ApiError(`${box} runs a berthd from before helpers; update it first`, 409, "helper_unsupported")));
  h.timers.forEach((t) => window.clearTimeout(t));
  h.timers = [];
  if (method === "POST") {
    h.state = "installing";
    h.error = undefined;
    const then = (ms: number, next: () => void) => h.timers.push(window.setTimeout(next, ms));
    if (scenario === "failed") {
      then(900, () => {
        h.state = "failed";
        h.error = "berth-leadline for linux-amd64 does not match its checksum; nothing was installed";
      });
    } else {
      then(900, () => {
        h.state = "starting";
        h.version = LATEST;
      });
      then(1500, () => {
        h.state = "running";
      });
    }
    return delay(statusOf(plugin, box));
  }
  if (method === "DELETE") {
    const purge = query.get("purge") === "1";
    h.state = purge ? "none" : "off";
    h.error = undefined;
    if (purge) h.purged = true;
    return delay(statusOf(plugin, box));
  }
  return undefined;
}

type Row = Record<string, unknown>;

interface Fixture {
  captured_ms: number;
  source: string;
  health: Row;
  storage: Row;
  sources: { sources: Row[]; services: Row[]; proxies: Row[]; [k: string]: unknown };
  queries: Row[];
  control: Row[];
  query_details: { stats: Row; [k: string]: unknown }[];
  traces: Row[];
  trace_details: Row[];
  logs: Row[];
  endpoints: { rows: Row[]; [k: string]: unknown };
  endpoint_details: { stats: Row; [k: string]: unknown }[];
}

// The project's main checkout on devl, which has no agent in it: the same
// telemetry under its own name (the project's alone), as traces of its own.
const MAIN = "shop";

let fixtures: Promise<Fixture[]> | undefined;
// Read as text: 180 KB of JSON parses faster than it compiles.
const load = () =>
  (fixtures ??= import("@/lib/fixtures/leadline.json?raw").then((m) => {
    const first = JSON.parse(m.default) as Fixture;
    const main = JSON.parse(m.default.replaceAll(`"${first.source}`, `"${MAIN}`).replace(/[0-9a-f]{32}/g, (id) => [...id].reverse().join(""))) as Fixture;
    main.sources.sources = main.sources.sources.map(({ worktree: _, ...s }) => ({ ...s, branch: "main" }));
    return [first, main];
  }));

// The fields that hold a moment (unix ms), as against a length of time.
const MOMENTS = new Set(["start_ms", "ts_ms", "last_ms", "last_seen_ms", "last_activity_ms", "now_ms", "since_ms", "oldest_ms"]);

// moved is v with every moment in it by milliseconds later.
function moved<T>(v: T, by: number, key = ""): T {
  if (Array.isArray(v)) return v.map((x) => (key === "t" && typeof x === "number" ? x + by : moved(x, by))) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "number" && MOMENTS.has(k) && x > 0 ? x + by : moved(x, by, k)])) as T;
  return v;
}

// A helper's own refusal, as the box passes it through and the app's HTTP
// client reads it: the words are inside "error" (lib/helper.ts lifts them out).
function refusal(status: number, code: string, message: string): ApiError {
  const err = new ApiError(String({}), status);
  err.detail = { error: { code, message } };
  return err;
}

const SEVERITY: Record<string, number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };
const has = (text: unknown, q: string) => !q || String(text ?? "").toLowerCase().includes(q.toLowerCase());
const num = (q: URLSearchParams, k: string, fallback: number) => {
  const n = Number(q.get(k));
  return q.get(k) && Number.isFinite(n) ? n : fallback;
};

// A page of a list ordered by time: the rows after the cursor's.
function page(rows: Row[], q: URLSearchParams, limit: number): Row[] {
  const before = q.get("before");
  const from = before ? rows.findIndex((r) => r.cursor === before) + 1 : 0;
  if (before && from === 0) throw refusal(400, "bad_request", "before is not a cursor of this list.");
  return rows.slice(from, from + limit);
}

const EMPTY_DETAIL = { stats: null, series: { bucket_ms: 0, t: [] }, histogram: { per_decade: 10, bins: [] }, endpoints: [], traces: [], n_plus_one: [], queries: [], slowest: [], failing: [] };

function answer(all: Fixture[], route: string, q: URLSearchParams, empty: boolean): unknown {
  const source = q.get("source") ?? "";
  // Two worktrees have sent anything: the fixture's, and its main checkout.
  const f = all.find((x) => x.source === source) ?? all[0];
  const mine = !empty && (!source || source === f.source);
  const since = num(q, "since_ms", 0);
  const text = q.get("q") ?? "";
  switch (route) {
    case "health":
      return f.health;
    case "storage":
      return mine ? f.storage : { ...f.storage, size_bytes: 0, file_bytes: 4096, oldest_ms: 0 };
    case "sources": {
      const heard = !mine ? [] : source ? [f] : [...all].sort((a, b) => a.source.localeCompare(b.source));
      return { ...f.sources, total: heard.length, sources: heard.flatMap((x) => x.sources.sources), services: heard.flatMap((x) => x.sources.services), proxies: [] };
    }
    case "queries": {
      const rows = !mine ? [] : (q.get("control") === "1" ? f.control : f.queries).filter((r) => has(r.fingerprint, text) || has(r.example, text));
      const offset = num(q, "offset", 0);
      return rows.slice(offset, offset + num(q, "limit", 200));
    }
    case "queries/detail":
      return (mine && f.query_details.find((d) => d.stats.fingerprint === q.get("fingerprint") && d.stats.db_system === (q.get("db_system") ?? ""))) || EMPTY_DETAIL;
    case "traces": {
      const min = num(q, "min_duration_ms", 0);
      const rows = !mine ? [] : f.traces.filter((r) => has(r.name, text) && (q.get("errors") !== "1" || Number(r.errors) > 0) && Number(r.duration_ms) >= min && Number(r.start_ms) >= since);
      return page(rows, q, num(q, "limit", 200));
    }
    case "logs": {
      const min = num(q, "min_severity", 0);
      const rows = !mine ? [] : f.logs.filter((r) => has(r.body, text) && (SEVERITY[String(r.severity)] ?? 9) >= min && Number(r.ts_ms) >= since);
      return page(rows, q, num(q, "limit", 500));
    }
    case "endpoints": {
      const keys: Record<string, string> = { time: "total_ms", name: "name", service: "service", requests: "requests", avg: "avg_ms", p50: "p50_ms", p95: "p95_ms", max: "max_ms", queries: "queries", db: "db_ms" };
      const sort = q.get("sort") ?? "time";
      const value = (r: Row) => (sort === "errors" ? Number(r.errors) / Math.max(1, Number(r.requests)) : (r[keys[sort] ?? "total_ms"] as number | string));
      const dir = q.get("dir") === "asc" ? 1 : -1;
      const rows = !mine ? [] : f.endpoints.rows.filter((r) => has(r.name, text)).sort((a, b) => (value(a) < value(b) ? -dir : value(a) > value(b) ? dir : 0));
      const offset = num(q, "offset", 0);
      return { ...f.endpoints, total: rows.length, rows: rows.slice(offset, offset + num(q, "limit", 200)) };
    }
    case "endpoints/detail":
      return (mine && f.endpoint_details.find((d) => d.stats.name === q.get("name") && d.stats.service === (q.get("endpoint_service") ?? ""))) || EMPTY_DETAIL;
    default: {
      const trace = /^traces\/([0-9a-f]{32})$/.exec(route);
      const found = trace && !empty && all.flatMap((x) => x.trace_details).find((d) => d.trace_id === trace[1]);
      if (found) return found;
      throw refusal(404, "not_found", trace ? "No such trace: it may have aged out." : `No such route: /api/${route}.`);
    }
  }
}

// helperBoxCall answers a box's helpers/{plugin}/api/{path}, or undefined
// for any other path. {path} is the path on the helper, and its API is
// under /api/ there.
export function helperBoxCall(box: string, method: string, path: string, delay: Delay): Promise<unknown> | undefined {
  const to = helperRelayed(path);
  if (!to) return undefined;
  const { plugin } = to;
  const h = helperOf(plugin, box);
  if (h.state !== "running") return delay(null).then(() => Promise.reject(new ApiError(`${plugin}'s helper isn't running on ${box}`, 409, "helper_off")));
  // Outside /api/ the helper answers as a plain web server does, and the
  // laptop agent takes a plain 404 from a box for a berthd too old to know
  // the route: so it reads to the app, as it does with real ones.
  if (!to.path.startsWith("/api/")) return delay(null).then(() => Promise.reject(new ApiError(`${box} runs an older berthd that doesn't have this yet`, 404, "box_outdated")));
  const route = to.path.slice("/api/".length).replace(/\/+$/, "");
  if (method !== "GET" || plugin !== "leadline") return delay(null).then(() => Promise.reject(refusal(404, "not_found", `No such route: ${method} /api/${route}.`)));
  // Only devl's has heard from anything, until what it recorded is removed.
  const empty = box !== "devl" || !!h.purged;
  return load().then((all) => {
    const by = Date.now() - all[0].captured_ms;
    // Asked for in moved time; the fixture is filtered in its own.
    const q = new URLSearchParams(to.query);
    if (q.get("since_ms")) q.set("since_ms", String(Number(q.get("since_ms")) - by));
    return delay(moved(answer(all, route, q, empty), by));
  });
}
