import { create } from "zustand";

import { laptopApi, type OutdatedBox } from "@/lib/api";
import { explain } from "@/lib/errors";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";

// Boxes that run an older berthd than this Shipkit ships. The laptop agent
// answers (GET /v1/boxes/outdated, which asks `berth upgrade BOX --check`);
// the app says so once, calmly, in the status bar and Settings → Boxes, and
// Update all runs the same upgrade as Settings → Boxes → Update, one box at
// a time. Sessions keep running through an upgrade: berthd replaces itself
// in place. With "Update boxes automatically" on, each outdated box is
// updated once per build Shipkit ships.

// lines is the upgrade's output so far (the last 40), line its newest.
export type UpdateState = { state: "queued" | "running" | "done" | "failed"; line?: string; lines?: string[]; error?: string; details?: string };

interface State {
  // By box, for online boxes the agent checked. Missing: not checked yet.
  boxes: Record<string, OutdatedBox>;
  checkedAt?: number;
  // An agent too old to answer: the app can't tell, so it says nothing.
  unsupported?: boolean;
  updating: Record<string, UpdateState>;
}

export const useOutdated = create<State>(() => ({ boxes: {}, updating: {} }));

const NO_BOXES: string[] = [];
let lastKey = "";
let lastList: string[] = NO_BOXES;

// useOutdatedBoxes is the online boxes that run an older berthd, by name.
export function useOutdatedBoxes(): string[] {
  const boxes = useOutdated((s) => s.boxes);
  const online = useStore((s) => s.status?.boxes);
  const list = (online ?? []).filter((b) => b.state === "online" && boxes[b.name]?.outdated).map((b) => b.name);
  const key = list.join("\n");
  if (key !== lastKey) {
    lastKey = key;
    lastList = list.length ? list : NO_BOXES;
  }
  return lastList;
}

export const isOutdated = (box: string) => !!useOutdated.getState().boxes[box]?.outdated;

let checking: Promise<void> | null = null;

// refreshOutdated asks the agent again; fresh skips its two-minute memory.
export function refreshOutdated(fresh = false): Promise<void> {
  const client = useStore.getState().client;
  if (!client) return Promise.resolve();
  checking ??= laptopApi
    .outdated(client, fresh)
    .then(
      (r) => {
        const boxes: Record<string, OutdatedBox> = {};
        for (const b of r.boxes ?? []) boxes[b.box] = b;
        useOutdated.setState({ boxes, checkedAt: Date.now(), unsupported: false });
        void autoUpdate();
      },
      (err) => {
        // An agent from before this endpoint: nothing to say.
        if ((err as { status?: number }).status === 404) useOutdated.setState({ unsupported: true });
      },
    )
    .finally(() => {
      checking = null;
    });
  return checking;
}

let queue: Promise<void> = Promise.resolve();

// updateBoxes updates each box in turn, with its progress in `updating`.
// It resolves with the boxes that failed.
export function updateBoxes(names: string[], opts: { quiet?: boolean } = {}): Promise<string[]> {
  const todo = names.filter((n) => !["queued", "running"].includes(useOutdated.getState().updating[n]?.state ?? ""));
  if (!todo.length) return Promise.resolve([]);
  setUpdating(Object.fromEntries(todo.map((n) => [n, { state: "queued" as const }])));
  const failed: string[] = [];
  const run = queue.then(async () => {
    for (const box of todo) {
      const client = useStore.getState().client;
      if (!client) break;
      setUpdating({ [box]: { state: "running", lines: [] } });
      const lines: string[] = [];
      try {
        await laptopApi.upgrade(client, box, (line) => {
          lines.push(line);
          if (lines.length > 40) lines.shift();
          setUpdating({ [box]: { state: "running", line, lines: [...lines] } });
        });
        setUpdating({ [box]: { state: "done", lines: [...lines] } });
        useOutdated.setState((s) => ({ boxes: { ...s.boxes, [box]: { ...s.boxes[box], box, outdated: false } } }));
        await useStore.getState().refreshBox(box, ["info", "sessions"]);
      } catch (err) {
        failed.push(box);
        const e = explain(err, { box });
        setUpdating({ [box]: { state: "failed", lines: [...lines], error: e.message, details: e.details } });
      }
    }
    await refreshOutdated(true);
    if (!opts.quiet || failed.length) void announce(todo, failed);
    // A finished row clears after a while; a failed one stays to say why.
    window.setTimeout(() => {
      useOutdated.setState((s) => ({ updating: Object.fromEntries(Object.entries(s.updating).filter(([, u]) => u.state !== "done")) }));
    }, 8000);
  });
  queue = run.catch(() => {});
  return run.then(() => failed);
}

function setUpdating(patch: Record<string, UpdateState>) {
  useOutdated.setState((s) => ({ updating: { ...s.updating, ...patch } }));
}

async function announce(todo: string[], failed: string[]) {
  const { toastManager } = await import("@/components/ui/toast");
  const ok = todo.filter((b) => !failed.includes(b));
  if (failed.length) {
    const why = useOutdated.getState().updating[failed[0]]?.error;
    toastManager.add({
      type: "error",
      title: failed.length === 1 ? `Couldn't update ${failed[0]}` : `Couldn't update ${failed.length} boxes`,
      description: why ?? "Settings → Boxes says why.",
      actionProps: { children: "Retry", onClick: () => void updateBoxes(failed) },
    });
  }
  if (ok.length) toastManager.add({ type: "success", title: ok.length === 1 ? `${ok[0]} is up to date` : `${ok.length} boxes are up to date`, description: ok.length === 1 ? "Its agents kept running." : "Their agents kept running." });
}

// Each box is updated automatically once per build Shipkit ships, so a box
// whose update fails is not retried in a loop.
const tried = new Set<string>();

async function autoUpdate() {
  if (!usePrefs.getState().autoUpdateBoxes) return;
  const due = Object.values(useOutdated.getState().boxes).filter((b) => b.outdated && !tried.has(`${b.box}@${b.available}`));
  if (!due.length) return;
  for (const b of due) tried.add(`${b.box}@${b.available}`);
  await updateBoxes(
    due.map((b) => b.box),
    { quiet: false },
  );
}

const EVERY = 30 * 60 * 1000;

// startOutdatedWatch checks on connect, whenever the set of online boxes
// changes, and every half hour while the window is visible.
export function startOutdatedWatch(): () => void {
  let key = "";
  const check = () => {
    if (!document.hidden) void refreshOutdated();
  };
  const unsub = useStore.subscribe((s) => {
    const next = (s.status?.boxes ?? []).filter((b) => b.state === "online").map((b) => b.name).join(",");
    if (next === key) return;
    key = next;
    if (next) check();
  });
  const timer = window.setInterval(check, EVERY);
  const onVisible = () => {
    const at = useOutdated.getState().checkedAt ?? 0;
    if (!document.hidden && Date.now() - at > EVERY) check();
  };
  document.addEventListener("visibilitychange", onVisible);
  // Turning automatic updates on acts on what is already known.
  const unsubPrefs = usePrefs.subscribe((p, prev) => {
    if (p.autoUpdateBoxes && !prev.autoUpdateBoxes) void autoUpdate();
  });
  check();
  return () => {
    unsub();
    unsubPrefs();
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
