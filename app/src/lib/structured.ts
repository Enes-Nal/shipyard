import type { AgentPreset } from "@/lib/api";
import { usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";

// structuredLaunch is how an agent starts when Labs runs it structured:
// Claude Code through its stream ("driver.claude"), Codex through its app
// server ("driver.codex"), and an agent whose preset speaks ACP through that
// ("driver.acp"). Empty when it runs in its terminal, as without Labs.
export function structuredLaunch(box: string, agent: string, preset?: AgentPreset): { driver?: "claude" | "codex" | "acp"; mode?: string } {
  const p = usePrefs.getState();
  const caps = useStore.getState().boxes[box]?.info?.capabilities ?? [];
  if (!p.labs || !p.structuredClaude) return {};
  const driver = agent === "claude" || agent === "codex" ? agent : preset?.acp ? "acp" : undefined;
  if (!driver || !caps.includes(`driver.${driver}`)) return {};
  // ACP agents have modes of their own: bypass, or theirs as they start.
  const mode = p.approvals === "bypass" ? "bypassPermissions" : driver === "acp" ? undefined : "default";
  return { driver, mode };
}

// isStructured is whether a session's agent runs structured (Session.driver):
// its chat is its stream, and the pane's terminal shows only the host that
// runs it, never a screen of the agent's own to read or answer.
export function isStructured(driver?: string): boolean {
  return driver === "claude" || driver === "codex" || driver === "acp";
}
