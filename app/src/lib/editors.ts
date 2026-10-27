import { useSyncExternalStore } from "react";

import { ApiError, type Client } from "@/lib/api";

// Opening worktrees, and files at a line, in the editor on this computer.
// The laptop agent does the opening: it knows which editors are installed,
// which boxes are this computer, and the SSH host each other box has
// (berth-<box>), and runs the editor's command line tool or URL.

export type EditorId = "cursor" | "vscode" | "windsurf" | "zed";

export interface Editor {
  id: EditorId;
  name: string;
  installed: boolean;
  cli?: string;
  // Files open at a line on remote boxes (VS Code's links open folders only).
  lines: boolean;
}

export interface OpenRequest {
  editor: EditorId;
  box: string;
  // A folder: a path, or a location ("shop" or "shop/checkout") on the box.
  path?: string;
  location?: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface OpenResult {
  command: string[];
  note?: string;
}

export interface SSHHost {
  box: string;
  host?: string;
  user?: string;
  network?: string;
  local?: boolean;
  ready: boolean;
}

export interface SSHChange {
  path: string;
  action: "create" | "update" | "remove";
  diff: string;
}

export interface SSHPlan {
  dir: string;
  hosts: SSHHost[];
  changes: SSHChange[];
}

export const editorsApi = {
  list: async (c: Client) => (await c.laptop<Editor[] | null>("GET", "/v1/editors")) ?? [],
  open: (c: Client, req: OpenRequest) => c.laptop<OpenResult>("POST", "/v1/editors/open", req),
  sshPlan: (c: Client) => c.laptop<SSHPlan>("GET", "/v1/ssh-config"),
  // Writes exactly the plan shown; only after the person confirmed it.
  sshWrite: (c: Client) => c.laptop<SSHPlan>("POST", "/v1/ssh-config"),
};

// The editor someone prefers, remembered on this computer.
const KEY = "berth.editor";
const listeners = new Set<() => void>();

function read(): EditorId | undefined {
  try {
    return (localStorage.getItem(KEY) as EditorId | null) ?? undefined;
  } catch {
    return undefined;
  }
}

export function setPreferredEditor(id: EditorId) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered; nothing else depends on it.
  }
  listeners.forEach((l) => l());
}

export function usePreferredEditor(): EditorId | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
    () => undefined,
  );
}

// pickEditor is the preferred editor if installed, else the first that is.
export function pickEditor(editors: Editor[], preferred?: EditorId): Editor | undefined {
  const installed = editors.filter((e) => e.installed);
  return installed.find((e) => e.id === preferred) ?? installed[0];
}

let cached: Promise<Editor[]> | undefined;

// installedEditors asks the agent once per session; editors rarely appear
// while the app is open.
export function installedEditors(c: Client, refresh = false): Promise<Editor[]> {
  if (refresh || !cached) cached = editorsApi.list(c).catch(() => []);
  return cached;
}

export class SSHSetupNeeded extends Error {
  constructor(box: string) {
    super(`Editors can't reach ${box} yet: set up SSH for editors in Settings → Boxes.`);
  }
}

// openInEditor opens a folder or file in the given (or preferred) editor.
export async function openInEditor(c: Client, req: Omit<OpenRequest, "editor"> & { editor?: EditorId }): Promise<OpenResult> {
  const editors = await installedEditors(c);
  const ed = req.editor ? editors.find((e) => e.id === req.editor && e.installed) : pickEditor(editors, read());
  if (!ed) throw new Error("No supported editor is installed. Terminal opens Cursor, VS Code, Windsurf and Zed.");
  try {
    return await editorsApi.open(c, { ...req, editor: ed.id });
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) throw new SSHSetupNeeded(req.box);
    throw err;
  }
}

export { findPaths, resolveIn, type PathMatch } from "@/lib/editor-paths";
