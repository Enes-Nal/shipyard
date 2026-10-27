// berth.chart/v1: a chart an agent writes as JSON, never as code. The box
// checks it (internal/box/artifactcheck.go); here it becomes a plan for one
// bklit UI chart (components/charts, MIT), drawn in the active theme:
//
//   type      bklit component                         data
//   bar       BarChart + a Bar per series             rows; x = category key, y = value keys
//   line      LineChart + a Line per series           rows; x = a date or a short label
//   area      AreaChart + an Area per series          rows, as line
//   funnel    FunnelChart                             rows of {label, value}
//   sankey    SankeyChart + SankeyLink/Node/Tooltip   nodes by name, links {source, target, value}
//   gauge     Gauge                                   value of max
//   pie       PieChart + PieSlice, PieCenter          rows of {label, value}
//   ring      RingChart + Ring, RingCenter            rows of {label, value}, each of the total
//   heatmap   Shipkit's own matrix in bklit's scale     one row per cell; x, row, z keys
//             colours (--chart-scale-01..05): bklit's HeatmapChart is a
//             calendar, and an endpoint × hour grid isn't one
//
// Colours are names, not hex: "1".."5" (the theme's series palette,
// --chart-1..5), "good", "bad", "warn", "muted"; theme.ts sets them for
// each of the 23 themes.

export type ChartType = "bar" | "line" | "area" | "funnel" | "sankey" | "gauge" | "pie" | "ring" | "heatmap";
export const CHART_TYPES: ChartType[] = ["bar", "line", "area", "funnel", "sankey", "gauge", "pie", "ring", "heatmap"];

export type ChartColor = "1" | "2" | "3" | "4" | "5" | "good" | "bad" | "warn" | "muted";

export interface ChartSeries {
  key: string;
  label?: string;
  color?: ChartColor;
}

export type Row = Record<string, string | number | null>;

export interface BerthChart {
  $schema: "berth.chart/v1";
  type: ChartType;
  title?: string;
  subtitle?: string;
  data?: Row[];
  x?: string;
  y?: (string | ChartSeries)[];
  units?: string;
  better?: "lower" | "higher";
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
  color?: ChartColor;
  value?: number;
  max?: number;
  label?: string;
  nodes?: { name: string; color?: ChartColor }[];
  links?: { source: string; target: string; value: number }[];
  row?: string;
  z?: string;
  notes?: string[];
}

export function parseChart(body: string): BerthChart | undefined {
  try {
    const c = JSON.parse(body) as BerthChart;
    return c && typeof c === "object" && c.$schema === "berth.chart/v1" && CHART_TYPES.includes(c.type) ? c : undefined;
  } catch {
    return undefined;
  }
}

const PALETTE: ChartColor[] = ["1", "2", "3", "4", "5"];

export function series(c: BerthChart): Required<ChartSeries>[] {
  return (c.y ?? []).map((s, i) => {
    const o = typeof s === "string" ? { key: s } : s;
    return { key: o.key, label: o.label ?? o.key, color: o.color ?? PALETTE[i % 5] };
  });
}

