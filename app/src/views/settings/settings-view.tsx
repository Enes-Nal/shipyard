import { ArrowLeftIcon, BellIcon, BotIcon, CableIcon, FlaskConicalIcon, InfoIcon, KeyboardIcon, LaptopIcon, PaletteIcon, PuzzleIcon, ServerIcon, SlidersHorizontalIcon, SmartphoneIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react";
import { type ComponentType, useEffect } from "react";

import { Tip } from "@/components/tip";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { AboutSection } from "@/views/settings/about-section";
import { AgentsSection } from "@/views/settings/agents-section";
import { useAppVersion } from "@/views/settings/app-version";
import { AppearanceSection } from "@/views/settings/appearance-section";
import { BoxesSection } from "@/views/settings/boxes-section";
import { ComputersSection } from "@/views/settings/computers-section";
import { DeveloperSection } from "@/views/settings/developer-section";
import { GeneralSection } from "@/views/settings/general-section";
import { IntegrationsSection } from "@/views/settings/integrations-section";
import { LabsSection } from "@/views/settings/labs-section";
import { NotificationsSection } from "@/views/settings/notifications-section";
import { PhoneSection } from "@/views/settings/phone-section";
import { PluginsSection } from "@/views/settings/plugins-section";
import { ShortcutsSection } from "@/views/settings/shortcuts-section";
import { TerminalSection } from "@/views/settings/terminal-section";

import { openSettings, type SettingsSectionId } from "@/views/settings/open";

export { openSettings, type SettingsSectionId };

const SECTIONS: { id: SettingsSectionId; title: string; icon: ComponentType<{ className?: string }>; Component: ComponentType }[] = [
  { id: "general", title: "General", icon: SlidersHorizontalIcon, Component: GeneralSection },
  { id: "notifications", title: "Notifications", icon: BellIcon, Component: NotificationsSection },
  { id: "appearance", title: "Appearance", icon: PaletteIcon, Component: AppearanceSection },
  { id: "terminal", title: "Terminal", icon: SquareTerminalIcon, Component: TerminalSection },
  { id: "boxes", title: "Boxes", icon: ServerIcon, Component: BoxesSection },
  { id: "computers", title: "Computers", icon: LaptopIcon, Component: ComputersSection },
  { id: "phone", title: "Phone", icon: SmartphoneIcon, Component: PhoneSection },
  { id: "agents", title: "Agents", icon: BotIcon, Component: AgentsSection },
  { id: "integrations", title: "Integrations", icon: CableIcon, Component: IntegrationsSection },
  { id: "plugins", title: "Plugins", icon: PuzzleIcon, Component: PluginsSection },
  { id: "shortcuts", title: "Shortcuts", icon: KeyboardIcon, Component: ShortcutsSection },
  { id: "labs", title: "Labs", icon: FlaskConicalIcon, Component: LabsSection },
  { id: "about", title: "About", icon: InfoIcon, Component: AboutSection },
  { id: "developer", title: "Developer", icon: WrenchIcon, Component: DeveloperSection },
];

// The nav groups the sections by what they're about; the quieter ones
// (Labs, Developer, About) sit at the bottom.
const GROUPS: { title?: string; ids: SettingsSectionId[] }[] = [
  { title: "Shipyard", ids: ["general", "appearance", "notifications", "shortcuts"] },
  { title: "Agents", ids: ["agents", "terminal", "integrations", "plugins"] },
  { title: "Machines", ids: ["boxes", "computers", "phone"] },
];
const BOTTOM: SettingsSectionId[] = ["labs", "developer", "about"];
// Longer names where the nav has room for them.
const NAV_TITLES: Partial<Record<SettingsSectionId, string>> = { agents: "Agents and models" };

const back = () => useStore.getState().setView({ kind: "workspace" });

// Settings takes the window with its own nav: Back to app at the top, then
// the sections in groups. Below 1200px of window the nav shrinks to its
// icons, so the settings themselves keep their width.
export function SettingsView() {
  const view = useStore((s) => s.view);
  const id = (view.kind === "settings" && SECTIONS.some((s) => s.id === view.section) ? view.section : "general") as SettingsSectionId;
  const current = SECTIONS.find((s) => s.id === id)!;

  // Esc goes back to the app, unless something in the page has it (a field,
  // a menu or a dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu], [role=listbox]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings sections" data-tauri-drag-region className="flex w-64 shrink-0 flex-col gap-5 overflow-y-auto border-r bg-sidebar px-3 pt-3 pb-3 max-[1200px]:w-14 max-[1200px]:px-2">
        <Tip label="Back to app" side="right" className="min-[1201px]:hidden">
          <button type="button" onClick={back} aria-label="Back to app" className="flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-muted-foreground text-sm transition-colors hover:bg-accent/60 hover:text-foreground max-[1200px]:justify-center max-[1200px]:px-0">
            <ArrowLeftIcon className="size-4 shrink-0" />
            <span className="flex-1 max-[1200px]:hidden">Back to app</span>
            <kbd className="font-sans text-muted-foreground text-xs max-[1200px]:hidden">esc</kbd>
          </button>
        </Tip>
        {GROUPS.map((g) => (
          <div key={g.title} className="flex flex-col gap-px">
            <div className="flex h-7 items-center px-2.5 font-medium text-muted-foreground text-xs max-[1200px]:hidden">{g.title}</div>
            {g.ids.map((sid) => (
              <NavItem key={sid} id={sid} current={id} />
            ))}
          </div>
        ))}
        <div className="flex-1" />
        <div className="flex flex-col gap-px">
          {BOTTOM.map((sid) => (
            <NavItem key={sid} id={sid} current={id} quiet />
          ))}
        </div>
      </nav>
      <div data-testid={`settings-${id}`} className="min-w-0 flex-1 overflow-y-auto bg-background">
        <current.Component key={id} />
      </div>
    </div>
  );
}

function NavItem({ id, current, quiet }: { id: SettingsSectionId; current: SettingsSectionId; quiet?: boolean }) {
  const s = SECTIONS.find((x) => x.id === id)!;
  const title = NAV_TITLES[id] ?? s.title;
  const active = id === current;
  return (
    // The tooltip is for the narrow window, where only icons show.
    <Tip label={title} side="right" className="min-[1201px]:hidden">
      <button
        type="button"
        onClick={() => openSettings(s.id)}
        data-testid={`settings-nav-${s.id}`}
        aria-current={active ? "page" : undefined}
        aria-label={s.title}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors max-[1200px]:justify-center max-[1200px]:px-0",
          active ? "bg-accent font-medium text-foreground" : quiet ? "text-muted-foreground hover:bg-accent/60 hover:text-foreground" : "text-foreground/85 hover:bg-accent/60 hover:text-foreground",
        )}
      >
        <s.icon className="size-4 shrink-0 min-[1201px]:hidden" />
        <span className="flex-1 truncate max-[1200px]:hidden">{title}</span>
        <NavNote id={id} />
      </button>
    </Tip>
  );
}

// NavNote is the quiet fact beside a few sections: how many boxes are
// online, the app's version.
function NavNote({ id }: { id: SettingsSectionId }) {
  const status = useStore((s) => s.status);
  const version = useAppVersion();
  let note: string | undefined;
  if (id === "boxes" && status?.boxes.length) note = `${status.boxes.filter((b) => b.state === "online").length} of ${status.boxes.length} online`;
  if (id === "about" && version && version !== "…") note = version === "dev" || version === "unknown" ? version : `v${version}`;
  if (!note) return null;
  return <span className="shrink-0 font-normal text-muted-foreground text-xs tabular-nums max-[1200px]:hidden">{note}</span>;
}
