// ../plugins/usage/src/index.tsx
import { definePlugin, useBoxes, useCurrentWorktree as useCurrentWorktree2, useLocations, useStorage } from "@berth/plugin";
import { Alert as Alert2, AlertDescription as AlertDescription2, BoxFilter, Button as Button3, Icon as Icon3, PickOne as PickOne2, Tooltip, TooltipPopup, TooltipTrigger, ViewHeader } from "@berth/plugin/ui";
import { useCallback, useEffect as useEffect2, useRef as useRef2, useState as useState4 } from "react";

// ../plugins/usage/src/accounts-view.tsx
import { sessionName, useCurrentWorktree, useSessions, worktreeLocation } from "@berth/plugin";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Icon,
  Input,
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Skeleton,
  cn as cn2
} from "@berth/plugin/ui";
import { useState as useState2 } from "react";

// ../plugins/usage/box/usage.py
var usage_default = `"""Usage and accounts for the Usage plugin, run on a box through exec.

  usage.py report [DAYS]      token usage from Claude Code and Codex transcripts
  usage.py accounts           logins per agent, and which one each session uses
  usage.py mkaccount AGENT NAME   an empty account folder to sign in to

Only counts and labels leave the box: never prompts, transcripts or
credentials. Account details are the email and plan the agents record about
the signed-in user. Each transcript's summary is cached by size and
modification time under ~/.cache/berth-usage, so a report reads only what
changed; a first run on a box with years of transcripts may need a few runs
(it reports \`partial\`).
"""
import base64
import datetime as dt
import glob
import json
import os
import pathlib
import re
import subprocess
import sys
import time

HOME = pathlib.Path.home()
CACHE = HOME / ".cache" / "berth-usage" / "files.json"
ACCOUNTS = HOME / ".berth" / "accounts"
BUDGET_S = float(os.environ.get("BERTH_USAGE_BUDGET", "45"))
MAX_OUT = 60_000
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
# Bump when the parsers change, so cached summaries are read again.
CACHE_VERSION = 2


def local_day(ts):
    try:
        t = dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return t.astimezone().date().isoformat()
    except ValueError:
        return None


def iso(ts):
    try:
        return dt.datetime.fromisoformat(str(ts).replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


# --- accounts ----------------------------------------------------------------


# "default" is always the agent's own folder: this script runs through exec,
# in a worktree whose environment may already pick another account.
def claude_dirs():
    default = HOME / ".claude"
    out = [("default", default)]
    out += [(p.name, p) for p in sorted((ACCOUNTS / "claude").glob("*")) if p.is_dir()]
    return out


def codex_dirs():
    default = HOME / ".codex"
    out = [("default", default)]
    out += [(p.name, p) for p in sorted((ACCOUNTS / "codex").glob("*")) if p.is_dir()]
    return out


def read_json(p):
    try:
        return json.loads(pathlib.Path(p).read_text())
    except (OSError, ValueError):
        return None


def jwt_claims(token):
    try:
        part = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
    except (IndexError, ValueError, TypeError):
        return {}


def claude_account(name, d):
    # The default login keeps its profile beside the home folder; another
    # config folder keeps it inside.
    profile = read_json(HOME / ".claude.json") if name == "default" else read_json(d / ".claude.json")
    o = (profile or {}).get("oauthAccount") or {}
    tier = o.get("userRateLimitTier") or o.get("organizationRateLimitTier") or ""
    return {
        "agent": "claude", "id": name, "dir": str(d), "exists": d.is_dir(),
        "signed_in": bool(o),
        "email": o.get("emailAddress"), "name": o.get("displayName"),
        "org": o.get("organizationName"), "billing": o.get("billingType"), "tier": tier or None,
    }


def codex_account(name, d):
    auth = read_json(d / "auth.json") or {}
    claims = jwt_claims(((auth.get("tokens") or {}).get("id_token")) or "")
    plan = (claims.get("https://api.openai.com/auth") or {}).get("chatgpt_plan_type")
    method = "chatgpt" if auth.get("tokens") else ("api key" if auth.get("OPENAI_API_KEY") else None)
    return {
        "agent": "codex", "id": name, "dir": str(d), "exists": d.is_dir(),
        "signed_in": bool(method), "method": method,
        "email": claims.get("email"), "plan": plan,
    }


def session_accounts():
    """Which account each berth session was started with, from its tmux
    environment. A session without one uses the box default."""
    out = {}
    try:
        names = subprocess.run(["tmux", "-L", "berth", "list-sessions", "-F", "#{session_name}"], capture_output=True, text=True, timeout=10).stdout.split()
    except (OSError, subprocess.TimeoutExpired):
        return out
    for n in names:
        try:
            env = subprocess.run(["tmux", "-L", "berth", "show-environment", "-t", "=" + n], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.TimeoutExpired):
            continue
        row = {}
        for line in env.splitlines():
            k, _, v = line.partition("=")
            if k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
                row[k] = v
        out[n] = row
    return out


def accounts():
    rows = [claude_account(n, d) for n, d in claude_dirs()] + [codex_account(n, d) for n, d in codex_dirs()]
    return {"accounts": rows, "sessions": session_accounts(), "home": str(HOME)}


def mkaccount(agent, name):
    if agent not in ("claude", "codex") or not NAME.match(name or "") or name == "default":
        raise SystemExit("usage: mkaccount claude|codex NAME (lowercase letters, digits, dashes)")
    d = ACCOUNTS / agent / name
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    return {"agent": agent, "id": name, "dir": str(d)}


# --- transcripts -------------------------------------------------------------


def add(bucket, day, model, tokens):
    if not day or not any(tokens):
        return
    m = bucket.setdefault(day, {}).setdefault(model or "unknown", [0, 0, 0, 0])
    for i, v in enumerate(tokens):
        m[i] += int(v or 0)


def claude_file(path):
    """A Claude Code transcript's usage: tokens are [input, output,
    cache read, cache write] by day and model. Streamed messages repeat
    their usage, so each message counts once."""
    s = {"sid": None, "cwd": None, "title": None, "first": None, "last": None, "cost": None, "days": {}}
    seen = set()
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line and '"cost-state"' not in line and '"ai-title"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            t = o.get("type")
            s["sid"] = s["sid"] or o.get("sessionId")
            if t == "cost-state":
                s["cost"] = o.get("totalCostUSD")
            elif t == "ai-title":
                s["title"] = (o.get("aiTitle") or o.get("title") or s["title"])
            elif t == "assistant":
                m = o.get("message") or {}
                u = m.get("usage")
                if not u:
                    continue
                key = (m.get("id"), o.get("requestId"))
                if key in seen:
                    continue
                seen.add(key)
                s["cwd"] = s["cwd"] or o.get("cwd")
                ts = o.get("timestamp")
                s["first"] = s["first"] or iso(ts)
                s["last"] = iso(ts) or s["last"]
                add(s["days"], local_day(ts), m.get("model"), [u.get("input_tokens"), u.get("output_tokens"), u.get("cache_read_input_tokens"), u.get("cache_creation_input_tokens")])
    if isinstance(s["title"], str):
        s["title"] = s["title"][:120]
    return s


def codex_file(path):
    """A Codex session's usage, from the growth of its running totals
    between token_count events, and its latest rate-limit window."""
    s = {"sid": None, "cwd": None, "title": None, "first": None, "last": None, "cost": None, "days": {}, "limits": None, "limits_at": None}
    model, prev = None, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if "token_count" not in line and '"turn_context"' not in line and '"session_meta"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            p = o.get("payload") or {}
            if o.get("type") == "session_meta":
                s["sid"] = p.get("id") or p.get("session_id")
                s["cwd"] = p.get("cwd")
            elif o.get("type") == "turn_context":
                model = p.get("model") or model
                s["cwd"] = s["cwd"] or p.get("cwd")
            elif p.get("type") == "token_count":
                ts = o.get("timestamp")
                if p.get("rate_limits"):
                    s["limits"], s["limits_at"] = p["rate_limits"], iso(ts)
                total = ((p.get("info") or {}).get("total_token_usage")) or None
                if not total:
                    continue
                if prev is not None and total == prev:
                    continue
                d = {k: max(0, int(total.get(k) or 0) - int((prev or {}).get(k) or 0)) for k in ("input_tokens", "cached_input_tokens", "output_tokens", "cache_write_input_tokens")}
                prev = total
                s["first"] = s["first"] or iso(ts)
                s["last"] = iso(ts) or s["last"]
                # Codex counts cached input inside input; split them.
                add(s["days"], local_day(ts), model, [d["input_tokens"] - d["cached_input_tokens"], d["output_tokens"], d["cached_input_tokens"], d["cache_write_input_tokens"]])
    return s


def report(days):
    started = time.monotonic()
    CACHE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache = read_json(CACHE) or {}
    if cache.get("_version") != CACHE_VERSION:
        cache = {}
    files = []
    for name, d in claude_dirs():
        files += [("claude", name, p) for p in glob.glob(str(d / "projects" / "**" / "*.jsonl"), recursive=True)]
    for name, d in codex_dirs():
        for sub in ("sessions", "archived_sessions"):
            files += [("codex", name, p) for p in glob.glob(str(d / sub / "**" / "*.jsonl"), recursive=True)]
    cutoff = time.time() - days * 86400
    pending, fresh, live = 0, {}, set()
    # Newest first, so a run that hits its budget has the recent ones.
    for agent, account, path in sorted(files, key=lambda f: -os.path.getmtime(f[2]) if os.path.exists(f[2]) else 0):
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime < cutoff:
            continue
        live.add(path)
        key = f"{st.st_size}:{int(st.st_mtime)}"
        hit = cache.get(path)
        if hit and hit.get("key") == key:
            fresh[path] = hit
            continue
        if time.monotonic() - started > BUDGET_S:
            pending += 1
            continue
        try:
            summary = (claude_file if agent == "claude" else codex_file)(path)
        except OSError:
            continue
        fresh[path] = {"key": key, "agent": agent, "account": account, "s": summary}
    # Two reads at once each write their own file; the last one wins, and a
    # cache that can't be saved only means the next read is slower.
    tmp = CACHE.with_name(f"files.{os.getpid()}.tmp")
    try:
        tmp.write_text(json.dumps({"_version": CACHE_VERSION, **fresh}))
        tmp.replace(CACHE)
    except OSError:
        tmp.unlink(missing_ok=True)

    since = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    daily, sessions, limits = {}, {}, {}
    for path, e in fresh.items():
        s, agent, account = e["s"], e["agent"], e["account"]
        for day, models in s["days"].items():
            if day < since:
                continue
            for model, t in models.items():
                if not any(t):
                    continue
                k = (day, agent, account, model, s["cwd"] or "")
                acc = daily.setdefault(k, [0, 0, 0, 0])
                for i in range(4):
                    acc[i] += t[i]
        sid = s["sid"] or os.path.basename(path)
        tot = [sum(m[i] for d in s["days"].values() for m in d.values()) for i in range(4)]
        if not any(tot):
            continue
        row = sessions.setdefault((agent, sid), {"agent": agent, "account": account, "id": sid, "cwd": s["cwd"], "title": s["title"], "first": s["first"], "last": s["last"], "tokens": [0, 0, 0, 0], "cost": None, "models": []})
        for i in range(4):
            row["tokens"][i] += tot[i]
        if s["cost"] is not None:
            row["cost"] = (row["cost"] or 0) + s["cost"]
        row["first"] = min(filter(None, [row["first"], s["first"]]), default=None)
        row["last"] = max(filter(None, [row["last"], s["last"]]), default=None)
        row["title"] = row["title"] or s["title"]
        for d in s["days"].values():
            for m in d:
                if m not in row["models"]:
                    row["models"].append(m)
        if s.get("limits") and (account not in limits or s["limits_at"] > limits[account]["at"]):
            limits[account] = {"agent": agent, "account": account, "at": s["limits_at"], "limits": s["limits"]}

    out = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "days": days, "since": since, "today": dt.date.today().isoformat(), "tz": time.strftime("%Z"),
        "partial": pending > 0, "pending": pending, "files": len(live),
        "columns": ["input", "output", "cache_read", "cache_write"],
        "daily": [[*k, *v] for k, v in sorted(daily.items())],
        "sessions": sorted(sessions.values(), key=lambda r: r["last"] or "", reverse=True),
        "limits": list(limits.values()),
    }
    # Fit exec's output: drop the oldest sessions until it does.
    text = json.dumps(out, separators=(",", ":"))
    while len(text) > MAX_OUT and out["sessions"]:
        out["sessions"] = out["sessions"][: max(0, len(out["sessions"]) * 3 // 4)]
        out["truncated"] = True
        text = json.dumps(out, separators=(",", ":"))
    return text


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "report":
        print(report(max(1, min(90, int(argv[2]) if len(argv) > 2 else 30))))
    elif cmd == "accounts":
        print(json.dumps(accounts(), separators=(",", ":")))
    elif cmd == "mkaccount":
        print(json.dumps(mkaccount(*(argv[2:4] + [None, None])[:2])))
    else:
        raise SystemExit("usage: usage.py report [DAYS] | accounts | mkaccount AGENT NAME")


if __name__ == "__main__":
    main(sys.argv)
`;

