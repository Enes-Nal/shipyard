import { AppWindowIcon, ChartColumnIcon, ChartPieIcon, ChartSplineIcon, FileTextIcon, FilterIcon, GaugeIcon, GitForkIcon, Grid3x3Icon, type LucideIcon, ScanEyeIcon, ShapesIcon, TableIcon, WorkflowIcon } from "lucide-react";
import { type ComponentType, lazy, type LazyExoticComponent } from "react";

import type { Art, ArtVersion } from "@/lib/art/model";
import { type ChartType, parseChart } from "@/lib/art/chart-spec";
import { type Gist, gist } from "@/lib/art/gist";
import { parseVdiff, vdiffGist } from "@/lib/art/vdiff";

// The kinds of artifact the app knows, and how each is drawn. A kind is a
// box-side entry (internal/box/artifacts.go artifactKinds) and one here:
// its names, its icon, its headline, and a viewer loaded the first time
// one is drawn. A new kind — a visual diff of before/after screenshots,
// say — registers itself with registerKind and needs nothing else changed:
// cards, tabs, the board and its filters all go through this table.

export type ViewSize = "thumb" | "full";

export interface ViewProps {
  art: Art;
  version: ArtVersion;
  // The version's content (text: a spec, a table, Mermaid, Markdown, HTML).
  body: string;
  size: ViewSize;
  // A thumbnail's height in pixels; a full view fills its pane.
  height?: number;
}

export interface KindSpec {
  kind: string;
  // "Chart", and the board's filter, "Charts".
  label: string;
  plural: string;
  icon(body?: string): LucideIcon;
  // What a person calls one: "Bar chart", "Table".
  word?(body?: string): string;
  // The one-line headline from the content.
  gist?(art: Art, body: string): Gist | undefined;
  // Drawn by Terminal itself, or a sandboxed page.
  drawn: "berth" | "sandbox";
  // What the tab's header says about where it comes from, when more than
  // "Drawn by Terminal".
  drawnLabel?: string;
  View: LazyExoticComponent<ComponentType<ViewProps>>;
  // A row under the headline on a card or tile: what needs a look.
  Chips?: LazyExoticComponent<ComponentType<{ art: Art; body: string }>>;
  // Its tab is wider than the others' (a visual diff's screenshots).
  wide?: boolean;
  // It draws its own summary and toolbar above what it shows (a visual
  // diff), so in a narrow pane (under 40rem: beside the chat, a split) its
  // tab's header folds to one line, the title, a version menu, Source and
  // Board, and what it shows starts near the top. Who made it and the
  // headline stay for screen readers.
  compact?: boolean;
}

const chartIcons: Partial<Record<ChartType, LucideIcon>> = { line: ChartSplineIcon, area: ChartSplineIcon, gauge: GaugeIcon, pie: ChartPieIcon, ring: ChartPieIcon, sankey: GitForkIcon, funnel: FilterIcon, heatmap: Grid3x3Icon };
const chartWords: Record<ChartType, string> = { bar: "Bar chart", line: "Line chart", area: "Area chart", funnel: "Funnel", sankey: "Flow", gauge: "Gauge", pie: "Pie chart", ring: "Ring chart", heatmap: "Heatmap" };

const kinds = new Map<string, KindSpec>();

export function registerKind(spec: KindSpec) {
  kinds.set(spec.kind, spec);
}

registerKind({
  kind: "chart",
  label: "Chart",
  plural: "Charts",
  icon: (body) => {
    const t = body ? parseChart(body)?.type : undefined;
    return (t && chartIcons[t]) || ChartColumnIcon;
  },
  word: (body) => {
    const t = body ? parseChart(body)?.type : undefined;
    return t ? chartWords[t] : "Chart";
  },
  gist: (a, body) => gist(a.kind, a.format, body),
  drawn: "berth",
  View: lazy(() => import("@/components/art/views/chart-view")),
});

registerKind({
  kind: "table",
  label: "Table",
  plural: "Tables",
  icon: () => TableIcon,
  gist: (a, body) => gist(a.kind, a.format, body),
  drawn: "berth",
  View: lazy(() => import("@/components/art/views/table-view")),
});

registerKind({
  kind: "diagram",
  label: "Diagram",
  plural: "Diagrams",
  icon: () => WorkflowIcon,
  gist: (a, body) => gist(a.kind, a.format, body),
  drawn: "berth",
  View: lazy(() => import("@/components/art/views/diagram-view")),
});

registerKind({
  kind: "page",
  label: "Page",
  plural: "Pages",
  icon: () => AppWindowIcon,
  gist: (a, body) => gist(a.kind, a.format, body),
  drawn: "sandbox",
  View: lazy(() => import("@/components/art/views/page-view")),
});

registerKind({
  kind: "notes",
  label: "Notes",
  plural: "Notes",
  icon: () => FileTextIcon,
  gist: (a, body) => gist(a.kind, a.format, body),
  drawn: "berth",
  View: lazy(() => import("@/components/art/views/notes-view")),
});

registerKind({
  kind: "visualdiff",
  label: "Visual diff",
  plural: "Visual diffs",
  icon: () => ScanEyeIcon,
  gist: (_a, body) => {
    const v = parseVdiff(body);
    return v ? vdiffGist(v) : undefined;
  },
  drawn: "berth",
  drawnLabel: "Shot on the box · drawn by Terminal",
  View: lazy(() => import("@/components/art/views/vdiff-view")),
  Chips: lazy(() => import("@/components/art/views/vdiff-chips")),
  wide: true,
  compact: true,
});

// A kind this app doesn't know (a newer box): its source, as text.
const unknownKind = (kind: string): KindSpec => ({
  kind,
  label: kind[0]?.toUpperCase() + kind.slice(1),
  plural: kind,
  icon: () => ShapesIcon,
  drawn: "berth",
  View: lazy(() => import("@/components/art/views/source-view")),
});

export const kindOf = (kind: string): KindSpec => kinds.get(kind) ?? unknownKind(kind);

// The board's filters, in this order, for the kinds there are.
export const allKinds = (): KindSpec[] => [...kinds.values()];

export const kindWord = (a: Art, body?: string) => kindOf(a.kind).word?.(body) ?? kindOf(a.kind).label;
