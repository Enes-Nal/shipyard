// ../plugins/box-monitor/src/index.tsx
import { definePlugin } from "@berth/plugin";
import {
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
  Icon,
  Skeleton,
  cn
} from "@berth/plugin/ui";
import { useSyncExternalStore } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var EVERY = 15e3;
var KEEP = 240;
var WARN = 0.85;
var CRITICAL = 0.92;
var views = [];
var ready = false;
var listeners = /* @__PURE__ */ new Set();
var emit = () => {
  views = [...views];
  for (const l of listeners) l();
};
var subscribe = (l) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
var useViews = () => useSyncExternalStore(subscribe, () => views);
var useReady = () => useSyncExternalStore(subscribe, () => ready);
var memOf = (s) => s.memory.total ? s.memory.used / s.memory.total : 0;
var diskOf = (s) => Math.max(0, ...s.disks.map((d) => d.total ? d.used / d.total : 0));
var loadOf = (s) => (s.load?.[0] ?? 0) / Math.max(1, s.cpus);
var index_default = definePlugin((berth) => {
  const saved = berth.storage.get("history", {});
  const warned = /* @__PURE__ */ new Set();
  const sample = async () => {
    const boxes = (await berth.api.boxes().catch(() => [])).filter((b) => b.state === "online");
    const next = await Promise.all(
      boxes.map(async (b) => {
        const prev = views.find((v) => v.box === b.name);
        const history = prev?.history ?? saved[b.name] ?? [];
        try {
          const stats = await berth.api.stats(b.name);
          const s = { t: Date.now(), mem: memOf(stats), load: loadOf(stats), disk: diskOf(stats) };
          check(berth, warned, b.name, "memory", s.mem);
          check(berth, warned, b.name, "disk", s.disk);
          return { box: b.name, stats, history: [...history, s].slice(-KEEP) };
        } catch (err) {
          return { box: b.name, stats: prev?.stats, error: String(err.message ?? err), history };
        }
      })
    );
    views = next;
    ready = true;
    emit();
    berth.storage.set("history", Object.fromEntries(next.map((v) => [v.box, v.history.slice(-120)])));
  };
  void sample();
  const timer = setInterval(() => void sample(), EVERY);
  berth.addScreen({ id: "boxes", title: "Box monitor", description: "Memory, disk and load on every online box, sampled every 15 seconds while Terminal is open.", Component: MonitorScreen });
  berth.addSidebarItem({ id: "boxes", title: "Box monitor", icon: "Activity", screen: "boxes" });
  berth.addCommand({ id: "boxes", title: "Show box monitor", group: "Boxes", run: () => berth.openScreen("boxes") });
  return () => clearInterval(timer);
});
function check(berth, warned, box, what, frac) {
  const key = `${box}:${what}`;
  if (frac >= CRITICAL && !warned.has(key)) {
    warned.add(key);
    berth.notify(`${box} is almost out of ${what}`, `${Math.round(frac * 100)}% used. Agents and dev servers there may be stopped.`);
  } else if (frac < WARN) warned.delete(key);
}
var pct = (f) => `${Math.round(f * 100)}%`;
var tone = (f) => f >= CRITICAL ? "text-destructive" : f >= WARN ? "text-warning" : "text-muted-foreground";
var fill = (f) => f >= CRITICAL ? "bg-destructive" : f >= WARN ? "bg-warning" : "bg-primary/70";
function gib(bytes) {
  return `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GB`;
}
function uptime(s) {
  if (!s) return "";
  const d = Math.floor(s / 86400);
  const h = Math.floor(s % 86400 / 3600);
  return d ? `up ${d}d ${h}h` : `up ${h}h ${Math.floor(s % 3600 / 60)}m`;
}
function MonitorScreen() {
  const all = useViews();
  const loaded = useReady();
  return /* @__PURE__ */ jsx(Fragment, { children: !loaded ? /* @__PURE__ */ jsxs("div", { className: "grid gap-4 md:grid-cols-2", children: [
    /* @__PURE__ */ jsx(Skeleton, { className: "h-44" }),
    /* @__PURE__ */ jsx(Skeleton, { className: "h-44" })
  ] }) : all.length === 0 ? /* @__PURE__ */ jsx(Empty, { className: "py-16", children: /* @__PURE__ */ jsxs(EmptyHeader, { children: [
    /* @__PURE__ */ jsx(EmptyTitle, { children: "No boxes online" }),
    /* @__PURE__ */ jsx(EmptyDescription, { children: "When a box is connected, its memory, disk and load show up here." })
  ] }) }) : /* @__PURE__ */ jsx("div", { className: "grid gap-4 md:grid-cols-2", children: all.map((v) => /* @__PURE__ */ jsx(BoxCard, { view: v }, v.box)) }) });
}
function BoxCard({ view: v }) {
  const s = v.stats;
  if (!s) {
    return /* @__PURE__ */ jsxs(Frame, { variant: "card", children: [
      /* @__PURE__ */ jsx(FrameHeader, { className: "py-3", children: /* @__PURE__ */ jsx(FrameTitle, { children: v.box }) }),
      /* @__PURE__ */ jsx(FramePanel, { className: "text-muted-foreground text-sm", children: v.error ?? "No stats yet." })
    ] });
  }
  const m = memOf(s);
  const l = loadOf(s);
  const working = s.agents.filter((a) => a.state === "running").length;
  const waiting = s.agents.filter((a) => a.state === "waiting").length;
  return /* @__PURE__ */ jsxs(Frame, { variant: "card", children: [
    /* @__PURE__ */ jsxs(FrameHeader, { className: "flex-row items-center gap-2 py-2.5", children: [
      /* @__PURE__ */ jsx(Icon, { name: "Server", className: "size-3.5 text-muted-foreground" }),
      /* @__PURE__ */ jsx(FrameTitle, { children: v.box }),
      /* @__PURE__ */ jsxs("span", { className: "truncate text-muted-foreground text-xs", children: [
        s.hostname,
        " \xB7 ",
        s.cpus,
        " CPUs ",
        uptime(s.uptime_s) && `\xB7 ${uptime(s.uptime_s)}`
      ] }),
      v.error && /* @__PURE__ */ jsx(Badge, { variant: "outline", size: "sm", className: "ml-auto text-warning", children: "stale" })
    ] }),
    /* @__PURE__ */ jsxs(FramePanel, { className: "space-y-4 p-4", children: [
      s.memory.total > 0 ? /* @__PURE__ */ jsx(Row, { label: "Memory", value: `${gib(s.memory.used)} of ${gib(s.memory.total)}`, frac: m, history: v.history.map((h) => h.mem) }) : /* @__PURE__ */ jsxs("p", { className: "text-muted-foreground text-xs", children: [
        /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: "Memory" }),
        " isn't reported by this box's system."
      ] }),
      /* @__PURE__ */ jsx(Row, { label: "Load", value: `${(s.load?.[0] ?? 0).toFixed(2)} on ${s.cpus} CPUs`, frac: Math.min(1, l), history: v.history.map((h) => Math.min(1, h.load)) }),
      s.swap.total > 0 && /* @__PURE__ */ jsx(Row, { label: "Swap", value: `${gib(s.swap.used)} of ${gib(s.swap.total)}`, frac: s.swap.used / s.swap.total }),
      s.disks.map((d) => /* @__PURE__ */ jsx(Row, { label: `Disk ${d.mount}`, value: `${gib(d.used)} of ${gib(d.total)}`, frac: d.total ? d.used / d.total : 0 }, d.mount)),
      /* @__PURE__ */ jsxs("p", { className: "flex gap-3 border-t pt-3 text-muted-foreground text-xs", children: [
        /* @__PURE__ */ jsxs("span", { children: [
          /* @__PURE__ */ jsx("b", { className: "font-medium text-foreground", children: s.agents.length }),
          " agent",
          s.agents.length === 1 ? "" : "s"
        ] }),
        working > 0 && /* @__PURE__ */ jsxs("span", { children: [
          working,
          " working"
        ] }),
        waiting > 0 && /* @__PURE__ */ jsxs("span", { className: "text-warning", children: [
          waiting,
          " waiting for you"
        ] }),
        !s.hooks && /* @__PURE__ */ jsx("span", { children: "agent status hooks not installed" })
      ] })
    ] })
  ] });
}
function Row({ label, value, frac, history }) {
  return /* @__PURE__ */ jsxs("div", { className: "space-y-1.5", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex items-baseline gap-2 text-xs", children: [
      /* @__PURE__ */ jsx("span", { className: "font-medium text-foreground", children: label }),
      /* @__PURE__ */ jsx("span", { className: "text-muted-foreground", children: value }),
      /* @__PURE__ */ jsx("span", { className: cn("ml-auto tabular-nums", tone(frac)), children: pct(frac) })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-3", children: [
      /* @__PURE__ */ jsx("div", { className: "h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted", role: "meter", "aria-valuenow": Math.round(frac * 100), "aria-valuemin": 0, "aria-valuemax": 100, "aria-label": label, children: /* @__PURE__ */ jsx("div", { className: cn("h-full rounded-full transition-[width]", fill(frac)), style: { width: `${Math.min(100, frac * 100)}%` } }) }),
      history && /* @__PURE__ */ jsx(Spark, { values: history })
    ] })
  ] });
}
function Spark({ values }) {
  const w = 96;
  const h = 18;
  if (values.length < 2) return /* @__PURE__ */ jsx("span", { className: "w-24 text-right text-[10px] text-muted-foreground", children: "collecting\u2026" });
  const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - Math.min(1, v) * h).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return /* @__PURE__ */ jsx("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, className: cn("shrink-0", tone(last)), "aria-label": "last hour", children: /* @__PURE__ */ jsx("polyline", { points: pts, fill: "none", stroke: "currentColor", strokeWidth: "1.25", strokeLinejoin: "round" }) });
}
export {
  index_default as default
};