export const colorVar = (c?: ChartColor): string => {
  switch (c) {
    case "good":
    case "bad":
    case "warn":
    case "muted":
      return `var(--chart-${c})`;
    case undefined:
      return "var(--chart-1)";
    default:
      return `var(--chart-${c})`;
  }
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

// fmt is a value as a person reads it: 1,240 · 48.2k · 82% · 410 ms.
export function fmt(n: number, units?: string): string {
  const a = Math.abs(n);
  const s = a >= 10000 ? `${(n / 1000).toFixed(a >= 100000 ? 0 : 1)}k` : Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(a < 10 ? 2 : 1).replace(/\.?0+$/, "");
  if (!units) return s;
  if (units === "%") return `${s}%`;
  if (units === "$") return `$${s}`;
  return `${s} ${units}`;
}

// The x label a line or area chart draws instead of a date, when its x
// values aren't dates (components/charts/time-series-chart-shell.tsx reads
// it).
export const X_LABEL = "__label";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

// timeAxis gives each row a Date for bklit's time axis: the row's own when
// its x is an ISO date, else one a day apart, labelled with the x value.
export function timeAxis(rows: Row[], x: string): { data: Record<string, unknown>[]; dates: boolean } {
  const dates = rows.length > 0 && rows.every((r) => typeof r[x] === "string" && ISO_DATE.test(String(r[x])) && !Number.isNaN(Date.parse(String(r[x]))));
  const base = Date.UTC(2000, 0, 1);
  return {
    dates,
    data: rows.map((r, i) => {
      const out: Record<string, unknown> = { ...r, date: dates ? new Date(String(r[x])) : new Date(base + i * 86_400_000) };
      if (!dates) out[X_LABEL] = String(r[x] ?? "");
      return out;
    }),
  };
}

export type ChartPlan =
  | { type: "bar"; data: Row[]; x: string; series: { key: string; label: string; color: string }[]; stacked: boolean; horizontal: boolean }
  | { type: "line" | "area"; data: Record<string, unknown>[]; series: { key: string; label: string; color: string }[]; dates: boolean }
  | { type: "funnel"; stages: { label: string; value: number; displayValue: string }[]; color: string }
  | { type: "pie"; slices: { label: string; value: number; color: string }[]; total: number }
  | { type: "ring"; rings: { label: string; value: number; maxValue: number; color: string }[]; total: number }
  | { type: "sankey"; nodes: { name: string; color: string }[]; links: { source: number; target: number; value: number }[] }
  | { type: "gauge"; percent: number; value: number; max: number; label: string; units?: string; color: string }
  | { type: "heatmap"; cols: string[]; rows: string[]; cells: (number | null)[][]; levels: number[][]; min: number; max: number };

const labelValue = (c: BerthChart) => ({ l: c.x ?? "label", v: c.z ?? "value" });

// plan maps a spec onto the bklit chart that draws it. It never throws: a
// spec the box let through always has a plan.
export function plan(c: BerthChart): ChartPlan {
  const rows = c.data ?? [];
  switch (c.type) {
    case "bar":
      return {
        type: "bar",
        data: rows,
        x: c.x ?? "x",
        series: series(c).map((s) => ({ key: s.key, label: s.label, color: colorVar(s.color) })),
        stacked: !!c.stacked,
        horizontal: c.orientation === "horizontal",
      };
    case "line":
    case "area": {
      const { data, dates } = timeAxis(rows, c.x ?? "x");
      return { type: c.type, data, dates, series: series(c).map((s) => ({ key: s.key, label: s.label, color: colorVar(s.color) })) };
    }
    case "funnel": {
      const { l, v } = labelValue(c);
      return { type: "funnel", color: colorVar(c.color ?? "1"), stages: rows.map((r) => ({ label: String(r[l] ?? ""), value: num(r[v]), displayValue: fmt(num(r[v]), c.units) })) };
    }
    case "pie":
    case "ring": {
      const { l, v } = labelValue(c);
      const items = rows.map((r, i) => ({ label: String(r[l] ?? ""), value: num(r[v]), color: colorVar(PALETTE[i % 5]) }));
      const total = items.reduce((s, x) => s + x.value, 0);
      if (c.type === "pie") return { type: "pie", slices: items, total };
      return { type: "ring", total, rings: items.map((x) => ({ ...x, maxValue: total || 1 })) };
    }
    case "sankey": {
      const nodes = c.nodes ?? [];
      const index = new Map(nodes.map((n, i) => [n.name, i]));
      return {
        type: "sankey",
        nodes: nodes.map((n, i) => ({ name: n.name, color: colorVar(n.color ?? PALETTE[i % 5]) })),
        links: (c.links ?? []).filter((k) => index.has(k.source) && index.has(k.target)).map((k) => ({ source: index.get(k.source)!, target: index.get(k.target)!, value: k.value })),
      };
    }
    case "gauge": {
      const max = c.max && c.max > 0 ? c.max : 100;
      const value = num(c.value);
      const percent = Math.max(0, Math.min(100, (value / max) * 100));
      const tone = c.better === "higher" ? (percent >= 75 ? "good" : percent >= 50 ? "warn" : "bad") : c.better === "lower" ? (percent <= 25 ? "good" : percent <= 50 ? "warn" : "bad") : (c.color ?? "1");
      return { type: "gauge", percent, value, max, label: c.label ?? c.title ?? "", units: c.units, color: colorVar(tone as ChartColor) };
    }
    case "heatmap":
      return heatmap(c);
  }
}

// heatmap lays cells out by column and row in the order they first
// appear, and gives each a level 0..4: log-scaled, as latencies spread
// over orders of magnitude.
function heatmap(c: BerthChart): Extract<ChartPlan, { type: "heatmap" }> {
  const x = c.x ?? "x";
  const y = c.row ?? "row";
  const z = c.z ?? "value";
  const cols: string[] = [];
  const rows: string[] = [];
  for (const r of c.data ?? []) {
    const cx = String(r[x] ?? "");
    const ry = String(r[y] ?? "");
    if (!cols.includes(cx)) cols.push(cx);
    if (!rows.includes(ry)) rows.push(ry);
  }
  const cells = rows.map(() => cols.map((): number | null => null));
  for (const r of c.data ?? []) {
    const v = r[z];
    if (typeof v === "number") cells[rows.indexOf(String(r[y] ?? ""))][cols.indexOf(String(r[x] ?? ""))] = v;
  }
  const all = cells.flat().filter((v): v is number => v !== null);
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 0;
  const lo = Math.log(Math.max(min, 1e-9));
  const hi = Math.log(Math.max(max, 1e-9));
  const levels = cells.map((row) =>
    row.map((v) => {
      if (v === null) return -1;
      if (max === min) return 2;
      const t = min > 0 ? (Math.log(v) - lo) / (hi - lo || 1) : (v - min) / (max - min || 1);
      return Math.max(0, Math.min(4, Math.floor(t * 4.999)));
    }),
  );
  return { type: "heatmap", cols, rows, cells, levels, min, max };
}

// legend is what a chart's key lists: its series, or its slices.
export function legend(c: BerthChart): { label: string; color: string }[] {
  if (c.type === "bar" || c.type === "line" || c.type === "area") {
    const ss = series(c);
    return ss.length > 1 ? ss.map((s) => ({ label: s.label, color: colorVar(s.color) })) : [];
  }
  if (c.type === "pie" || c.type === "ring") {
    const p = plan(c) as Extract<ChartPlan, { type: "pie" }> | Extract<ChartPlan, { type: "ring" }>;
    const items = p.type === "pie" ? p.slices : p.rings;
    return items.map((s) => ({ label: s.label, color: s.color }));
  }
  return [];
}
