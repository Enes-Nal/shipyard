import { definePlugin, type BerthPluginContext, type Stats } from "@berth/plugin";
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
  cn,
} from "@berth/plugin/ui";
import { useSyncExternalStore } from "react";

// Box monitor: how loaded each box is, sampled every 15 seconds while the app
// is open and on screen (the status bar already shows each box's memory), with an hour of history and a notification when a box is about
// to run out of memory or disk. Agents and dev servers are heavy; a box
// that runs out stops them.

const EVERY = 15_000;
const KEEP = 240; // an hour of samples
const WARN = 0.85;
const CRITICAL = 0.92;

interface Sample {
  t: number;
  mem: number; // fraction of memory in use
  load: number; // 1-minute load per CPU
  disk: number; // fullest disk, fraction
}

interface BoxView {
  box: string;
  stats?: Stats;
  error?: string;
  history: Sample[];
}

// A small store the screen and status bar both read.
let views: BoxView[] = [];
let ready = false;
const listeners = new Set<() => void>();
const emit = () => {
  views = [...views];
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const useViews = () => useSyncExternalStore(subscribe, () => views);
const useReady = () => useSyncExternalStore(subscribe, () => ready);

const memOf = (s: Stats) => (s.memory.total ? s.memory.used / s.memory.total : 0);
const diskOf = (s: Stats) => Math.max(0, ...s.disks.map((d) => (d.total ? d.used / d.total : 0)));
const loadOf = (s: Stats) => (s.load?.[0] ?? 0) / Math.max(1, s.cpus);

export default definePlugin((berth) => {
  const saved = berth.storage.get<Record<string, Sample[]>>("history", {});
  // One warning per box and resource until it recovers.
  const warned = new Set<string>();

  const sample = async () => {
    const boxes = (await berth.api.boxes().catch(() => [])).filter((b) => b.state === "online");
    const next: BoxView[] = await Promise.all(
      boxes.map(async (b) => {
        const prev = views.find((v) => v.box === b.name);
        const history = prev?.history ?? saved[b.name] ?? [];
        try {
          const stats = await berth.api.stats(b.name);
          const s: Sample = { t: Date.now(), mem: memOf(stats), load: loadOf(stats), disk: diskOf(stats) };
          check(berth, warned, b.name, "memory", s.mem);
          check(berth, warned, b.name, "disk", s.disk);
          return { box: b.name, stats, history: [...history, s].slice(-KEEP) };
        } catch (err) {
          return { box: b.name, stats: prev?.stats, error: String((err as Error).message ?? err), history };
        }
      }),
    );
    views = next;
    ready = true;
    emit();
    berth.storage.set("history", Object.fromEntries(next.map((v) => [v.box, v.history.slice(-120)])));
  };

  void sample();
  // Not while the window is hidden: nobody is looking, and a hidden Terminal
  // shouldn't keep the Mac awake. Coming back samples at once.
  const timer = setInterval(() => !document.hidden && void sample(), EVERY);
  const back = () => !document.hidden && void sample();
  document.addEventListener("visibilitychange", back);

  berth.addScreen({ id: "boxes", title: "Box monitor", description: "Memory, disk and load on every online box, sampled every 15 seconds while Terminal is open.", Component: MonitorScreen });
  berth.addSidebarItem({ id: "boxes", title: "Box monitor", icon: "Activity", screen: "boxes" });
  berth.addCommand({ id: "boxes", title: "Show box monitor", group: "Boxes", run: () => berth.openScreen("boxes") });
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", back);
  };
});

function check(berth: BerthPluginContext, warned: Set<string>, box: string, what: "memory" | "disk", frac: number) {
  const key = `${box}:${what}`;
  if (frac >= CRITICAL && !warned.has(key)) {
    warned.add(key);
    berth.notify(`${box} is almost out of ${what}`, `${Math.round(frac * 100)}% used. Agents and dev servers there may be stopped.`);
  } else if (frac < WARN) warned.delete(key);
}

const pct = (f: number) => `${Math.round(f * 100)}%`;
const tone = (f: number) => (f >= CRITICAL ? "text-destructive" : f >= WARN ? "text-warning" : "text-muted-foreground");
const fill = (f: number) => (f >= CRITICAL ? "bg-destructive" : f >= WARN ? "bg-warning" : "bg-primary/70");

function gib(bytes: number) {
  return `${(bytes / 2 ** 30).toFixed(bytes >= 10 * 2 ** 30 ? 0 : 1)} GB`;
}

