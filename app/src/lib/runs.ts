import { create } from "zustand";

import type { Run, RunSummary } from "@/lib/api";
import { type BoxCaller, runsApi, terminal } from "@/lib/orchestrate-core";
import { poll } from "@/lib/poll";
import { load, save } from "@/lib/storage";
import { useStore } from "@/lib/store";

// Runs are orchestrations the box executes and journals: loops, reviews,
// hand-offs, broadcasts, attempts and flows. The app only reads and steers
// them, so they show the same on every device and survive the app quitting.
// This store keeps each box's recent runs, refreshed when a run event
// arrives and, while any is going, every few seconds.

export const call: BoxCaller = (box, method, path, body) => {
  const c = useStore.getState().client;
  if (!c) return Promise.reject(new Error("not connected to the Shipkit agent"));
  return c.box(box, method, path, body);
};

export const runs = runsApi(call);

// boxHasRuns says whether a box executes runs (its info lists "runs"). Older
// boxes get the app's own loop and broadcast instead.
export const boxHasRuns = (box: string) => !!useStore.getState().boxes[box]?.info?.capabilities?.includes("runs");

export interface BoxRun extends RunSummary {
  box: string;
}

interface RunsState {
  byBox: Record<string, RunSummary[]>;
  // Runs dismissed from the loops panel, by box/id.
  dismissed: string[];
}

export const useRuns = create<RunsState>()(() => ({ byBox: {}, dismissed: load<string[]>("berth.runs.dismissed", []) }));

const inflight = new Map<string, Promise<void>>();

// refreshRuns reloads a box's recent runs.
export function refreshRuns(box: string): Promise<void> {
  if (!boxHasRuns(box)) return Promise.resolve();
  const running = inflight.get(box);
  if (running) return running;
  const p = runs
    .list(box, { limit: 60 })
    .then((list) => useRuns.setState((s) => ({ byBox: { ...s.byBox, [box]: list } })))
    .catch(() => {})
    .finally(() => inflight.delete(box));
  inflight.set(box, p);
  return p;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

// scheduleRuns coalesces a burst of run events into one reload.
export function scheduleRuns(box: string, ms = 400) {
  if (timers.has(box)) return;
  timers.set(
    box,
    setTimeout(() => {
      timers.delete(box);
      void refreshRuns(box);
    }, ms),
  );
}

// allRuns is every box's runs, newest first.
export function allRuns(byBox: Record<string, RunSummary[]>): BoxRun[] {
  return Object.entries(byBox)
    .flatMap(([box, list]) => list.map((r) => ({ ...r, box })))
    .sort((a, b) => b.created.localeCompare(a.created));
}

export const isActive = (r: { status: string }) => !terminal(r.status);

export function dismissRun(box: string, id: string) {
  const dismissed = [...useRuns.getState().dismissed, `${box}/${id}`].slice(-200);
  useRuns.setState({ dismissed });
  save("berth.runs.dismissed", dismissed);
}

// startRunsWatch loads every online box's runs and keeps the active ones
// fresh: every 5s while they change, backing off to 30s while they don't
// (a run's events reload its box at once, scheduleRuns), and not while the
// window is hidden. It returns a stop function.
export function startRunsWatch(): () => void {
  const p = poll(
    async () => {
      const boxes = useStore.getState().boxes;
      const before = useRuns.getState().byBox;
      const reads: Promise<void>[] = [];
      for (const box of Object.keys(boxes)) {
        if (!boxHasRuns(box)) continue;
        const list = before[box];
        if (!list || list.some(isActive)) reads.push(refreshRuns(box));
      }
      // A box whose info hasn't come yet may have runs: no backing off yet.
      if (!reads.length) return Object.values(boxes).some((b) => !b.info) ? undefined : false;
      await Promise.all(reads);
      const after = useRuns.getState().byBox;
      return Object.keys(after).some((b) => JSON.stringify(after[b]) !== JSON.stringify(before[b]));
    },
    { every: 5000, max: 30_000 },
  );
  return () => p.stop();
}

// getRun reads one run with its steps.
export const getRun = (box: string, id: string): Promise<Run> => runs.get(box, id);
