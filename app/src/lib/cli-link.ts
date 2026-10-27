import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/api";

// The berth command in a terminal: Shipkit.app carries the CLI, and Settings →
// General can link ~/.local/bin/berth to it (src-tauri/src/cli_link.rs).

export interface CliLink {
  link: string;
  // The CLI inside this copy of Shipkit.app; null in a dev build or a browser.
  bundled: string | null;
  // Why it cannot be linked yet (running from the disk image, say).
  blocked: string | null;
  state: "missing" | "linked" | "symlink" | "file";
  target: string | null;
}

export async function cliLinkStatus(): Promise<CliLink | null> {
  if (!isTauri()) return null;
  return invoke<CliLink>("cli_link_status");
}

export async function installCliLink(): Promise<CliLink> {
  return invoke<CliLink>("install_cli_link");
}
