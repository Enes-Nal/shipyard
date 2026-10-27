// The diagnostics report: one short, redacted text someone can paste into a
// chat when something is wrong. The app's Copy diagnostics (lib/diagnostics)
// and `berth doctor --report` print the same text: this file mirrors
// internal/doctor/report.go line for line, and both are held to
// internal/doctor/testdata/diagnostics.golden (diagnostics.test.ts).
// No imports, so node's test runner reads it as it is.

export interface DiagCheck {
  area?: string;
  name: string;
  status: string;
  detail?: string;
  fix?: string;
}

export interface DiagEvent {
  at: string;
  kind?: string;
  code?: string;
  title: string;
  message?: string;
}

export interface DiagApp {
  version?: string;
  build?: string;
  os?: string;
  arch?: string;
  renderer?: string;
  chosen?: string;
  renderer_reason?: string;
  theme?: string;
  labs: boolean;
  zen: boolean;
  agent_view?: string;
  errors?: DiagEvent[];
  toasts?: DiagEvent[];
}

export interface Diagnostics {
  generated: string;
  // Redacted to ~ wherever it appears; never printed.
  home?: string;
  app?: DiagApp | null;
  agent: { version?: string; build?: string; state?: string; error?: string };
  doctor?: DiagCheck[] | null;
  doctor_error?: string;
  local_box?: { name: string; state?: string; version?: string; error?: string; checks?: DiagCheck[] | null } | null;
  boxes?: { name: string; state?: string; version?: string; build?: string; capabilities?: string[] | null; error?: string }[] | null;
}

// How many errors and toasts the report keeps, newest last.
const RECENT = 8;
// The longest one detail runs before it is cut with "…".
const MAX_DETAIL = 160;

const MARKS: Record<string, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function formatDiagnostics(d: Diagnostics): string {
  const l: string[] = [];
  const add = (s: string) => l.push(s);
  add(`Shipkit diagnostics · ${stamp(d.generated)}`);
  const a = d.app ?? undefined;
  if (!a) add("App: not recorded (open Shipkit once)");
  else {
    let line = `App: ${or(a.version, "unknown")}`;
    if (a.build) line += ` (build ${a.build})`;
    if (a.os) line += ` · ${a.os}`;
    if (a.arch) line += ` ${a.arch}`;
    add(line);
  }
  let agent = `Agent: ${or(d.agent.state, "unknown")}`;
  if (d.agent.version) agent += ` · berth ${d.agent.version}`;
  if (d.agent.build) agent += ` (build ${d.agent.build})`;
  if (d.agent.error) agent += ` · ${clip(d.agent.error)}`;
  add(agent);
  if (a) {
    add(`Terminal: ${terminal(a)}`);
    let look = `Look: theme ${or(a.theme, "default")} · Labs ${onOff(a.labs)}`;
    if (a.labs) look += ` (agents as ${or(a.agent_view, "terminal")}, zen ${onOff(a.zen)})`;
    add(look);
  }

  add("");
  add("Laptop (berth doctor)");
  const checks = d.doctor ?? [];
  if (d.doctor_error) add(`  ${clip(d.doctor_error)}`);
  else if (!checks.length) add("  no checks");
  for (const c of checks) add(checkLine(c));

  add("");
  const b = d.local_box ?? undefined;
  if (!b) add("Local box: none");
  else {
    let line = `Local box ${b.name} · ${or(b.state, "unknown")}`;
    if (b.version) line += ` · berthd ${b.version}`;
    if (b.error) line += ` · ${clip(b.error)}`;
    add(line);
    for (const c of b.checks ?? []) add(checkLine(c));
  }

  add("");
  const boxes = d.boxes ?? [];
  add(`Boxes (${boxes.length})`);
  if (!boxes.length) add("  none paired");
  for (const x of boxes) {
    let line = `  ${x.name} · ${or(x.state, "unknown")}`;
    const ver = [x.version, x.build && `(${x.build})`].filter(Boolean);
    if (ver.length) line += ` · ${ver.join(" ")}`;
    if (x.capabilities?.length) line += ` · caps: ${x.capabilities.join(" ")}`;
    if (x.error) line += ` · last error: ${clip(x.error)}`;
    add(line);
  }

  const events = (name: string, list: DiagEvent[], code: boolean) => {
    add("");
    if (!list.length) {
      add(`${name}: none`);
      return;
    }
    add(`${name} (${list.length})`);
    for (const e of list.slice(-RECENT)) {
      let line = `  ${clock(e.at)} `;
      if (code) line += e.code ? `[${e.code}] ` : "";
      else line += `${or(e.kind, "info")} `;
      let text = flat(e.title);
      const m = flat(e.message ?? "");
      if (m) text += `: ${m}`;
      add(line + clip(text));
    }
  };
  events("Recent errors", a?.errors ?? [], true);
  events("Recent toasts", a?.toasts ?? [], false);
  return redact(`${l.join("\n")}\n`, d.home ?? "");
}

