import { CopyIcon, MinusIcon, SquareIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isTauri } from "@/lib/api";
import { IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";

// WindowsTitlebar replaces the system frame with one that belongs to
// Shipyard. macOS keeps its traffic lights and Linux keeps its window
// manager's controls.
export function WindowsTitlebar() {
  const visible = isTauri() && IS_WINDOWS;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!visible) return;
    let unlisten: (() => void) | undefined;
    let live = true;

    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (!live) return;
      const appWindow = getCurrentWindow();
      const sync = () => void appWindow.isMaximized().then((value) => live && setMaximized(value));
      sync();
      const stop = await appWindow.onResized(sync);
      if (live) unlisten = stop;
      else stop();
    });

    return () => {
      live = false;
      unlisten?.();
    };
  }, [visible]);

  if (!visible) return null;

  const windowAction = async (action: "minimize" | "maximize" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const appWindow = getCurrentWindow();
    if (action === "minimize") await appWindow.minimize();
    else if (action === "maximize") await appWindow.toggleMaximize();
    else await appWindow.close();
  };

  return (
    <header
      data-tauri-drag-region
      aria-label="Shipyard window"
      className="flex h-bar shrink-0 select-none items-center border-b border-border/80 bg-sidebar text-sidebar-foreground"
    >
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2 px-edge">
        <span data-tauri-drag-region className="grid size-6 place-items-center rounded-md bg-primary text-primary-foreground shadow-sm">
          <SquareTerminalIcon className="size-4" strokeWidth={1.9} />
        </span>
        <span data-tauri-drag-region className="truncate font-semibold text-label tracking-wide">Shipyard</span>
      </div>
      <div data-tauri-drag-region className="min-w-8 flex-1 self-stretch" />
      <div className="flex h-full shrink-0">
        <WindowButton label="Minimize" onClick={() => void windowAction("minimize")}>
          <MinusIcon />
        </WindowButton>
        <WindowButton label={maximized ? "Restore" : "Maximize"} onClick={() => void windowAction("maximize")}>
          {maximized ? <CopyIcon /> : <SquareIcon />}
        </WindowButton>
        <WindowButton close label="Close" onClick={() => void windowAction("close")}>
          <XIcon />
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({ children, close, label, onClick }: { children: React.ReactNode; close?: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "grid h-full w-12 place-items-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-3.5",
        close && "hover:bg-destructive hover:text-white",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
