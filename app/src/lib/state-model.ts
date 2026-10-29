import type { BoxStatus } from "@/lib/api";
import type { SessionState } from "@/lib/derive";
import type { BoxData } from "@/lib/store";

// One state model, said the same way everywhere: sidebar rows, tabs, panes,
// the dashboard, zen, notifications, the status bar, Review and ⌘K all take
// their words from here, and their glyphs from components/agent-glyph.tsx.
//
//   agent     working · needs you · done · idle · ended
//   box       online · slow · outdated · offline · unreachable (· connecting, briefly)
//   worktree  clean · changed · setup failed (· setting up, briefly)
//
// Colour means one thing each: blue is working, amber is "needs you" and
// nothing else, green is done or online, red is something broken (an
// unreachable box, a failed setup), grey is at rest or gone.

export type AgentStatus = "working" | "needs-you" | "done" | "idle" | "ended";

// agentStatus is a session's state in the model's words; a plain shell has
// none.
export function agentStatus(s: SessionState): AgentStatus | undefined {
  switch (s) {
    case "running":
      return "working";
    case "waiting":
      return "needs-you";
    case "finished":
      return "done";
    case "ready":
      return "idle";
    case "exited":
      return "ended";
    default:
      return undefined;
  }
}

export const AGENT_WORDS: Record<AgentStatus, { word: string; lower: string; hint: string }> = {
  working: { word: "Working", lower: "working", hint: "Busy on its task" },
  "needs-you": { word: "Needs you", lower: "needs you", hint: "Waiting for your answer or permission" },
  done: { word: "Done", lower: "done", hint: "Finished its turn; look at what it did" },
  idle: { word: "Idle", lower: "idle", hint: "Open with nothing to do; give it a task" },
  ended: { word: "Ended", lower: "ended", hint: "Its program closed; start it again to carry on" },
};

// sessionWord is the one word for a session's state: "Working", "Needs
// you"…, or "Shell" for a plain shell.
export function sessionWord(s: SessionState, lower = false): string {
  const a = agentStatus(s);
  if (!a) return lower ? "shell" : "Shell";
  return lower ? AGENT_WORDS[a].lower : AGENT_WORDS[a].word;
}

export type BoxState = "online" | "slow" | "outdated" | "offline" | "unreachable" | "connecting";

export const BOX_WORDS: Record<BoxState, { word: string; lower: string; hint: string }> = {
  online: { word: "Online", lower: "online", hint: "Connected" },
  slow: { word: "Slow", lower: "slow", hint: "Connected over a slow link; requests still go through" },
  outdated: { word: "Outdated", lower: "outdated", hint: "Connected, but runs an older berthd; update it" },
  offline: { word: "Offline", lower: "offline", hint: "Not answering; Terminal reconnects on its own when it's back" },
  unreachable: { word: "Unreachable", lower: "unreachable", hint: "Answers, but Terminal can't use it" },
  connecting: { word: "Connecting", lower: "connecting", hint: "Reaching it now" },
};

// boxState is a box's state in the model: the agent's connection state,
// refined by what the app has seen (its API failing, an older build).
export function boxState(b: Pick<BoxStatus, "state" | "link"> | undefined, data?: BoxData, outdated?: boolean): BoxState {
  switch (b?.state) {
    case "online":
      if (data?.error && !data.sessions && !data.locations) return "unreachable";
      // Slow is still online: said quietly, and only while it lasts.
      if (b.link?.slow) return "slow";
      return outdated ? "outdated" : "online";
    case "connecting":
      return "connecting";
    case "untrusted":
      return "unreachable";
    default:
      return "offline";
  }
}

// boxWhy is a sentence on why a box is in its state, for tooltips.
export function boxWhy(name: string, b: Pick<BoxStatus, "state" | "error" | "link"> | undefined, state: BoxState): string {
  if (b?.state === "untrusted") return `${name} answered with a different identity than when it was paired, so Terminal won't talk to it. Pair it again if it was rebuilt.`;
  if (state === "outdated") return `${name} runs an older berthd than this Terminal ships. Updating keeps its agents running.`;
  if (state === "unreachable") return `${name} is connected, but its API isn't answering.`;
  if (state === "offline") return `${name} is offline. Its agents keep running there; Terminal reconnects on its own.`;
  if (state === "connecting") return `Connecting to ${name}…`;
  if (state === "slow") return `${name} is answering slowly${b?.link?.reason ? ` (${b.link.reason})` : ""}. Terminal stays connected, and requests still go through.`;
  return `${name} is online.`;
}

export type WorktreeState = "clean" | "changed" | "setup-failed" | "setting-up";

export const WORKTREE_WORDS: Record<WorktreeState, { word: string; lower: string }> = {
  clean: { word: "Clean", lower: "clean" },
  changed: { word: "Changed", lower: "changed" },
  "setup-failed": { word: "Setup failed", lower: "setup failed" },
  "setting-up": { word: "Setting up", lower: "setting up" },
};

export function worktreeState(w: { changed?: number; untracked?: number; setting_up?: boolean; setupFailed?: boolean }): WorktreeState {
  if (w.setting_up) return "setting-up";
  if (w.setupFailed) return "setup-failed";
  return (w.changed ?? 0) + (w.untracked ?? 0) > 0 ? "changed" : "clean";
}