// ../plugins/usage/src/box.ts
var ACCOUNT_VAR = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
var encoded = (() => {
  const bytes = new TextEncoder().encode(usage_default);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
})();
async function where(berth, box, prefer) {
  const locs = await berth.api.locations(box);
  if (prefer && locs.some((l) => l.name === prefer.split("/")[0])) return prefer;
  if (!locs.length) throw new Error(`${box} has no projects yet; add one to read its usage`);
  return locs[0].name;
}
async function runScript(berth, box, location, args, timeout = "5m") {
  const argv = JSON.stringify(["usage.py", ...args]).replace(/"/g, '\\"');
  const command = `python3 -c "import base64,json,sys;sys.argv=json.loads('${argv.replace(/'/g, "")}');exec(base64.b64decode('${encoded}'))"`;
  const r = await berth.orchestrate.exec(box, location, command, timeout);
  if (r.exit_code === 127 || /python3: (command )?not found/.test(r.output)) throw new Error(`${box} has no python3, which reading usage needs`);
  if (r.exit_code !== 0) throw new Error(r.output.trim().split("\n").slice(-3).join("\n") || `exit ${r.exit_code}`);
  try {
    return JSON.parse(r.output.trim().split("\n").pop() ?? "");
  } catch {
    throw new Error("the box answered something that isn't usage data");
  }
}

// ../plugins/usage/src/chart.tsx
import { cn } from "@berth/plugin/ui";
import { useEffect, useRef, useState } from "react";

// ../plugins/usage/src/data.ts
var AGENT_NAME = { claude: "Claude Code", codex: "Codex" };
var total = (t) => t[0] + t[1] + t[2] + t[3];
var add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
var zero = () => [0, 0, 0, 0];
function firstDay(today, period) {
  const d = /* @__PURE__ */ new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - (period - 1));
  return d.toISOString().slice(0, 10);
}
function days(today, period) {
  const out = [];
  const start = /* @__PURE__ */ new Date(firstDay(today, period) + "T00:00:00Z");
  for (let i = 0; i < period; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function worktreeOf(dir, locations) {
  if (!dir) return { label: "Unknown folder" };
  let best;
  let depth = -1;
  for (const l of locations) {
    for (const w of l.worktrees ?? []) {
      if ((dir === w.path || dir.startsWith(w.path + "/")) && w.path.length > depth) {
        depth = w.path.length;
        best = { label: w.main ? l.name : `${l.name}/${w.name}`, location: l.name, worktree: w.name, path: w.path, main: w.main };
      }
    }
  }
  return best ?? { label: dir.replace(/^\/(home|Users)\/[^/]+/, "~") };
}
function summarize(sources, period) {
  const byAgent = /* @__PURE__ */ new Map();
  const byAgentBox = /* @__PURE__ */ new Map();
  const byModel = /* @__PURE__ */ new Map();
  const byWorktree = /* @__PURE__ */ new Map();
  const byDay = /* @__PURE__ */ new Map();
  const byDayBox = /* @__PURE__ */ new Map();
  const sessions = [];
  let today = "";
  const bump = (m, day, k, n) => {
    const d = m.get(day) ?? /* @__PURE__ */ new Map();
    d.set(k, (d.get(k) ?? 0) + n);
    m.set(day, d);
  };
  for (const { box, report: r, locations } of sources) {
    if (r.today > today) today = r.today;
    const from = firstDay(r.today, period);
    for (const [day, agent, , model, cwd, ...t] of r.daily) {
      if (day < from) continue;
      const n = t[0] + t[1] + t[2] + t[3];
      byAgent.set(agent, add(byAgent.get(agent) ?? zero(), t));
      const ab = byAgentBox.get(agent) ?? /* @__PURE__ */ new Map();
      ab.set(box, (ab.get(box) ?? 0) + n);
      byAgentBox.set(agent, ab);
      const mk = `${agent}\0${model}\0${box}`;
      const m = byModel.get(mk) ?? { agent, model, box, tokens: zero() };
      m.tokens = add(m.tokens, t);
      byModel.set(mk, m);
      const name = worktreeOf(cwd, locations);
      const wk = `${box}\0${name.label}`;
      const w = byWorktree.get(wk) ?? { box, name, tokens: zero(), sessions: 0 };
      w.tokens = add(w.tokens, t);
      byWorktree.set(wk, w);
      bump(byDay, day, agent, n);
      bump(byDayBox, day, box, n);
    }
    for (const s of r.sessions) {
      if ((s.last ?? "") < from) continue;
      sessions.push({ ...s, box });
      const w = byWorktree.get(`${box}\0${worktreeOf(s.cwd, locations).label}`);
      if (w) w.sessions++;
    }
  }
  return {
    byAgent,
    byAgentBox,
    byModel: [...byModel.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
    byWorktree: [...byWorktree.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
    byDay,
    byDayBox,
    sessions: sessions.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "")),
    today
  };
}
function compact(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}
var usd = (n) => n < 0.01 ? "<$0.01" : `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1e3);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function plan(a) {
  if (!a) return void 0;
  if (a.agent === "claude") {
    const t = (a.tier ?? "").toLowerCase();
    const max = /max_(\d+)x/.exec(t);
    const label = max ? `Claude Max ${max[1]}x` : t.includes("pro") ? "Claude Pro" : a.billing === "stripe_subscription" ? "Claude subscription" : a.billing ? a.billing.replace(/_/g, " ") : "Claude";
    return { label, subscription: a.billing === "stripe_subscription" || Boolean(max) };
  }
  if (a.method === "api key") return { label: "OpenAI API key", subscription: false };
  return a.plan ? { label: `ChatGPT ${a.plan.charAt(0).toUpperCase()}${a.plan.slice(1)}`, subscription: true } : void 0;
}

// ../plugins/usage/src/chart.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var SERIES = {
  claude: { fill: "fill-[#eb6834] dark:fill-[#d95926]", dot: "bg-[#eb6834] dark:bg-[#d95926]" },
  codex: { fill: "fill-[#2a78d6] dark:fill-[#3987e5]", dot: "bg-[#2a78d6] dark:bg-[#3987e5]" }
};
var BOX_HUES = [
  { fill: "fill-[#1baf7a] dark:fill-[#199e70]", dot: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { fill: "fill-[#eda100] dark:fill-[#c98500]", dot: "bg-[#eda100] dark:bg-[#c98500]" },
  { fill: "fill-[#e87ba4] dark:fill-[#d55181]", dot: "bg-[#e87ba4] dark:bg-[#d55181]" },
  { fill: "fill-[#008300] dark:fill-[#008300]", dot: "bg-[#008300] dark:bg-[#008300]" },
  { fill: "fill-[#4a3aa7] dark:fill-[#9085e9]", dot: "bg-[#4a3aa7] dark:bg-[#9085e9]" }
];
var OTHER = { fill: "fill-muted-foreground/60", dot: "bg-muted-foreground/60" };
var OTHER_BOXES = "\0other";
var agentSeries = () => ["claude", "codex"].map((a) => ({ key: a, label: AGENT_NAME[a], ...SERIES[a] }));
function boxColor(box, allBoxes) {
  const i = [...allBoxes].sort().indexOf(box);
  return i >= 0 && i < BOX_HUES.length ? BOX_HUES[i] : OTHER;
}
function boxSeries(counted, allBoxes) {
  const sorted = [...allBoxes].sort();
  const named = counted.filter((b) => sorted.indexOf(b) < BOX_HUES.length).sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
  const out = named.map((b) => ({ key: b, label: b, ...boxColor(b, allBoxes) }));
  if (counted.length > named.length) out.push({ key: OTHER_BOXES, label: "Other boxes", ...OTHER });
  return out;
}
var H = 140;
function dayLabel(d) {
  return (/* @__PURE__ */ new Date(d + "T00:00:00Z")).toLocaleDateString(void 0, { month: "short", day: "numeric", timeZone: "UTC" });
}
function DailyChart({ days: days2, byDay, series }) {
  const [hover, setHover] = useState();
  const ref = useRef(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const value = (d, k) => byDay.get(d)?.get(k) ?? 0;
  const present = series.filter((s) => days2.some((d) => value(d, s.key) > 0));
  const totals = days2.map((d) => series.reduce((n, s) => n + value(d, s.key), 0));
  const max = Math.max(1, ...totals);
  const slot = W / days2.length;
  const bar = Math.max(4, Math.min(28, slot - 6));
  const every = Math.ceil(days2.length / Math.max(2, Math.floor(W / 90)));
  return /* @__PURE__ */ jsxs("figure", { ref, className: "relative", children: [
    /* @__PURE__ */ jsxs("div", { className: "mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs", children: [
      present.map((s) => /* @__PURE__ */ jsxs("span", { className: "flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx("span", { className: cn("size-2 rounded-[2px]", s.dot) }),
        s.label
      ] }, s.key)),
      /* @__PURE__ */ jsxs("span", { className: "ml-auto tabular-nums", children: [
        "Busiest day ",
        compact(max),
        " tokens"
      ] })
    ] }),
    /* @__PURE__ */ jsxs("svg", { viewBox: `0 0 ${W} ${H + 18}`, width: W, height: H + 18, className: "block overflow-visible", role: "img", "aria-label": `Tokens per day by ${series.map((s) => s.label).join(", ")}`, onMouseLeave: () => setHover(void 0), children: [
      /* @__PURE__ */ jsx("line", { x1: 0, x2: W, y1: H + 0.5, y2: H + 0.5, className: "stroke-border" }),
      days2.map((d, i) => {
        const x = i * slot + (slot - bar) / 2;
        const segs = series.filter((s) => value(d, s.key) > 0);
        let y = H;
        return /* @__PURE__ */ jsxs("g", { onMouseEnter: () => setHover(i), children: [
          /* @__PURE__ */ jsx("rect", { x: i * slot, y: 0, width: slot, height: H, fill: "transparent" }),
          segs.map((s, j) => {
            const h = Math.max(2, value(d, s.key) / max * (H - 4));
            y -= h;
            const top = j === segs.length - 1;
            return /* @__PURE__ */ jsx("rect", { x, y, width: bar, height: Math.max(1, h - (j > 0 ? 2 : 0)), rx: top ? Math.min(4, bar / 2) : 0, className: cn(s.fill, hover !== void 0 && hover !== i && "opacity-50") }, s.key);
          }),
          (days2.length - 1 - i) % every === 0 && /* @__PURE__ */ jsx("text", { x: i * slot + slot / 2, y: H + 13, textAnchor: "middle", className: "fill-muted-foreground text-[10px]", children: days2.length === 1 ? "Today" : dayLabel(d) })
        ] }, d);
      })
    ] }),
    hover !== void 0 && /* @__PURE__ */ jsxs(
      "div",
      {
        className: "pointer-events-none absolute top-6 z-10 min-w-40 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md",
        style: { left: `clamp(0px, calc(${(hover + 0.5) / days2.length * 100}% - 80px), calc(100% - 170px))` },
        children: [
          /* @__PURE__ */ jsx("div", { className: "mb-1 font-medium", children: dayLabel(days2[hover]) }),
          present.map((s) => /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
            /* @__PURE__ */ jsx("span", { className: cn("size-2 rounded-[2px]", s.dot) }),
            /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: s.label }),
            /* @__PURE__ */ jsx("span", { className: "ml-auto pl-3 tabular-nums", children: compact(value(days2[hover], s.key)) })
          ] }, s.key))
        ]
      }
    )
  ] });
}

// ../plugins/usage/src/accounts-view.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var AGENTS = ["claude", "codex"];
var NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
function accountFor(list, agent, value, home) {
  if (!value) return list.find((a) => a.agent === agent && a.id === "default");
  const dir = value.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home).replace(/\/+$/, "");
  return list.find((a) => a.agent === agent && a.dir.replace(/\/+$/, "") === dir);
}
function loginCommand(agent, dir) {
  return agent === "claude" ? `CLAUDE_CONFIG_DIR='${dir}' claude` : `CODEX_HOME='${dir}' codex login --device-auth`;
}
function AccountsView({
  berth,
  box,
  data,
  choices,
  locations,
  reload
}) {
  const current = useCurrentWorktree();
  const here = current?.box === box ? current : void 0;
  const all = useSessions(box) ?? [];
  const sessions = all.filter((s) => !s.exited && (s.agent === "claude" || s.agent === "codex"));
  const [adding, setAdding] = useState2();
  const [busy, setBusy] = useState2();
  if (!data || !choices) {
    return /* @__PURE__ */ jsxs2("div", { className: "space-y-3", children: [
      /* @__PURE__ */ jsx2(Skeleton, { className: "h-40 w-full" }),
      /* @__PURE__ */ jsx2(Skeleton, { className: "h-40 w-full" })
    ] });
  }
  const run = async (key, fn, done) => {
    setBusy(key);
    try {
      await fn();
      await reload();
      if (done) berth.notify(done);
    } catch (err) {
      berth.notify("That didn't work", String(err.message ?? err));
    } finally {
      setBusy(void 0);
    }
  };
  const useOnBox = (a) => run(`box:${a.agent}:${a.id}`, async () => {
    const doc = await berth.api.request(box, "GET", "env");
    const env = { ...doc.env ?? {} };
    if (a.id === "default") delete env[ACCOUNT_VAR[a.agent]];
    else env[ACCOUNT_VAR[a.agent]] = a.dir;
    await berth.api.request(box, "PUT", "env", { env });
  }, `New ${AGENT_NAME[a.agent]} sessions on ${box} use ${a.id === "default" ? "the default account" : a.id}`);
  const useOnProject = (a, agent, location) => run(`project:${agent}:${a?.id ?? ""}`, async () => {
    const cfg = await berth.api.request(box, "GET", `locations/${encodeURIComponent(location)}/config`);
    const local = { ...cfg.local ?? {} };
    const env = { ...local.env ?? {} };
    if (a) env[ACCOUNT_VAR[agent]] = a.dir;
    else delete env[ACCOUNT_VAR[agent]];
    await berth.api.request(box, "PUT", `locations/${encodeURIComponent(location)}/config`, { local: { ...local, env } });
  }, a ? `New ${AGENT_NAME[agent]} sessions in ${location} use ${a.id}` : `${location} follows the box's ${AGENT_NAME[agent]} account again`);
  const signIn = async (a) => {
    const location = here ? worktreeLocation(here) : locations[0]?.name;
    if (!location) throw new Error(`${box} has no projects to open a terminal in`);
    const s = await berth.api.request(box, "POST", "sessions", { location, command: loginCommand(a.agent, a.dir) });
    berth.openTerminal(box, s.name);
  };
  const add2 = (agent, name) => run(`add:${agent}`, async () => {
    const location = here ? worktreeLocation(here) : locations[0]?.name;
    if (!location) throw new Error(`${box} has no projects yet`);
    const made = await runScript(berth, box, location, ["mkaccount", agent, name], "30s");
    setAdding(void 0);
    await signIn({ agent, dir: made.dir });
  });
  const projectOrder = locations.map((l) => l.name).sort((x, y) => Number(y === here?.location) - Number(x === here?.location));
  const boxAccount = (agent) => accountFor(data.accounts, agent, choices.box[ACCOUNT_VAR[agent]], data.home);
  const projectAccounts = (agent, a) => Object.entries(choices.projects).filter(([, env]) => env[ACCOUNT_VAR[agent]] && accountFor(data.accounts, agent, env[ACCOUNT_VAR[agent]], data.home)?.id === a.id).map(([loc]) => loc);
  return /* @__PURE__ */ jsxs2("div", { className: "space-y-4", children: [
    /* @__PURE__ */ jsxs2(Alert, { children: [
      /* @__PURE__ */ jsx2(Icon, { name: "Info" }),
      /* @__PURE__ */ jsxs2(AlertDescription, { children: [
        "Choosing an account changes the sessions you start next. Sessions that are already running keep the account they started with. Sign-in happens in the agent's own login, in a terminal on ",
        box,
        "; Terminal never sees your credentials."
      ] })
    ] }),
    AGENTS.map((agent) => {
      const list = data.accounts.filter((a) => a.agent === agent);
      const onBox = boxAccount(agent);
      return /* @__PURE__ */ jsxs2(Frame, { variant: "card", children: [
        /* @__PURE__ */ jsxs2(FrameHeader, { className: "flex-row items-center gap-2 py-3", children: [
          /* @__PURE__ */ jsx2("span", { className: cn2("size-2.5 rounded-[3px]", SERIES[agent].dot) }),
          /* @__PURE__ */ jsx2(FrameTitle, { children: AGENT_NAME[agent] }),
          /* @__PURE__ */ jsxs2("span", { className: "text-muted-foreground text-xs", children: [
            "picked with ",
            /* @__PURE__ */ jsx2("code", { className: "font-mono", children: ACCOUNT_VAR[agent] })
          ] }),
          /* @__PURE__ */ jsxs2(Button, { size: "sm", variant: "outline", className: "ml-auto", onClick: () => setAdding(adding === agent ? void 0 : agent), children: [
            /* @__PURE__ */ jsx2(Icon, { name: "Plus" }),
            "Add account\u2026"
          ] })
        ] }),
        /* @__PURE__ */ jsxs2(FramePanel, { className: "p-0", children: [
          adding === agent && /* @__PURE__ */ jsx2(AddAccount, { agent, taken: list.map((a) => a.id), busy: busy === `add:${agent}`, where: here ? `${here.location}/${here.worktree}` : locations[0]?.name, onCancel: () => setAdding(void 0), onAdd: (name) => void add2(agent, name) }),
          /* @__PURE__ */ jsx2("ul", { className: "divide-y", children: list.map((a) => {
            const p = plan(a);
            const projects = projectAccounts(agent, a);
            const isBox = onBox?.id === a.id;
            return /* @__PURE__ */ jsxs2("li", { className: "flex items-center gap-3 px-4 py-3", children: [
              /* @__PURE__ */ jsx2("div", { className: "flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground", children: /* @__PURE__ */ jsx2(Icon, { name: a.signed_in ? "UserRound" : "UserRoundX", className: "size-4" }) }),
              /* @__PURE__ */ jsxs2("div", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsxs2("div", { className: "flex flex-wrap items-center gap-1.5", children: [
                  /* @__PURE__ */ jsx2("span", { className: "font-medium text-sm", children: a.id === "default" ? "Default" : a.id }),
                  a.signed_in ? (a.email || !p) && /* @__PURE__ */ jsx2("span", { className: "truncate text-muted-foreground text-sm", children: a.email ?? "Signed in" }) : /* @__PURE__ */ jsx2(Badge, { variant: "warning", size: "sm", children: "Not signed in" }),
                  p && /* @__PURE__ */ jsx2(Badge, { variant: "outline", size: "sm", children: p.label }),
                  isBox && /* @__PURE__ */ jsx2(Badge, { variant: "info", size: "sm", children: "Box default" }),
                  projects.map((l) => /* @__PURE__ */ jsx2(Badge, { variant: "secondary", size: "sm", children: l }, l))
                ] }),
                /* @__PURE__ */ jsx2("div", { className: "truncate font-mono text-muted-foreground text-xs", children: a.dir.replace(data.home, "~") })
              ] }),
              !a.signed_in && /* @__PURE__ */ jsx2(Button, { size: "sm", variant: "outline", onClick: () => void run(`sign:${agent}:${a.id}`, () => signIn(a)), children: "Sign in\u2026" }),
              /* @__PURE__ */ jsxs2(Menu, { children: [
                /* @__PURE__ */ jsx2(MenuTrigger, { render: /* @__PURE__ */ jsx2(Button, { size: "icon-sm", variant: "ghost", "aria-label": `Use ${a.id} for\u2026`, loading: busy?.endsWith(`:${agent}:${a.id}`) }), children: /* @__PURE__ */ jsx2(Icon, { name: "Ellipsis" }) }),
                /* @__PURE__ */ jsxs2(MenuPopup, { align: "end", children: [
                  /* @__PURE__ */ jsxs2(MenuGroup, { children: [
                    /* @__PURE__ */ jsx2(MenuGroupLabel, { children: "Use for new sessions" }),
                    /* @__PURE__ */ jsxs2(MenuItem, { disabled: isBox, onClick: () => void useOnBox(a), children: [
                      "Everywhere on ",
                      box
                    ] }),
                    projectOrder.map((loc) => /* @__PURE__ */ jsxs2(MenuItem, { disabled: projects.includes(loc), onClick: () => void useOnProject(a, agent, loc), children: [
                      "In ",
                      loc,
                      " only"
                    ] }, loc))
                  ] }),
                  projects.length > 0 && /* @__PURE__ */ jsxs2(Fragment, { children: [
                    /* @__PURE__ */ jsx2(MenuSeparator, {}),
                    projects.map((loc) => /* @__PURE__ */ jsxs2(MenuItem, { onClick: () => void useOnProject(null, agent, loc), children: [
                      "Let ",
                      loc,
                      " follow the box"
                    ] }, loc))
                  ] }),
                  a.signed_in && /* @__PURE__ */ jsxs2(Fragment, { children: [
                    /* @__PURE__ */ jsx2(MenuSeparator, {}),
                    /* @__PURE__ */ jsx2(MenuItem, { onClick: () => void run(`sign:${agent}:${a.id}`, () => signIn(a)), children: "Sign in again\u2026" })
                  ] })
                ] })
              ] })
            ] }, a.id);
          }) })
        ] })
      ] }, agent);
    }),
    /* @__PURE__ */ jsxs2(Frame, { variant: "card", children: [
      /* @__PURE__ */ jsx2(FrameHeader, { className: "py-3", children: /* @__PURE__ */ jsx2(FrameTitle, { children: "Running sessions" }) }),
      /* @__PURE__ */ jsx2(FramePanel, { className: "p-0", children: sessions.length === 0 ? /* @__PURE__ */ jsxs2("p", { className: "px-4 py-6 text-center text-muted-foreground text-sm", children: [
        "No Claude Code or Codex sessions are running on ",
        box,
        "."
      ] }) : /* @__PURE__ */ jsx2("ul", { className: "divide-y", children: sessions.map((s) => {
        const agent = s.agent;
        const env = data.sessions[s.name];
        const a = accountFor(data.accounts, agent, env?.[ACCOUNT_VAR[agent]], data.home);
        return /* @__PURE__ */ jsxs2("li", { className: "flex items-center gap-3 px-4 py-2 text-sm", children: [
          /* @__PURE__ */ jsx2("span", { className: cn2("size-2 shrink-0 rounded-[2px]", SERIES[agent].dot), "aria-label": AGENT_NAME[agent] }),
          /* @__PURE__ */ jsx2("span", { className: "min-w-0 flex-1 truncate", children: sessionName(s, { sessions: all, locations, place: true }) }),
          /* @__PURE__ */ jsx2("span", { className: "truncate text-muted-foreground text-xs", children: env ? a ? `${a.id === "default" ? "Default" : a.id}${a.email ? ` \xB7 ${a.email}` : ""}` : env[ACCOUNT_VAR[agent]] ?? "" : "unknown" }),
          /* @__PURE__ */ jsx2(Button, { size: "xs", variant: "ghost", onClick: () => berth.openTerminal(box, s.name), children: "Open" })
        ] }, s.name);
      }) }) })
    ] })
  ] });
}
function AddAccount({ agent, taken, busy, where: where2, onCancel, onAdd }) {
  const [name, setName] = useState2("");
  const problem = !name ? void 0 : !NAME.test(name) ? "Lowercase letters, digits and dashes" : taken.includes(name) ? "There's already an account with that name" : void 0;
  return /* @__PURE__ */ jsxs2(
    "form",
    {
      className: "flex flex-wrap items-start gap-2 border-b bg-muted/40 px-4 py-3",
      onSubmit: (e) => {
        e.preventDefault();
        if (name && !problem) onAdd(name);
      },
      children: [
        /* @__PURE__ */ jsxs2("div", { className: "min-w-48 flex-1 space-y-1", children: [
          /* @__PURE__ */ jsx2(Input, { autoFocus: true, size: "sm", placeholder: "work, personal\u2026", value: name, onChange: (e) => setName(e.target.value.trim().toLowerCase()), "aria-label": "Account name", "aria-invalid": Boolean(problem) }),
          /* @__PURE__ */ jsx2("p", { className: cn2("text-xs", problem ? "text-destructive-foreground" : "text-muted-foreground"), children: problem ?? `Makes ~/.berth/accounts/${agent}/${name || "<name>"} and opens ${agent === "claude" ? "Claude Code" : "codex login"} with it${where2 ? ` in ${where2}` : ""}, so you can sign in.` })
        ] }),
        /* @__PURE__ */ jsx2(Button, { size: "sm", type: "submit", disabled: !name || Boolean(problem), loading: busy, children: "Create and sign in" }),
        /* @__PURE__ */ jsx2(Button, { size: "sm", variant: "ghost", type: "button", onClick: onCancel, children: "Cancel" })
      ]
    }
  );
}