function uptime(s?: number) {
  if (!s) return "";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d ? `up ${d}d ${h}h` : `up ${h}h ${Math.floor((s % 3600) / 60)}m`;
}

function MonitorScreen() {
  const all = useViews();
  const loaded = useReady();
  return (
    <>
      {!loaded ? (
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : all.length === 0 ? (
        <Empty className="py-16">
          <EmptyHeader>
            <EmptyTitle>No boxes online</EmptyTitle>
            <EmptyDescription>When a box is connected, its memory, disk and load show up here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {all.map((v) => (
            <BoxCard key={v.box} view={v} />
          ))}
        </div>
      )}
    </>
  );
}

function BoxCard({ view: v }: { view: BoxView }) {
  const s = v.stats;
  if (!s) {
    return (
      <Frame variant="card">
        <FrameHeader className="py-3">
          <FrameTitle>{v.box}</FrameTitle>
        </FrameHeader>
        <FramePanel className="text-muted-foreground text-sm">{v.error ?? "No stats yet."}</FramePanel>
      </Frame>
    );
  }
  const m = memOf(s);
  const l = loadOf(s);
  const working = s.agents.filter((a) => a.state === "running").length;
  const waiting = s.agents.filter((a) => a.state === "waiting").length;
  return (
    <Frame variant="card">
      <FrameHeader className="flex-row items-center gap-2 py-2.5">
        <Icon name="Server" className="size-3.5 text-muted-foreground" />
        <FrameTitle>{v.box}</FrameTitle>
        <span className="truncate text-muted-foreground text-xs">
          {s.hostname} · {s.cpus} CPUs {uptime(s.uptime_s) && `· ${uptime(s.uptime_s)}`}
        </span>
        {v.error && (
          <Badge variant="outline" size="sm" className="ml-auto text-warning">
            stale
          </Badge>
        )}
      </FrameHeader>
      <FramePanel className="space-y-4 p-4">
        {s.memory.total > 0 ? (
          <Row label="Memory" value={`${gib(s.memory.used)} of ${gib(s.memory.total)}`} frac={m} history={v.history.map((h) => h.mem)} />
        ) : (
          <p className="text-muted-foreground text-xs">
            <span className="font-medium text-foreground">Memory</span> isn't reported by this box's system.
          </p>
        )}
        <Row label="Load" value={`${(s.load?.[0] ?? 0).toFixed(2)} on ${s.cpus} CPUs`} frac={Math.min(1, l)} history={v.history.map((h) => Math.min(1, h.load))} />
        {s.swap.total > 0 && <Row label="Swap" value={`${gib(s.swap.used)} of ${gib(s.swap.total)}`} frac={s.swap.used / s.swap.total} />}
        {s.disks.map((d) => (
          <Row key={d.mount} label={`Disk ${d.mount}`} value={`${gib(d.used)} of ${gib(d.total)}`} frac={d.total ? d.used / d.total : 0} />
        ))}
        <p className="flex gap-3 border-t pt-3 text-muted-foreground text-xs">
          <span>
            <b className="font-medium text-foreground">{s.agents.length}</b> agent{s.agents.length === 1 ? "" : "s"}
          </span>
          {working > 0 && <span>{working} working</span>}
          {waiting > 0 && <span className="text-warning">{waiting} waiting for you</span>}
          {!s.hooks && <span>agent status hooks not installed</span>}
        </p>
      </FramePanel>
    </Frame>
  );
}

function Row({ label, value, frac, history }: { label: string; value: string; frac: number; history?: number[] }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{value}</span>
        <span className={cn("ml-auto tabular-nums", tone(frac))}>{pct(frac)}</span>
      </div>
      <div className="flex items-center gap-3">
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted" role="meter" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
          <div className={cn("h-full rounded-full transition-[width]", fill(frac))} style={{ width: `${Math.min(100, frac * 100)}%` }} />
        </div>
        {history && <Spark values={history} />}
      </div>
    </div>
  );
}

// Spark draws the last hour as a small line, 0 to 100%.
function Spark({ values }: { values: number[] }) {
  const w = 96;
  const h = 18;
  if (values.length < 2) return <span className="w-24 text-right text-[10px] text-muted-foreground">collecting…</span>;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - Math.min(1, v) * h).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn("shrink-0", tone(last))} aria-label="last hour">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
    </svg>
  );
}