function checkLine(c: DiagCheck): string {
  let line = `  ${MARKS[c.status] ?? "?"} ${c.name}`;
  const d = flat(c.detail ?? "");
  if (d) line += `  ${clip(d)}`;
  if (c.fix && c.status !== "ok") line += ` → ${clip(flat(c.fix))}`;
  return line;
}

function terminal(a: DiagApp): string {
  if (!a.renderer) return "not started yet";
  if (a.renderer === "xterm" && a.chosen === "ghostty") return `xterm.js (ghostty-web failed: ${clip(or(flat(a.renderer_reason ?? ""), "no reason given"))})`;
  if (a.renderer === "xterm") return "xterm.js (chosen in Settings)";
  if (a.renderer === "ghostty") return "ghostty-web";
  return a.renderer;
}

// RFC 3339, as Go's time.Parse takes it.
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const parse = (s: string) => (RFC3339.test(s) ? new Date(s) : undefined);

function stamp(s: string): string {
  const t = parse(s);
  return t && !Number.isNaN(t.getTime()) ? `${t.toISOString().slice(0, 16).replace("T", " ")} UTC` : or(s, "unknown time");
}

function clock(s: string): string {
  const t = parse(s);
  return t && !Number.isNaN(t.getTime()) ? t.toISOString().slice(11, 16) : "--:--";
}

const or = (s: string | undefined, fallback: string) => s || fallback;
const onOff = (b: boolean) => (b ? "on" : "off");
// flat puts text on one line.
const flat = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
// clip cuts text longer than MAX_DETAIL characters.
function clip(s: string): string {
  const r = Array.from(s);
  return r.length <= MAX_DETAIL ? s : `${r.slice(0, MAX_DETAIL - 1).join("")}…`;
}

const USER_PATH = /(?:\/Users\/|\/home\/)[^/\s:"']+/g;
const WIN_USER_PATH = /[A-Za-z]:\\Users\\[^\\\s"']+/g;
const OP_REF = /op:\/\/[^\s"'<>]+/g;
const URL_USER = /:\/\/[^/\s:@]+:[^/\s@]+@/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const KEY_VALUE = /(token|secret|password|passwd|api[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi;
const BEARER = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi;
const LONG_RUN = /[A-Za-z0-9_+=-]{32,}/g;

// redact takes out what a report must not carry: the home folder and any
// other account's home (as ~), 1Password references, a URL's user and
// password, email addresses, tokens and passwords given as key=value or
// Bearer, and long runs of letters and digits that look like a key. Paths
// keep their shape: a run stops at "/", so only one long segment would go.
export function redact(s: string, home = ""): string {
  home = home.replace(/[/\\]+$/, "");
  if (home.length > 1) s = s.split(home).join("~");
  return s
    .replace(USER_PATH, "~")
    .replace(WIN_USER_PATH, "~")
    .replace(OP_REF, "op://[redacted]")
    .replace(URL_USER, "://[redacted]@")
    .replace(EMAIL, "[email]")
    .replace(KEY_VALUE, "$1$2[redacted]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(LONG_RUN, (m) => (/[A-Za-z]/.test(m) && /[0-9]/.test(m) ? "[redacted]" : m));
}