// ../plugins/usage/src/usage-view.tsx
import { Badge as Badge2, Button as Button2, Empty, EmptyDescription, EmptyHeader, EmptyTitle, Frame as Frame2, FrameHeader as FrameHeader2, FramePanel as FramePanel2, FrameTitle as FrameTitle2, Icon as Icon2, PickOne, Skeleton as Skeleton2, Spinner, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tip, cn as cn3 } from "@berth/plugin/ui";
import { useMemo, useState as useState3 } from "react";
import { Fragment as Fragment2, jsx as jsx3, jsxs as jsxs3 } from "react/jsx-runtime";
function UsageView({ berth, period, sources, states, accounts, running, allBoxes, multi }) {
  const sum = useMemo(() => summarize(sources, period), [sources, period]);
  const [stackBy, setStackBy] = useState3("agent");
  const counted = sources.map((s) => s.box);
  const showBox = multi && counted.length > 1;
  const busy = states.some((s) => s.loading);
  if (!sources.length) {
    if (busy) {
      return /* @__PURE__ */ jsxs3("div", { className: "space-y-3", children: [
        /* @__PURE__ */ jsx3(Skeleton2, { className: "h-28 w-full" }),
        /* @__PURE__ */ jsx3(Skeleton2, { className: "h-44 w-full" })
      ] });
    }
    return null;
  }
  const agents = ["claude", "codex"].filter((a) => (sum.byAgent.get(a) ? total(sum.byAgent.get(a)) > 0 : false) || dedupeLimits(a, sources, accounts, period).length > 0);
  const where2 = multi ? counted.length === 1 ? counted[0] : `${counted.length} boxes` : counted[0];
  if (!agents.length) {
    return /* @__PURE__ */ jsx3(Empty, { className: "rounded-xl border py-16", children: /* @__PURE__ */ jsxs3(EmptyHeader, { children: [
      /* @__PURE__ */ jsx3(Icon2, { name: "ChartColumn", className: "mx-auto mb-2 size-5 text-muted-foreground" }),
      /* @__PURE__ */ jsxs3(EmptyTitle, { children: [
        "No agent usage on ",
        where2,
        " ",
        period === 1 ? "today" : `in the last ${period} days`
      ] }),
      /* @__PURE__ */ jsx3(EmptyDescription, { children: "Claude Code and Codex record their token use as they work; it shows up here once an agent has run on a box." })
    ] }) });
  }
  const series = stackBy === "box" && showBox ? boxSeries(counted, allBoxes) : agentSeries();
  const byDay = stackBy === "box" && showBox ? foldBoxes(sum.byDayBox, series) : sum.byDay;
  const subscription = agents.includes("claude") && claudeAccounts(sources, accounts).every((a) => plan(a)?.subscription);
  const files = sources.reduce((n, s) => n + s.report.files, 0);
  return /* @__PURE__ */ jsxs3("div", { className: "space-y-4", children: [
    /* @__PURE__ */ jsx3("div", { className: cn3("grid gap-3", agents.length > 1 && "md:grid-cols-2"), children: agents.map((a) => /* @__PURE__ */ jsx3(
      AgentTile,
      {
        agent: a,
        tokens: sum.byAgent.get(a) ?? [0, 0, 0, 0],
        sessions: sum.sessions.filter((s) => s.agent === a),
        perBox: showBox ? sum.byAgentBox.get(a) : void 0,
        allBoxes,
        plans: usedAccounts(a, sources, accounts),
        limits: dedupeLimits(a, sources, accounts, period),
        period
      },
      a
    )) }),
    period > 1 && /* @__PURE__ */ jsxs3(Frame2, { variant: "card", children: [
      /* @__PURE__ */ jsxs3(FrameHeader2, { className: "flex-row items-center gap-2 py-3", children: [
        /* @__PURE__ */ jsx3(FrameTitle2, { children: "Tokens per day" }),
        showBox && /* @__PURE__ */ jsx3(
          PickOne,
          {
            label: "Stack by",
            className: "ml-auto",
            value: stackBy,
            onChange: (v) => setStackBy(v),
            options: [
              { value: "agent", label: "By agent" },
              { value: "box", label: "By box" }
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsx3(FramePanel2, { className: "p-4", children: /* @__PURE__ */ jsx3(DailyChart, { days: days(sum.today, period), byDay, series }) })
    ] }),
    /* @__PURE__ */ jsxs3("div", { className: cn3("grid gap-4", !showBox && "lg:grid-cols-2"), children: [
      /* @__PURE__ */ jsxs3(Frame2, { variant: "card", children: [
        /* @__PURE__ */ jsx3(FrameHeader2, { className: "py-3", children: /* @__PURE__ */ jsx3(FrameTitle2, { children: "By model" }) }),
        /* @__PURE__ */ jsx3(FramePanel2, { className: "p-0", children: /* @__PURE__ */ jsxs3(Table, { children: [
          /* @__PURE__ */ jsx3(TableHeader, { children: /* @__PURE__ */ jsxs3(TableRow, { children: [
            /* @__PURE__ */ jsx3(TableHead, { children: "Model" }),
            showBox && /* @__PURE__ */ jsx3(TableHead, { children: "Box" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Input" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Output" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Cache" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Total" })
          ] }) }),
          /* @__PURE__ */ jsx3(TableBody, { children: sum.byModel.slice(0, 12).map((m) => /* @__PURE__ */ jsxs3(TableRow, { children: [
            /* @__PURE__ */ jsx3(TableCell, { className: "max-w-56", children: /* @__PURE__ */ jsxs3("span", { className: "flex items-center gap-2", children: [
              /* @__PURE__ */ jsx3("span", { className: cn3("size-2 shrink-0 rounded-[2px]", SERIES[m.agent].dot) }),
              /* @__PURE__ */ jsx3("span", { className: "truncate font-mono text-xs", children: m.model })
            ] }) }),
            showBox && /* @__PURE__ */ jsx3(TableCell, { children: /* @__PURE__ */ jsx3(BoxChip, { box: m.box, allBoxes }) }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right tabular-nums", children: compact(m.tokens[0]) }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right tabular-nums", children: compact(m.tokens[1]) }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right tabular-nums text-muted-foreground", children: compact(m.tokens[2] + m.tokens[3]) }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right font-medium tabular-nums", children: compact(total(m.tokens)) })
          ] }, m.agent + m.model + m.box)) })
        ] }) })
      ] }),
      /* @__PURE__ */ jsxs3(Frame2, { variant: "card", children: [
        /* @__PURE__ */ jsx3(FrameHeader2, { className: "py-3", children: /* @__PURE__ */ jsx3(FrameTitle2, { children: "By project" }) }),
        /* @__PURE__ */ jsx3(FramePanel2, { className: "p-0", children: /* @__PURE__ */ jsxs3(Table, { children: [
          /* @__PURE__ */ jsx3(TableHeader, { children: /* @__PURE__ */ jsxs3(TableRow, { children: [
            /* @__PURE__ */ jsx3(TableHead, { children: "Worktree" }),
            showBox && /* @__PURE__ */ jsx3(TableHead, { children: "Box" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Sessions" }),
            /* @__PURE__ */ jsx3(TableHead, { className: "text-right", children: "Total" })
          ] }) }),
          /* @__PURE__ */ jsx3(TableBody, { children: sum.byWorktree.slice(0, 12).map((w) => /* @__PURE__ */ jsxs3(TableRow, { children: [
            /* @__PURE__ */ jsx3(TableCell, { className: "max-w-56 truncate", title: w.name.path ?? w.name.label, children: w.name.location ? w.name.label : /* @__PURE__ */ jsx3("span", { className: "font-mono text-muted-foreground text-xs", children: w.name.label }) }),
            showBox && /* @__PURE__ */ jsx3(TableCell, { children: /* @__PURE__ */ jsx3(BoxChip, { box: w.box, allBoxes }) }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right tabular-nums text-muted-foreground", children: w.sessions || "" }),
            /* @__PURE__ */ jsx3(TableCell, { className: "text-right font-medium tabular-nums", children: compact(total(w.tokens)) })
          ] }, w.box + w.name.label)) })
        ] }) })
      ] })
    ] }),
    /* @__PURE__ */ jsxs3(Frame2, { variant: "card", children: [
      /* @__PURE__ */ jsxs3(FrameHeader2, { className: "flex-row items-center gap-2 py-3", children: [
        /* @__PURE__ */ jsx3(FrameTitle2, { children: "Sessions" }),
        /* @__PURE__ */ jsxs3("span", { className: "ml-auto text-muted-foreground text-xs", children: [
          "Cost is Claude Code's own estimate at API list prices",
          subscription ? "; your Claude subscription covers this use" : "",
          "."
        ] })
      ] }),
      /* @__PURE__ */ jsx3(FramePanel2, { className: "p-0", children: /* @__PURE__ */ jsx3(SessionList, { berth, sessions: sum.sessions.slice(0, 30), sources, running, allBoxes, showBox }) })
    ] }),
    /* @__PURE__ */ jsxs3("p", { className: "text-muted-foreground text-xs", children: [
      "Read from ",
      files,
      " transcript",
      files === 1 ? "" : "s",
      sources.map((s, i) => /* @__PURE__ */ jsxs3("span", { children: [
        i === 0 ? " on " : i === sources.length - 1 ? " and " : ", ",
        s.box,
        " ",
        ago(s.report.generated),
        s.report.tz ? ` (${s.report.tz})` : ""
      ] }, s.box)),
      "; days are each box's own.",
      sources.some((s) => s.report.partial) && ` ${sources.reduce((n, s) => n + s.report.pending, 0)} more are still being read; this updates when they are.`,
      sources.some((s) => s.report.truncated) && " Older sessions are left out to keep the answer small.",
      " Input excludes cached input, which is counted under cache."
    ] })
  ] });
}
function foldBoxes(byDayBox, series) {
  const named = new Set(series.map((s) => s.key));
  const out = /* @__PURE__ */ new Map();
  for (const [day, m] of byDayBox) {
    const d = /* @__PURE__ */ new Map();
    for (const [box, n] of m) {
      const k = named.has(box) ? box : OTHER_BOXES;
      d.set(k, (d.get(k) ?? 0) + n);
    }
    out.set(day, d);
  }
  return out;
}
function BoxChip({ box, allBoxes }) {
  return /* @__PURE__ */ jsxs3("span", { className: "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px font-mono text-[11px] text-muted-foreground", children: [
    /* @__PURE__ */ jsx3("span", { className: cn3("size-1.5 rounded-full", boxColor(box, allBoxes).dot) }),
    box
  ] });
}
var identity = (a, box, id) => a?.email ? `${a.agent}:${a.email}` : `${box}:${a?.agent}:${id}`;
function usedAccounts(agent, sources, accounts) {
  const out = /* @__PURE__ */ new Map();
  for (const { box, report } of sources) {
    const ids = /* @__PURE__ */ new Set(["default", ...report.daily.filter((d) => d[1] === agent).map((d) => d[2])]);
    for (const id of ids) {
      const a = accounts[box]?.find((x) => x.agent === agent && x.id === id);
      if (!a || !a.signed_in) continue;
      const k = identity(a, box, id);
      const seen = out.get(k);
      if (seen) seen.boxes.push(box);
      else out.set(k, { account: a, boxes: [box] });
    }
  }
  return [...out.values()];
}
function claudeAccounts(sources, accounts) {
  return usedAccounts("claude", sources, accounts).map((u) => u.account);
}
function dedupeLimits(agent, sources, accounts, period) {
  const out = /* @__PURE__ */ new Map();
  for (const { box, report } of sources) {
    const from = firstDay(report.today, period);
    for (const l of report.limits.filter((x) => x.agent === agent && x.at.slice(0, 10) >= from)) {
      const a = accounts[box]?.find((x) => x.agent === agent && x.id === l.account);
      const k = identity(a, box, l.account);
      const label = a?.email ?? (l.account === "default" ? box : `${box} \xB7 ${l.account}`);
      const seen = out.get(k);
      if (!seen) out.set(k, { label, boxes: [box], limits: l });
      else {
        seen.boxes.push(box);
        if (l.at > seen.limits.at) seen.limits = l;
      }
    }
  }
  const list = [...out.values()];
  if (list.length === 1) list[0].label = void 0;
  return list;
}
function AgentTile({
  agent,
  tokens,
  sessions: list,
  perBox,
  allBoxes,
  plans,
  limits,
  period
}) {
  const sessions = list.length;
  const costed = list.filter((s) => s.cost != null);
  const cost = costed.reduce((n, s) => n + (s.cost ?? 0), 0);
  const labels = plans.map((p) => ({ ...p, plan: plan(p.account) })).filter((p) => p.plan);
  const covered = labels.length > 0 && labels.every((p) => p.plan.subscription);
  const boxes = perBox ? [...perBox.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) : [];
  const sumBoxes = boxes.reduce((n, [, v]) => n + v, 0) || 1;
  return /* @__PURE__ */ jsxs3(Frame2, { variant: "card", children: [
    /* @__PURE__ */ jsxs3(FrameHeader2, { className: "flex-row flex-wrap items-center gap-2 py-3", children: [
      /* @__PURE__ */ jsx3("span", { className: cn3("size-2.5 rounded-[3px]", SERIES[agent].dot) }),
      /* @__PURE__ */ jsx3(FrameTitle2, { children: AGENT_NAME[agent] }),
      /* @__PURE__ */ jsx3("span", { className: "ml-auto text-muted-foreground text-xs", children: period === 1 ? "today" : `last ${period} days` }),
      labels.length > 0 && /* @__PURE__ */ jsx3("span", { className: "basis-full" }),
      labels.map((p) => /* @__PURE__ */ jsxs3(Badge2, { variant: "outline", size: "sm", title: [p.account.email, `on ${p.boxes.join(", ")}`].filter(Boolean).join(" \xB7 "), children: [
        p.plan.label,
        p.plan.subscription ? " \xB7 subscription" : "",
        labels.length > 1 && p.account.email ? ` \xB7 ${p.account.email}` : ""
      ] }, identity(p.account, p.boxes[0], p.account.id)))
    ] }),
    /* @__PURE__ */ jsxs3(FramePanel2, { className: "space-y-3 p-4", children: [
      /* @__PURE__ */ jsxs3("div", { className: "flex items-baseline gap-2", children: [
        /* @__PURE__ */ jsx3("span", { className: "font-semibold text-2xl tabular-nums tracking-tight", children: compact(total(tokens)) }),
        /* @__PURE__ */ jsxs3("span", { className: "text-muted-foreground text-sm", children: [
          "tokens in ",
          sessions,
          " session",
          sessions === 1 ? "" : "s",
          boxes.length > 1 ? ` on ${boxes.length} boxes` : ""
        ] })
      ] }),
      /* @__PURE__ */ jsx3("dl", { className: "grid grid-cols-4 gap-2 text-xs", children: ["Input", "Output", "Cache read", "Cache write"].map((l, i) => /* @__PURE__ */ jsxs3("div", { children: [
        /* @__PURE__ */ jsx3("dt", { className: "text-muted-foreground", children: l }),
        /* @__PURE__ */ jsx3("dd", { className: "tabular-nums", children: compact(tokens[i]) })
      ] }, l)) }),
      boxes.length > 1 && /* @__PURE__ */ jsxs3("div", { className: "space-y-1.5", children: [
        /* @__PURE__ */ jsx3("div", { className: "flex h-1.5 gap-0.5 overflow-hidden rounded-full", role: "img", "aria-label": `By box: ${boxes.map(([b, n]) => `${b} ${compact(n)}`).join(", ")}`, children: boxes.map(([b, n]) => /* @__PURE__ */ jsx3(Tip, { label: `${b}: ${compact(n)} tokens`, children: /* @__PURE__ */ jsx3("span", { className: cn3("h-full first:rounded-l-full last:rounded-r-full", boxColor(b, allBoxes).dot), style: { width: `${n / sumBoxes * 100}%` } }) }, b)) }),
        /* @__PURE__ */ jsx3("div", { className: "flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground", children: boxes.map(([b, n]) => /* @__PURE__ */ jsxs3("span", { className: "flex items-center gap-1", children: [
          /* @__PURE__ */ jsx3("span", { className: cn3("size-1.5 rounded-full", boxColor(b, allBoxes).dot) }),
          b,
          " ",
          /* @__PURE__ */ jsx3("span", { className: "text-foreground tabular-nums", children: compact(n) })
        ] }, b)) })
      ] }),
      costed.length > 0 && /* @__PURE__ */ jsxs3("p", { className: "border-t pt-3 text-muted-foreground text-xs", children: [
        /* @__PURE__ */ jsx3("span", { className: "font-medium text-foreground tabular-nums", children: usd(cost) }),
        " is Claude Code's own estimate at API list prices for ",
        costed.length === sessions ? "these sessions" : `${costed.length} of these sessions`,
        ", whole sessions included.",
        covered ? ` ${labels.length === 1 ? labels[0].plan.label : "Your subscriptions"} cover${labels.length === 1 ? "s" : ""} this use; it isn't billed per token.` : ""
      ] }),
      limits.map((l) => /* @__PURE__ */ jsx3(LimitRows, { shared: l }, l.label ?? "one"))
    ] })
  ] });
}
function windowName(w) {
  const h = w.window_minutes / 60;
  return h >= 24 * 6 ? "Weekly limit" : h >= 20 ? "Daily limit" : `${h}-hour limit`;
}
function LimitRows({ shared }) {
  const l = shared.limits;
  const windows = [l.limits.primary, l.limits.secondary].filter(Boolean);
  return /* @__PURE__ */ jsxs3("div", { className: "space-y-2 border-t pt-3", children: [
    shared.label && /* @__PURE__ */ jsx3("div", { className: "truncate text-[11px] text-muted-foreground", children: shared.label }),
    windows.map((w, i) => {
      const reset = new Date(w.resets_at * 1e3);
      const past = reset.getTime() < Date.now();
      return /* @__PURE__ */ jsxs3("div", { className: "space-y-1", children: [
        /* @__PURE__ */ jsxs3("div", { className: "flex items-baseline gap-2 text-xs", children: [
          /* @__PURE__ */ jsx3("span", { className: "font-medium", children: windowName(w) }),
          /* @__PURE__ */ jsxs3("span", { className: "text-muted-foreground", children: [
            "as of ",
            ago(l.at)
          ] }),
          /* @__PURE__ */ jsx3("span", { className: "ml-auto tabular-nums", children: past ? "reset since" : `${Math.round(w.used_percent)}% used` })
        ] }),
        !past && /* @__PURE__ */ jsx3("div", { className: "h-1.5 overflow-hidden rounded-full bg-muted", role: "meter", "aria-valuenow": Math.round(w.used_percent), "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": windowName(w), children: /* @__PURE__ */ jsx3("div", { className: cn3("h-full rounded-full", w.used_percent >= 90 ? "bg-destructive" : w.used_percent >= 70 ? "bg-warning" : "bg-primary/70"), style: { width: `${Math.min(100, w.used_percent)}%` } }) }),
        /* @__PURE__ */ jsx3("div", { className: "text-[11px] text-muted-foreground", children: past ? `It reset ${reset.toLocaleDateString()}; Codex reports the new window on its next turn.` : `Resets ${reset.toLocaleString(void 0, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` })
      ] }, i);
    })
  ] });
}
function SessionList({ berth, sessions, sources, running, allBoxes, showBox }) {
  const [busy, setBusy] = useState3();
  if (!sessions.length) return /* @__PURE__ */ jsx3("p", { className: "px-4 py-6 text-center text-muted-foreground text-sm", children: "No sessions in this period." });
  const locationsOf = (box) => sources.find((s) => s.box === box)?.locations ?? [];
  const resume = async (s) => {
    const w = worktreeOf(s.cwd, locationsOf(s.box));
    if (!w.location) return;
    setBusy(s.box + s.id);
    try {
      const command = s.agent === "claude" ? `claude --resume ${s.id}` : `codex resume ${s.id}`;
      const created = await berth.api.request(s.box, "POST", "sessions", { location: w.main ? w.location : `${w.location}/${w.worktree}`, command });
      berth.openTerminal(s.box, created.name);
    } catch (err) {
      berth.notify("Couldn't resume that session", String(err.message ?? err));
    } finally {
      setBusy(void 0);
    }
  };
  return /* @__PURE__ */ jsx3("ul", { className: "divide-y", children: sessions.map((s) => {
    const w = worktreeOf(s.cwd, locationsOf(s.box));
    const live = (running[s.box] ?? []).find((r) => !r.exited && r.agent === s.agent && r.dir === s.cwd);
    return /* @__PURE__ */ jsxs3("li", { className: "group flex items-center gap-3 px-4 py-2 text-sm", children: [
      /* @__PURE__ */ jsx3("span", { className: cn3("size-2 shrink-0 rounded-[2px]", SERIES[s.agent].dot), "aria-label": AGENT_NAME[s.agent] }),
      /* @__PURE__ */ jsxs3("div", { className: "min-w-0 flex-1", children: [
        /* @__PURE__ */ jsxs3("div", { className: "flex min-w-0 items-center gap-2", children: [
          /* @__PURE__ */ jsx3("span", { className: "truncate", children: s.title || /* @__PURE__ */ jsx3("span", { className: "text-muted-foreground", children: "Untitled session" }) }),
          showBox && /* @__PURE__ */ jsx3(BoxChip, { box: s.box, allBoxes })
        ] }),
        /* @__PURE__ */ jsxs3("div", { className: "truncate text-muted-foreground text-xs", children: [
          w.label,
          " \xB7 ",
          s.models.join(", "),
          " \xB7 ",
          ago(s.last),
          s.account !== "default" && ` \xB7 ${s.account}`
        ] })
      ] }),
      /* @__PURE__ */ jsx3("span", { className: "w-16 text-right tabular-nums", children: compact(total(s.tokens)) }),
      s.cost != null ? /* @__PURE__ */ jsx3(Tip, { label: "Claude Code's estimate at API list prices", children: /* @__PURE__ */ jsx3("span", { className: "w-16 text-right text-muted-foreground tabular-nums", children: usd(s.cost) }) }) : /* @__PURE__ */ jsx3("span", { className: "w-16" }),
      /* @__PURE__ */ jsx3("span", { className: "w-20 text-right", children: live ? /* @__PURE__ */ jsx3(Button2, { size: "xs", variant: "outline", onClick: () => berth.openTerminal(s.box, live.name), children: "Open" }) : w.location ? /* @__PURE__ */ jsx3(Button2, { size: "xs", variant: "ghost", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100", loading: busy === s.box + s.id, onClick: () => void resume(s), children: "Resume" }) : null })
    ] }, s.box + s.agent + s.id);
  }) });
}
function BoxStatus({ states, files, allBoxes }) {
  return /* @__PURE__ */ jsx3("div", { className: "flex flex-wrap items-center gap-1.5 text-xs", children: states.map((s) => /* @__PURE__ */ jsx3(Tip, { label: s.error, children: /* @__PURE__ */ jsxs3("span", { className: cn3("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5", s.error && "border-destructive/40", !s.online && "border-dashed text-muted-foreground"), children: [
    /* @__PURE__ */ jsx3("span", { className: cn3("size-1.5 rounded-full", s.online ? boxColor(s.box, allBoxes).dot : "bg-muted-foreground/40") }),
    /* @__PURE__ */ jsx3("span", { className: "font-medium", children: s.box }),
    !s.online ? /* @__PURE__ */ jsx3("span", { children: "not counted (offline)" }) : s.loading ? /* @__PURE__ */ jsxs3(Fragment2, { children: [
      /* @__PURE__ */ jsx3(Spinner, { className: "size-3" }),
      /* @__PURE__ */ jsx3("span", { className: "text-muted-foreground", children: "reading\u2026" })
    ] }) : s.error ? /* @__PURE__ */ jsxs3("span", { className: "max-w-64 truncate text-destructive-foreground", children: [
      "couldn't read: ",
      s.error
    ] }) : /* @__PURE__ */ jsxs3("span", { className: "text-muted-foreground tabular-nums", children: [
      files[s.box] ?? 0,
      " transcripts"
    ] })
  ] }) }, s.box)) });
}

// ../plugins/usage/src/index.tsx
import { Fragment as Fragment3, jsx as jsx4, jsxs as jsxs4 } from "react/jsx-runtime";
var index_default = definePlugin((berth) => {
  berth.addScreen({ id: "usage", title: "Usage", Component: UsageScreen });
  berth.addSidebarItem({ id: "usage", title: "Usage", icon: "ChartColumn", screen: "usage" });
  berth.addCommand({ id: "usage", title: "Show agent usage", group: "Agents", run: () => berth.openScreen("usage") });
  berth.addCommand({
    id: "accounts",
    title: "Switch agent account",
    group: "Agents",
    run: () => {
      berth.storage.set("tab", "accounts");
      berth.openScreen("usage");
    }
  });
});
var reports = /* @__PURE__ */ new Map();
var EMPTY = { locations: [], sessions: [], loading: false };
function UsageScreen({ berth }) {
  const paired = useBoxes();
  const online = paired.filter((b) => b.state === "online").map((b) => b.name);
  const allBoxes = paired.map((b) => b.name);
  const current = useCurrentWorktree2();
  const [tab, setTab] = useStorage("tab", "usage");
  const [period, setPeriod] = useStorage("period", 7);
  const [hiddenBoxes, setHiddenBoxes] = useStorage("hiddenBoxes", []);
  const covered = allBoxes.filter((b) => !hiddenBoxes.includes(b)).length ? allBoxes.filter((b) => !hiddenBoxes.includes(b)) : allBoxes;
  const multi = covered.length > 1;
  const [pickedAccounts, setPickedAccounts] = useStorage("accountsBox", "");
  const accountsBox = online.includes(pickedAccounts) ? pickedAccounts : current && online.includes(current.box) ? current.box : online[0] ?? "";
  const [data, setData] = useState4({});
  const patch = useCallback((box, p) => setData((d) => ({ ...d, [box]: { ...d[box] ?? EMPTY, ...p } })), []);
  const inflight = useRef2(/* @__PURE__ */ new Set());
  const loadBox = useCallback(
    async (box) => {
      if (inflight.current.has(box)) return;
      inflight.current.add(box);
      patch(box, { loading: true, error: void 0 });
      try {
        const loc = await where(berth, box, current?.box === box ? current.location : void 0);
        const [report, acc, locations, sessions] = await Promise.all([
          runScript(berth, box, loc, ["report", "30"]),
          runScript(berth, box, loc, ["accounts"], "30s").catch(() => void 0),
          berth.api.locations(box).catch(() => []),
          berth.api.sessions(box).catch(() => [])
        ]);
        reports.set(box, report);
        const saved = berth.storage.get("reports", {});
        berth.storage.set("reports", { ...saved, [box]: report });
        patch(box, { report, accounts: acc?.accounts, locations, sessions, loading: false });
      } catch (err) {
        patch(box, { loading: false, error: String(err.message ?? err) });
      } finally {
        inflight.current.delete(box);
      }
    },
    [berth, current?.box, current?.location, patch]
  );
  const targets = covered.filter((b) => online.includes(b));
  const targetKey = targets.join(",");
  const loadUsage = useCallback(() => Promise.all(targets.map((b) => loadBox(b))), [targetKey, loadBox]);
  useEffect2(() => {
    const saved = berth.storage.get("reports", {});
    for (const b of targets) if (!data[b]?.report && (reports.get(b) ?? saved[b])) patch(b, { report: reports.get(b) ?? saved[b] });
    void loadUsage();
  }, [targetKey]);
  useEffect2(() => {
    const slow = targets.filter((b) => data[b]?.report?.partial && !data[b]?.loading);
    if (!slow.length) return;
    const t = setTimeout(() => slow.forEach((b) => void loadBox(b)), 2e4);
    return () => clearTimeout(t);
  }, [data, targetKey, loadBox]);
  const [accounts, setAccounts] = useState4();
  const [choices, setChoices] = useState4();
  const [accountsError, setAccountsError] = useState4();
  const [accountsLoading, setAccountsLoading] = useState4(false);
  const accountsLocations = useLocations(accountsBox) ?? [];
  const loadAccounts = useCallback(async () => {
    if (!accountsBox) return;
    setAccountsLoading(true);
    setAccountsError(void 0);
    try {
      const loc = await where(berth, accountsBox, current?.box === accountsBox ? current.location : void 0);
      const [a, c] = await Promise.all([runScript(berth, accountsBox, loc, ["accounts"], "30s"), readChoices(berth, accountsBox)]);
      setAccounts(a);
      setChoices(c);
    } catch (err) {
      setAccountsError(String(err.message ?? err));
    } finally {
      setAccountsLoading(false);
    }
  }, [berth, accountsBox, current?.box, current?.location]);
  useEffect2(() => {
    if (tab !== "accounts") return;
    setAccounts(void 0);
    setChoices(void 0);
    void loadAccounts();
  }, [tab, accountsBox]);
  const states = covered.map((b) => ({ box: b, online: online.includes(b), loading: Boolean(data[b]?.loading), error: data[b]?.error }));
  const sources = targets.flatMap((b) => data[b]?.report ? [{ box: b, report: data[b].report, locations: data[b].locations }] : []);
  const loading = tab === "usage" ? states.some((s) => s.loading) : accountsLoading;
  const single = !multi ? data[covered[0]] : void 0;
  return /* @__PURE__ */ jsxs4(Fragment3, { children: [
    /* @__PURE__ */ jsx4(
      ViewHeader,
      {
        title: "Usage & accounts",
        description: "Tokens Claude Code and Codex used on your boxes, from the transcripts they keep there, and which account new sessions sign in with.",
        actions: /* @__PURE__ */ jsx4(Fragment3, { children: /* @__PURE__ */ jsxs4(Tooltip, { children: [
          /* @__PURE__ */ jsx4(TooltipTrigger, { render: /* @__PURE__ */ jsx4(Button3, { variant: "ghost", size: "icon-sm", "aria-label": "Refresh", disabled: !online.length, loading, onClick: () => void (tab === "usage" ? loadUsage() : loadAccounts()) }), children: /* @__PURE__ */ jsx4(Icon3, { name: "RefreshCw" }) }),
          /* @__PURE__ */ jsx4(TooltipPopup, { children: "Refresh" })
        ] }) })
      }
    ),
    /* @__PURE__ */ jsxs4("div", { className: "flex flex-wrap items-center gap-3", children: [
      /* @__PURE__ */ jsx4(
        PickOne2,
        {
          label: "Show",
          value: tab,
          onChange: (v) => setTab(v),
          options: [
            { value: "usage", label: "Usage" },
            { value: "accounts", label: "Accounts" }
          ]
        }
      ),
      tab === "usage" ? /* @__PURE__ */ jsxs4(Fragment3, { children: [
        /* @__PURE__ */ jsx4(BoxFilter, { className: "ml-auto", boxes: allBoxes, hidden: hiddenBoxes, onChange: setHiddenBoxes }),
        /* @__PURE__ */ jsx4(
          PickOne2,
          {
            label: "Period",
            className: allBoxes.length < 2 ? "ml-auto" : void 0,
            value: String(period),
            onChange: (v) => setPeriod(Number(v)),
            options: [
              { value: "1", label: "Today" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" }
            ]
          }
        )
      ] }) : (
        // Accounts are one box's at a time.
        online.length > 1 && /* @__PURE__ */ jsx4(PickOne2, { label: "Box", className: "ml-auto", value: accountsBox, onChange: setPickedAccounts, options: online.map((b) => ({ value: b, label: b })) })
      )
    ] }),
    tab === "usage" && multi && states.length > 0 && /* @__PURE__ */ jsx4(BoxStatus, { states, files: Object.fromEntries(targets.map((b) => [b, data[b]?.report?.files])), allBoxes }),
    (tab === "usage" && single?.error || tab === "accounts" && accountsError) && /* @__PURE__ */ jsxs4(Alert2, { variant: "error", children: [
      /* @__PURE__ */ jsx4(Icon3, { name: "CircleAlert" }),
      /* @__PURE__ */ jsxs4(AlertDescription2, { children: [
        "Couldn't read ",
        tab === "usage" ? `usage on ${covered[0]}: ${single?.error}` : `accounts on ${accountsBox}: ${accountsError}`
      ] })
    ] }),
    !online.length ? /* @__PURE__ */ jsx4("p", { className: "py-16 text-center text-muted-foreground text-sm", children: "Connect a box to see its agents' usage." }) : tab === "usage" ? !multi && !online.includes(covered[0]) ? /* @__PURE__ */ jsxs4("p", { className: "py-16 text-center text-muted-foreground text-sm", children: [
      covered[0],
      " is offline; its usage shows once it's back."
    ] }) : /* @__PURE__ */ jsx4(
      UsageView,
      {
        berth,
        period,
        sources,
        states: states.filter((s) => s.online),
        accounts: Object.fromEntries(targets.map((b) => [b, data[b]?.accounts])),
        running: Object.fromEntries(targets.map((b) => [b, data[b]?.sessions])),
        allBoxes,
        multi
      }
    ) : /* @__PURE__ */ jsx4(AccountsView, { berth, box: accountsBox, data: accounts, choices, locations: accountsLocations, reload: loadAccounts })
  ] });
}
async function readChoices(berth, box) {
  const pick = (env2) => Object.fromEntries(Object.entries(env2 ?? {}).filter(([k]) => Object.values(ACCOUNT_VAR).includes(k)));
  const [env, locs] = await Promise.all([berth.api.request(box, "GET", "env").catch(() => ({ env: {} })), berth.api.locations(box)]);
  const projects = {};
  await Promise.all(
    locs.map(async (l) => {
      const c = await berth.api.request(box, "GET", `locations/${encodeURIComponent(l.name)}/config`).catch(() => void 0);
      const e = pick(c?.effective?.env);
      if (Object.keys(e).length) projects[l.name] = e;
    })
  );
  return { box: pick(env.env), projects };
}
export {
  index_default as default
};
