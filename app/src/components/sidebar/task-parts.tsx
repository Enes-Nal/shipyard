import { useSyncExternalStore } from "react";

import { StatusDot } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import type { SessionState } from "@/lib/derive";
import { useOutdatedBoxes } from "@/lib/outdated";
import { boxesLine, shortAgo } from "@/lib/sidebar-task";
import { BOX_WORDS, boxState, sessionWord } from "@/lib/state-model";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

// The pieces a task row in the sidebar is made of, and its foot. A row is
// a fixed status lane, the task's title and a fixed time lane, so titles
// and times line up down the list; no logos, the lane says how it's going.

// The row you have open: a soft tint a step past the hover colour, from
// the theme's own sidebar and text colours.
export const selectedRow = "data-[active=true]:bg-[color-mix(in_srgb,var(--sidebar-accent),var(--foreground)_4%)] data-[active=true]:font-medium data-[active=true]:text-foreground";

// A task row is a place row's height (28px at the default density), and so
// is a child's, under its parent on the guide.
// It stays lit while the pointer is on its + and ⋯, which sit on that light.
export const taskRowClass = cn("h-side-row w-full translate-x-0 gap-2 px-2 text-[13px] font-normal sm:h-side-row group-hover/row:not-data-[active=true]:bg-sidebar-accent", selectedRow);
export const childRowClass = "h-side-row gap-2 pr-2 pl-1.5 text-[13px] sm:h-side-row";

// toneOf is how much a row's title asks of you: waiting for you in full
// ink, working a little softer, done or idle muted.
export function toneOf(state?: SessionState) {
  if (state === "waiting") return "text-foreground";
  if (state === "running") return "text-foreground/85";
  return "text-muted-foreground";
}

// TaskGlyph is a row's status lane: an amber dot while its agent needs you,
// a blue arc while it works, a green check once it's done, a hollow dot
// otherwise. small is a child row's narrower lane.
export function TaskGlyph({ state, small }: { state?: SessionState; small?: boolean }) {
  const label = state && state !== "exited" ? sessionWord(state) : "Idle";
  return (
    <span role="img" aria-label={label} className={cn("inline-flex shrink-0 items-center justify-center", "w-3.5")}>
      {state === "waiting" ? (
        <span className="size-[7px] rounded-full bg-warning" />
      ) : state === "running" ? (
        <svg viewBox="0 0 24 24" aria-hidden className={cn("text-info motion-safe:animate-spin motion-safe:[animation-duration:1.4s]", small ? "size-[11px]" : "size-3")}>
          <path d="M21 12a9 9 0 1 1-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      ) : state === "finished" ? (
        <svg viewBox="0 0 24 24" aria-hidden className={cn("text-success", small ? "size-3" : "size-[13px]")}>
          <path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="size-1.5 rounded-full border-[1.5px] border-muted-foreground/55" />
      )}
    </span>
  );
}

// BranchMark is the small fork an orchestrator's row shows before the
// count of worktrees it handed work to.
export function BranchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-3 shrink-0", className)}>
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="18" r="2.5" />
        <path d="M6 8.5V14a4 4 0 0 0 4 4h5.5" />
      </g>
    </svg>
  );
}

// One clock for every time lane: it ticks each 30 seconds while any lane
// is on screen.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (timer === undefined) {
    timer = window.setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
const useNow = () => useSyncExternalStore(subscribe, () => now);

// TimeLane is how long a row's agent has been as it is ("now", "4m", "1h"),
// right-aligned in a fixed lane; tip says what runs there.
export function TimeLane({ since, tip }: { since?: string; tip?: string }) {
  const t = useNow();
  const text = shortAgo(since, Math.max(t, Date.now() - 30_000));
  const lane = (
    <span data-testid="row-time" className="w-7 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums in-data-[active=true]:text-sidebar-foreground">
      {text}
    </span>
  );
  return tip && text ? <Tip label={tip}>{lane}</Tip> : lane;
}

// BoxesFoot is the sidebar's foot: a dot for each box and which are online,
// opening Settings → Boxes.
export function BoxesFoot() {
  const status = useStore((s) => s.status);
  const boxes = useStore((s) => s.boxes);
  const outdated = useOutdatedBoxes();
  const list = status?.boxes ?? [];
  const states = list.map((b) => ({ name: b.name, state: boxState(b, boxes[b.name], outdated.includes(b.name)), online: b.state === "online" }));
  const line = boxesLine(states);
  return (
    <Tip
      side="top"
      align="start"
      label={
        list.length ? (
          <span className="flex flex-col gap-0.5">
            {states.map((b) => (
              <span key={b.name} className="flex items-center gap-1.5">
                <StatusDot state={b.state} />
                {b.name}: {BOX_WORDS[b.state].lower}
              </span>
            ))}
          </span>
        ) : (
          "Add a box in Settings → Boxes"
        )
      }
    >
      <button
        type="button"
        data-testid="sidebar-boxes"
        onClick={() => useStore.getState().setView({ kind: "settings", section: "boxes" })}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        {states.length > 0 && (
          <span className="flex shrink-0 items-center gap-1">
            {states.slice(0, 6).map((b) => (
              // Green while up (fainter on a slow link), grey otherwise.
              <StatusDot key={b.name} state={b.online ? (b.state === "slow" ? "slow" : "online") : "offline"} />
            ))}
          </span>
        )}
        <span className="min-w-0 truncate">{line}</span>
      </button>
    </Tip>
  );
}
