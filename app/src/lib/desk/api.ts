import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/api";
import type { CrewMember, TranscriptItem } from "@/lib/transcript";

// The desk (internal/desk) is the app's backend on Windows: projects, the
// chats in each, and the agents they run in the project's own folder. The
// Tauri shell starts it and hands over where it listens (desk_endpoint);
// a browser tab on the dev server takes VITE_DESK_URL and VITE_DESK_TOKEN.

export interface DeskProject {
  id: string;
  name: string;
  path: string;
  added: number;
  repo: boolean;
  branch?: string;
  dirty?: boolean;
  // The chat working in it now.
  running?: string;
  missing?: boolean;
}

export interface BranchMove {
  kind: "created" | "switched";
  from?: string;
  to: string;
  at: number;
}

export type ChatAccess = "full" | "edits";

export interface DeskChat {
  id: string;
  project: string;
  title: string;
  agent: string;
  session: string;
  started?: boolean;
  branch?: string;
  moves?: BranchMove[];
  access: ChatAccess;
  created: number;
  updated: number;
  status: "idle" | "running" | "queued";
  // When the running turn started (ms).
  since?: number;
  queued?: string[];
  error?: string;
}

export interface DeskState {
  projects: DeskProject[];
  chats: DeskChat[];
}

// What GET /v1/chats/{id}/items answers (internal/transcript's Result).
export interface ItemsPage {
  items: TranscriptItem[];
  next: number;
  crew: CrewMember[];
  gen?: string;
  reset?: boolean;
  last?: number;
}

export type DeskEvent = { type: "state" } | { type: "items"; chat: string };

interface Endpoint {
  url: string;
  token: string;
}

let endpoint: Promise<Endpoint> | undefined;

function where(): Promise<Endpoint> {
  endpoint ??= (async () => {
    if (isTauri()) return invoke<Endpoint>("desk_endpoint");
    const url = import.meta.env.VITE_DESK_URL as string | undefined;
    const token = import.meta.env.VITE_DESK_TOKEN as string | undefined;
    if (!url || !token) throw new Error("Run the app with pnpm tauri dev, or set VITE_DESK_URL and VITE_DESK_TOKEN to a running berth-desk.");
    return { url, token };
  })();
  // A desk that failed to start is asked again next time.
  endpoint.catch(() => (endpoint = undefined));
  return endpoint;
}

export class DeskError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const ep = await where();
  const res = await fetch(ep.url + path, {
    method,
    headers: {
      Authorization: `Bearer ${ep.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new DeskError((data as { error?: string }).error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const desk = {
  state: () => call<DeskState>("GET", "/v1/state"),
  addProject: (path: string) => call<DeskProject>("POST", "/v1/projects", { path }),
  removeProject: (id: string) => call("DELETE", `/v1/projects/${id}`),
  newChat: (project: string, access?: ChatAccess) => call<DeskChat>("POST", "/v1/chats", { project, access }),
  updateChat: (id: string, patch: { title?: string; access?: ChatAccess }) => call<DeskChat>("PATCH", `/v1/chats/${id}`, patch),
  removeChat: (id: string) => call("DELETE", `/v1/chats/${id}`),
  send: (id: string, text: string, branch?: string) => call<{ queued: boolean }>("POST", `/v1/chats/${id}/send`, { text, branch }),
  stop: (id: string) => call("POST", `/v1/chats/${id}/stop`),
  items: (id: string, since: number, gen?: string) => call<ItemsPage>("GET", `/v1/chats/${id}/items?since=${since}${gen ? `&gen=${encodeURIComponent(gen)}` : ""}`),
  pickFolder: () => (isTauri() ? invoke<string | null>("pick_folder") : Promise.resolve(null)),
};

// listen hears the desk's events until the returned function is called,
// connecting again when the stream drops. up says whether it is connected.
export function listen(on: (e: DeskEvent) => void, up: (connected: boolean) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | undefined;
  const run = async () => {
    while (!stopped) {
      try {
        const ep = await where();
        ctrl = new AbortController();
        const res = await fetch(`${ep.url}/v1/events`, {
          headers: { Authorization: `Bearer ${ep.token}` },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        up(true);
        // Anything may have changed while it was down.
        on({ type: "state" });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let at;
          while ((at = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, at);
            buf = buf.slice(at + 2);
            const data = block
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (data) on(JSON.parse(data) as DeskEvent);
          }
        }
      } catch {
        // Down: try again shortly.
      }
      if (stopped) return;
      up(false);
      await new Promise((r) => setTimeout(r, 1000));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
