import { cn } from "@berth/plugin/ui";
import { useEffect, useRef, useState } from "react";

import type { Agent } from "./box";
import { AGENT_NAME, compact } from "./data";

// Colors follow the thing they stand for, in both themes, and were checked
// for color blindness against Terminal's surfaces. Agents: Claude Code orange,
// Codex blue.
export const SERIES: Record<Agent, { fill: string; dot: string }> = {
  claude: { fill: "fill-[#eb6834] dark:fill-[#d95926]", dot: "bg-[#eb6834] dark:bg-[#d95926]" },
  codex: { fill: "fill-[#2a78d6] dark:fill-[#3987e5]", dot: "bg-[#2a78d6] dark:bg-[#3987e5]" },
};

// Boxes take the next hues, never the agents' two: aqua, yellow, magenta,
// green, violet. A sixth box and beyond fold into "Other boxes".
const BOX_HUES = [
  { fill: "fill-[#1baf7a] dark:fill-[#199e70]", dot: "bg-[#1baf7a] dark:bg-[#199e70]" },
  { fill: "fill-[#eda100] dark:fill-[#c98500]", dot: "bg-[#eda100] dark:bg-[#c98500]" },
  { fill: "fill-[#e87ba4] dark:fill-[#d55181]", dot: "bg-[#e87ba4] dark:bg-[#d55181]" },
  { fill: "fill-[#008300] dark:fill-[#008300]", dot: "bg-[#008300] dark:bg-[#008300]" },
  { fill: "fill-[#4a3aa7] dark:fill-[#9085e9]", dot: "bg-[#4a3aa7] dark:bg-[#9085e9]" },
];
const OTHER = { fill: "fill-muted-foreground/60", dot: "bg-muted-foreground/60" };
export const OTHER_BOXES = "\u0000other";

export interface Series {
  key: string;
  label: string;
  fill: string;
  dot: string;
}

export const agentSeries = (): Series[] => (["claude", "codex"] as Agent[]).map((a) => ({ key: a, label: AGENT_NAME[a], ...SERIES[a] }));

// boxColor gives a box its hue by its place among every paired box, sorted
// by name, so a box keeps its color when others go offline.
export function boxColor(box: string, allBoxes: string[]) {
  const i = [...allBoxes].sort().indexOf(box);
  return i >= 0 && i < BOX_HUES.length ? BOX_HUES[i] : OTHER;
}

// boxSeries is the chart's series for the counted boxes; boxes past the
// fifth hue share one "Other boxes" series.
export function boxSeries(counted: string[], allBoxes: string[]): Series[] {
  const sorted = [...allBoxes].sort();
  const named = counted.filter((b) => sorted.indexOf(b) < BOX_HUES.length).sort((a, b) => sorted.indexOf(a) - sorted.indexOf(b));
  const out: Series[] = named.map((b) => ({ key: b, label: b, ...boxColor(b, allBoxes) }));
  if (counted.length > named.length) out.push({ key: OTHER_BOXES, label: "Other boxes", ...OTHER });
  return out;
}

const H = 140;

function dayLabel(d: string) {
  return new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// DailyChart: tokens per day, stacked by series.
export function DailyChart({ days, byDay, series }: { days: string[]; byDay: Map<string, Map<string, number>>; series: Series[] }) {
  const [hover, setHover] = useState<number>();
  // Drawn at the figure's real width, so bars and labels keep their size.
  const ref = useRef<HTMLElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const value = (d: string, k: string) => byDay.get(d)?.get(k) ?? 0;
  const present = series.filter((s) => days.some((d) => value(d, s.key) > 0));
  const totals = days.map((d) => series.reduce((n, s) => n + value(d, s.key), 0));
  const max = Math.max(1, ...totals);
  const slot = W / days.length;
  const bar = Math.max(4, Math.min(28, slot - 6));
  const every = Math.ceil(days.length / Math.max(2, Math.floor(W / 90)));

  return (
    <figure ref={ref} className="relative">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {present.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={cn("size-2 rounded-[2px]", s.dot)} />
            {s.label}
          </span>
        ))}
        <span className="ml-auto tabular-nums">Busiest day {compact(max)} tokens</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} width={W} height={H + 18} className="block overflow-visible" role="img" aria-label={`Tokens per day by ${series.map((s) => s.label).join(", ")}`} onMouseLeave={() => setHover(undefined)}>
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} className="stroke-border" />
        {days.map((d, i) => {
          const x = i * slot + (slot - bar) / 2;
          const segs = series.filter((s) => value(d, s.key) > 0);
          let y = H;
          return (
            <g key={d} onMouseEnter={() => setHover(i)}>
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              {segs.map((s, j) => {
                const h = Math.max(2, (value(d, s.key) / max) * (H - 4));
                y -= h;
                const top = j === segs.length - 1;
                // A 2px gap of surface between stacked segments.
                return <rect key={s.key} x={x} y={y} width={bar} height={Math.max(1, h - (j > 0 ? 2 : 0))} rx={top ? Math.min(4, bar / 2) : 0} className={cn(s.fill, hover !== undefined && hover !== i && "opacity-50")} />;
              })}
              {(days.length - 1 - i) % every === 0 && (
                <text x={i * slot + slot / 2} y={H + 13} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {days.length === 1 ? "Today" : dayLabel(d)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== undefined && (
        <div
          className="pointer-events-none absolute top-6 z-10 min-w-40 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{ left: `clamp(0px, calc(${((hover + 0.5) / days.length) * 100}% - 80px), calc(100% - 170px))` }}
        >
          <div className="mb-1 font-medium">{dayLabel(days[hover])}</div>
          {present.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className={cn("size-2 rounded-[2px]", s.dot)} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto pl-3 tabular-nums">{compact(value(days[hover], s.key))}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}
