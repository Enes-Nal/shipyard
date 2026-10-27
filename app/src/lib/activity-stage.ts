export type ActivityStage = "todo" | "doing" | "done";

export interface ActivitySignals {
  paused?: boolean;
  running: boolean;
  changed: number;
  untracked: number;
  ahead: number;
}

// A worktree is the durable task. Live agent work or uncommitted files keep
// it in progress; a clean branch with commits is done and ready to review.
export function activityStage(s: ActivitySignals): ActivityStage {
  if (s.running || s.changed + s.untracked > 0) return "doing";
  if (!s.paused && s.ahead > 0) return "done";
  return "todo";
}
