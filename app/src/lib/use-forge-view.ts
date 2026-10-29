import { useEffect, useMemo } from "react";
import { create } from "zustand";

import type { Client } from "@/lib/api";
import type { ForgeView } from "@/lib/forge-view";
import { plainError } from "@/lib/errors";
import { useStore } from "@/lib/store";

// The forge view of each project, shared by everything that shows it (the
// GitLab tab, the board's cards), and read again every minute while one of
// them is on screen. The box caches it too, and fetches origin itself.

const EVERY_MS = 60_000;

export const forgeApi = {
  view: (c: Client, box: string, location: string, refresh = false) => c.box<ForgeView>(box, "GET", `locations/${encodeURIComponent(location)}/forge${refresh ? "?refresh=1" : ""}`),
};

interface Entry {
  view?: ForgeView;
  error?: string;
  loading: boolean;
}

const useForgeStore = create<{ entries: Record<string, Entry> }>(() => ({ entries: {} }));
// One timer per project, however many cards show it.
const watchers = new Map<string, { n: number; timer: number }>();
const inFlight = new Set<string>();

const keyOf = (box: string, location: string) => `${box}/${location}`;

async function load(box: string, location: string, refresh = false) {
  const client = useStore.getState().client;
  const key = keyOf(box, location);
  if (!client || inFlight.has(key)) return;
  inFlight.add(key);
  const set = (e: Partial<Entry>) => useForgeStore.setState((s) => ({ entries: { ...s.entries, [key]: { ...(s.entries[key] ?? { loading: false }), ...e } } }));
  set({ loading: true });
  try {
    set({ view: await forgeApi.view(client, box, location, refresh), error: undefined, loading: false });
  } catch (err) {
    set({ error: plainError(err), loading: false });
  } finally {
    inFlight.delete(key);
  }
}

export const refreshForge = (box: string, location: string) => void load(box, location, true);

// useForgeViews reads the forge views already loaded for several projects
// (each kept current by a useForgeView elsewhere), by "box/location".
export function useForgeViews(keys: string[]): Record<string, ForgeView | undefined> {
  const entries = useForgeStore((s) => s.entries);
  return useMemo(() => Object.fromEntries(keys.map((k) => [k, entries[k]?.view])), [entries, keys]);
}

// useForgeView reads a project's forge view, and keeps it current while
// the caller is mounted (and enabled).
export function useForgeView(box: string, location: string, enabled = true): Entry {
  const key = keyOf(box, location);
  const entry = useForgeStore((s) => s.entries[key]);
  useEffect(() => {
    if (!enabled) return;
    const w = watchers.get(key);
    if (w) w.n++;
    else {
      const stale = Date.parse(useForgeStore.getState().entries[key]?.view?.fetched ?? "") || 0;
      if (Date.now() - stale > EVERY_MS / 2) void load(box, location);
      watchers.set(key, { n: 1, timer: window.setInterval(() => !document.hidden && void load(box, location), EVERY_MS) });
    }
    return () => {
      const w = watchers.get(key);
      if (!w) return;
      if (--w.n > 0) return;
      window.clearInterval(w.timer);
      watchers.delete(key);
    };
  }, [box, location, key, enabled]);
  return entry ?? { loading: enabled };
}
