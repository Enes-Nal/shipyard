import { useEffect } from "react";

import { isTauri } from "@/lib/api";
import { LINUX_ALPHA } from "@/lib/platform";
import { useStore } from "@/lib/store";
import { homeBox, useWorkspaces } from "@/lib/workspaces";
import { placeLabel } from "@/lib/worktree-names";

// useWindowTitle names the window after the worktree in front, by its
// display name when it was given one ("shop / Fix checkout — Shipyard"), for
// the Window menu, Mission Control and the browser tab in mock mode.
export function useWindowTitle() {
  const ref = useWorkspaces((s) => (s.current && !homeBox(s.current) ? s.spaces[s.current]?.ref : undefined));
  const inWorkspace = useStore((s) => s.view.kind === "workspace");
  const label = useStore((s) => (ref?.path ? placeLabel(ref, s.boxes) : undefined));
  useEffect(() => {
    let title = inWorkspace && label ? `${label} — Shipyard` : "Shipyard";
    // The Linux app is an alpha, and its title bar says so.
    if (LINUX_ALPHA) title += " (alpha)";
    if (document.title !== title) document.title = title;
    if (isTauri())
      void import("@tauri-apps/api/window")
        .then((w) => w.getCurrentWindow().setTitle(title))
        .catch(() => {});
  }, [inWorkspace, label]);
}
