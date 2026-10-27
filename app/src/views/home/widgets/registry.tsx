import type { HomeWidget } from "@berth/plugin";
import { ActivityIcon, ChartColumnIcon, CheckCheckIcon, GitBranchIcon, HandIcon, type LucideIcon, RadioIcon, SailboatIcon, ServerIcon } from "lucide-react";
import { type ComponentType, type ReactNode, useMemo } from "react";

import { fitSize, isSize, type WidgetSize } from "@/lib/home-layout";
import { PluginReactContext } from "@/plugins/context";
import { pluginContexts } from "@/plugins/plugin-boundary";
import { type Contribution, useRegistry } from "@/plugins/registry";
import { Icon } from "@/plugins/ui";

import { AreasWidget, FinishedWidget, NeedsYouWidget, useFinishedCount, useWaitingCount, useWorkingCount, WorkingWidget } from "./agents";
import { useHomeWidget } from "./env";
import { BoxesWidget, ServicesWidget } from "./fleet";
import { GitWidget } from "./git";
import { HarbourWidget } from "./harbour";

// Home's widgets: Terminal's own, and every one a plugin adds with
// berth.addHomeWidget, in one list so the grid and the picker never tell
// them apart. A widget says what it shows, the sizes it takes and where
// its data comes from; the card around it (heading, menu, error boundary)
// is the grid's.

export type Category = "Agents" | "Work" | "Code" | "Fleet" | "You";
export const CATEGORIES: Category[] = ["Agents", "Work", "Code", "Fleet", "You"];

export interface WidgetDef {
  id: string;
  title: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  category: Category;
  // The sizes it takes; the first is the one it is added at.
  sizes: WidgetSize[];
  // Where its data comes from and how often it is read.
  source: string;
  // A plugin's: which one.
  plugin?: { id: string; name: string };
  // No card: it brings its own surface (the harbour).
  bare?: boolean;
  // The number in its heading; urgent shows it in amber.
  useCount?: () => { n: number; urgent?: boolean } | undefined;
  Component: ComponentType;
  // Puts a plugin's parts (body, count) under that plugin's context.
  wrap?: (node: ReactNode) => ReactNode;
}

const lucide = (I: LucideIcon) => I as ComponentType<{ className?: string }>;

export const BUILTIN_WIDGETS: WidgetDef[] = [
  {
    id: "needs-you",
    title: "Needs you",
    description: "Agents waiting on a permission or an answer. Allow once right here.",
    icon: lucide(HandIcon),
    category: "Agents",
    sizes: ["m", "l", "t", "w"],
    source: "Sessions from the laptop agent's events; a waiting agent's screen for its options",
    Component: NeedsYouWidget,
    useCount: useWaitingCount,
  },
  {
    id: "working",
    title: "Working now",
    description: "Each working agent and the step it is on.",
    icon: lucide(ActivityIcon),
    category: "Agents",
    sizes: ["m", "l", "t", "w"],
    source: "Sessions; each working agent's screen every 12s while on screen",
    Component: WorkingWidget,
    useCount: useWorkingCount,
  },
  {
    id: "finished",
    title: "Recently finished",
    description: "Turns that just ended, with what they changed.",
    icon: lucide(CheckCheckIcon),
    category: "Agents",
    sizes: ["m", "l", "t", "s", "w"],
    source: "Sessions, and Review's diff of each worktree",
    Component: FinishedWidget,
    useCount: useFinishedCount,
  },
  {
    id: "areas",
    title: "Recent areas",
    description: "The worktrees you and your agents worked in lately.",
    icon: lucide(GitBranchIcon),
    category: "Agents",
    sizes: ["m", "s", "t", "l"],
    source: "Worktrees you opened, and sessions by worktree (on this Mac)",
    Component: AreasWidget,
  },
  {
    id: "harbour",
    title: "Harbour",
    description: "A boat for each working agent; the lighthouse lights when one needs you.",
    icon: lucide(SailboatIcon),
    category: "Agents",
    sizes: ["m", "l", "w"],
    source: "Sessions, as Needs you; it draws once and moves with CSS",
    bare: true,
    Component: HarbourWidget,
  },
  {
    id: "git",
    title: "Git activity",
    description: "Commits and lines changed a day, the last two weeks, across your projects.",
    icon: lucide(ChartColumnIcon),
    category: "Code",
    sizes: ["m", "l", "w"],
    source: "git log on each project's main checkout, every 15 minutes while on screen",
    Component: GitWidget,
  },
  {
    id: "boxes",
    title: "Boxes",
    description: "Each box's CPU, memory and disk, and its agents at work.",
    icon: lucide(ServerIcon),
    category: "Fleet",
    sizes: ["s", "m", "t", "l"],
    source: "Box stats the app already reads every 30s",
    Component: BoxesWidget,
  },
  {
    id: "services",
    title: "Running services",
    description: "Dev servers listening in your worktrees, a click from a tab.",
    icon: lucide(RadioIcon),
    category: "Fleet",
    sizes: ["s", "m", "t"],
    source: "Services the app already lists",
    Component: ServicesWidget,
  },
];

const CATEGORY_OF = new Set<string>(CATEGORIES);

// fromPlugin turns a plugin's HomeWidget into a widget like the app's own,
// its id namespaced by the plugin.
function fromPlugin(c: Contribution<HomeWidget>, name: string): WidgetDef {
  const w = c.item;
  const sizes = (w.sizes ?? []).filter(isSize);
  const Body = w.Component;
  const ctx = pluginContexts.get(c.plugin) ?? null;
  const wrap = (node: ReactNode) => <PluginReactContext.Provider value={ctx}>{node}</PluginReactContext.Provider>;
  const useCount = w.useCount;
  return {
    id: `${c.plugin}/${w.id}`,
    title: w.title,
    description: w.description ?? "",
    icon: ({ className }) => <Icon name={w.icon ?? "Puzzle"} className={className} />,
    category: w.category && CATEGORY_OF.has(w.category) ? w.category : "Work",
    sizes: sizes.length ? sizes : ["m"],
    source: w.source ?? `The ${name} plugin`,
    plugin: { id: c.plugin, name },
    useCount: useCount
      ? () => {
          const v = useCount();
          return v == null ? undefined : typeof v === "number" ? { n: v } : v;
        }
      : undefined,
    wrap,
    Component: function PluginWidgetBody() {
      const info = useHomeWidget();
      return ctx ? <Body berth={ctx} size={info.size} visible={info.visible} preview={info.preview} /> : null;
    },
  };
}

// One def per contribution, so a widget's body keeps its identity (and its
// state) while other plugins load.
const made = new WeakMap<Contribution<HomeWidget>, { name: string; def: WidgetDef }>();

function defOf(c: Contribution<HomeWidget>, name: string): WidgetDef {
  const m = made.get(c);
  if (m && m.name === name) return m.def;
  const def = fromPlugin(c, name);
  made.set(c, { name, def });
  return def;
}

// useWidgets is every widget there is now: Terminal's, then the plugins'.
export function useWidgets(): WidgetDef[] {
  const contributed = useRegistry((s) => s.homeWidgets);
  const plugins = useRegistry((s) => s.plugins);
  return useMemo(() => [...BUILTIN_WIDGETS, ...contributed.map((c) => defOf(c, plugins.find((p) => p.id === c.plugin)?.name ?? c.plugin))], [contributed, plugins]);
}

// sizeFor is the size a placed widget is drawn at: what was saved, if the
// widget still takes it.
export const sizeFor = (def: WidgetDef, saved: WidgetSize) => fitSize(def.sizes, saved);
