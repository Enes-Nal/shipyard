// The app's UI kit, shared with plugins so they look like the rest of Shipyard.
// Components take the same props as in the app (coss ui, built on Base UI);
// they are typed loosely here so the SDK does not depend on the app's source.
import type { ComponentType, ReactNode } from "react";

// biome-ignore lint/suspicious/noExplicitAny: see above.
type Loose = ComponentType<any>;

export declare const Badge: Loose;
export declare const Button: Loose;
export declare const Card: Loose;
export declare const CardHeader: Loose;
export declare const CardTitle: Loose;
export declare const CardDescription: Loose;
export declare const CardPanel: Loose;
export declare const CardFooter: Loose;
export declare const Empty: Loose;
export declare const EmptyHeader: Loose;
export declare const EmptyTitle: Loose;
export declare const EmptyDescription: Loose;
export declare const Input: Loose;
export declare const Kbd: Loose;
export declare const ScrollArea: Loose;
export declare const Separator: Loose;
export declare const Spinner: Loose;
export declare const Switch: Loose;
export declare const Table: Loose;
export declare const TableHeader: Loose;
export declare const TableBody: Loose;
export declare const TableRow: Loose;
export declare const TableHead: Loose;
export declare const TableCell: Loose;
export declare const Tooltip: Loose;
export declare const TooltipTrigger: Loose;
export declare const TooltipPopup: Loose;
// A section of a screen: <Frame variant="card"> with a FrameHeader and
// FramePanels inside, one outline for the section. Without the variant,
// Frame is a muted tray of raised panels, meant for grouped inputs.
export declare const Frame: Loose;
export declare const FramePanel: Loose;
export declare const FrameHeader: Loose;
export declare const FrameTitle: Loose;
export declare const FrameDescription: Loose;
export declare const FrameFooter: Loose;
export declare const Tabs: Loose;
export declare const TabsList: Loose;
export declare const TabsTab: Loose;
export declare const TabsPanel: Loose;
export declare const Textarea: Loose;
export declare const AlertDialog: Loose;
export declare const AlertDialogTrigger: Loose;
export declare const AlertDialogPopup: Loose;
export declare const AlertDialogHeader: Loose;
export declare const AlertDialogFooter: Loose;
export declare const AlertDialogTitle: Loose;
export declare const AlertDialogDescription: Loose;
export declare const AlertDialogClose: Loose;
export declare const ToggleGroup: Loose;
export declare const ToggleGroupItem: Loose;
export declare const Meter: Loose;
export declare const MeterLabel: Loose;
export declare const MeterTrack: Loose;
export declare const MeterIndicator: Loose;
export declare const MeterValue: Loose;
export declare const Alert: Loose;
export declare const AlertTitle: Loose;
export declare const AlertDescription: Loose;
export declare const Skeleton: Loose;
export declare const Menu: Loose;
export declare const MenuTrigger: Loose;
export declare const MenuPopup: Loose;
export declare const MenuItem: Loose;
export declare const MenuGroup: Loose;
export declare const MenuGroupLabel: Loose;
export declare const MenuSeparator: Loose;
// A panel that slides in from an edge: <Sheet open onOpenChange><SheetPopup
// side="right">…</SheetPopup></Sheet>, with SheetHeader, SheetPanel (the
// scrolling middle) and SheetFooter inside.
export declare const Sheet: Loose;
export declare const SheetPopup: Loose;
export declare const SheetHeader: Loose;
export declare const SheetTitle: Loose;
export declare const SheetDescription: Loose;
export declare const SheetPanel: Loose;
export declare const SheetFooter: Loose;
export declare const SheetClose: Loose;
export declare const Checkbox: Loose;
// The app's own pickers, so a plugin's choices look like the app's.
// PickOne: one of a few values, as a segmented control.
export declare const PickOne: ComponentType<{
  value: string;
  options: { value: string; label: ReactNode; icon?: ReactNode }[];
  onChange(value: string): void;
  label?: string;
  className?: string;
}>;
// BoxFilter: which boxes a screen covers. Pressed means shown; every box
// starts pressed and the last one on stays on. `hidden` is what you keep.
export declare const BoxFilter: ComponentType<{ boxes: string[]; hidden: string[]; onChange(hidden: string[]): void; label?: string; className?: string }>;
// FilterChip: narrows a list to rows with a label, tag or state. Chips start
// off; each one on narrows further. (One of a few values is PickOne.)
export declare const FilterChip: ComponentType<{ pressed: boolean; onPressedChange(pressed: boolean): void; children?: ReactNode; className?: string }>;
// Tip: the app's tooltip on one element, never the HTML title attribute,
// which shows late and not at all for keyboard users. A disabled button
// still shows its tip (why it is disabled, say).
export declare const Tip: ComponentType<{ label: ReactNode; side?: "top" | "bottom" | "left" | "right"; align?: "start" | "center" | "end"; delay?: number; className?: string; wrapClassName?: string; children: ReactNode }>;
// AgentPicker: one of a box's agents (BoxInfo.agents), with their icons.
export declare const AgentPicker: ComponentType<{ presets: { id: string; name: string }[]; value: string; onChange(id: string): void; allowNone?: boolean; className?: string }>;
// AgentIcon: an agent's mark, by preset id ("claude", "codex", …).
export declare const AgentIcon: ComponentType<{ agent?: string; className?: string }>;
// The strip at the top of a screen: <ViewHeader title description actions />.
// Render it anywhere in a screen and it takes the app's strip, so the screen
// names itself once, the way the app's own views do.
export declare const ViewHeader: ComponentType<{ title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
// The page body the app puts a screen in (max-w-5xl, left aligned). A
// screen with layout "fill" can use it for parts of its area.
export declare const PluginPage: ComponentType<{ className?: string; children?: ReactNode }>;
// Any lucide icon by name: <Icon name="Server" />.
export declare const Icon: ComponentType<{ name: string; className?: string }>;
// A chart drawn by the app's own chart components, in the theme's colours:
// bars, lines or areas over rows, as an agent's chart artifact is (the
// berth.chart format, docs/guides/artifacts). x names the row's label ("x"
// when left out) and y its series, by key; a color is "1" to "5" (the
// theme's series palette), "good", "bad", "warn" or "muted". The chart
// fills its box, 16rem high unless className says otherwise.
export interface ChartSpec {
  type: "bar" | "line" | "area";
  data: Record<string, string | number | null>[];
  x?: string;
  y: (string | { key: string; label?: string; color?: string })[];
  // "ms", "%", "$": written after (or before) a value in the tooltip.
  units?: string;
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}
export declare const Chart: ComponentType<{ spec: ChartSpec; className?: string }>;
export declare function cn(...classes: unknown[]): string;

// The app's diff renderer (@pierre/diffs, diffs.com: highlighted in two
// workers, themed like the app), loaded on first use and shared with the
// app's own diffs: its default export draws files as a scrolling list.
// Call loadDiffs() only when a diff is to be shown.
export interface DiffFile {
  name: string;
  prevName?: string;
  type: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
  hunks: readonly unknown[];
}
export interface DiffViewerItem {
  id: string;
  fileDiff: DiffFile;
  collapsed: boolean;
  // A new number whenever the item changes (folded, a new read), so the
  // view redraws exactly the files that did.
  version: number;
}
export interface DiffViewerProps {
  items: DiffViewerItem[];
  layout: "split" | "unified";
  wrap: boolean;
  dark: boolean;
  // Scrolls to a file; n changes for each jump.
  jump?: { id: string; n: number };
  // The file at the top of the view, as it scrolls.
  onActive?(id: string): void;
  renderHeader(id: string): ReactNode;
  // A different diff: start again from its top.
  resetKey?: string;
}
export interface DiffsModule {
  // A git patch, one entry per file.
  parse(patch: string): DiffFile[];
  default: ComponentType<DiffViewerProps>;
}
export declare function loadDiffs(): Promise<DiffsModule>;

// For Home widgets (berth.addHomeWidget), so one reads like Shipyard's own.
// WidgetRow: one 36px line, a button when it has onClick (label names it
// for screen readers when its text doesn't say enough).
export declare const WidgetRow: ComponentType<{ children?: ReactNode; onClick?: () => void; className?: string; label?: string }>;
// WidgetEmpty: nothing to show. A small scene ("calm", "anchor", "chart",
// "dock", "storm" for an error…), what that means, and one thing to do.
// compact drops the scene, for a one-row widget.
export declare const WidgetEmpty: ComponentType<{ scene?: string; title: string; hint?: ReactNode; action?: string; onAction?: () => void; compact?: boolean }>;
// WidgetSkeleton: rows while they load, at their height, so nothing moves.
export declare const WidgetSkeleton: ComponentType<{ rows?: number; className?: string }>;
