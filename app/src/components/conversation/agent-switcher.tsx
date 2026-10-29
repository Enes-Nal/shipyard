import { ArrowRightLeftIcon, UsersRoundIcon } from "lucide-react";
import { useMemo } from "react";

import { AgentIcon, StateGlyph } from "@/components/agent-glyph";
import { openOrchestrate } from "@/components/orchestrate/session-actions";
import { Tip } from "@/components/tip";
import { agentLabel, agentOf, chatState } from "@/lib/derive";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { focusSession } from "@/lib/workspaces";

// AgentSwitcher keeps every agent working in this worktree one click away,
// and makes the context-preserving agent/model handoff visible. Focusing a
// tab never stops or restarts a model.
export function AgentSwitcher({ box, session, dir }: { box: string; session: string; dir?: string }) {
  const sessions = useStore((s) => s.boxes[box]?.sessions ?? NONE);
  const stats = useStore((s) => s.boxes[box]?.stats);
  const agents = useMemo(
    () => sessions.filter((s) => !s.exited && s.dir === dir && agentOf(s)).sort((a, b) => (a.created ?? "").localeCompare(b.created ?? "")),
    [sessions, dir],
  );
  if (!dir || agents.length === 0) return null;
  return (
    <nav aria-label="Agents in this worktree" className="relative z-10 flex h-bar-pane shrink-0 items-center gap-2 border-b bg-background/92 px-edge backdrop-blur-sm">
      <span className="flex shrink-0 items-center gap-1.5 text-meta text-muted-foreground">
        <UsersRoundIcon className="size-3.5" />
        {agents.length} {agents.length === 1 ? "agent" : "agents"}
      </span>
      <div role="tablist" aria-label="Switch agent" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
        {agents.map((item) => {
          const id = agentOf(item)!;
          const active = item.name === session;
          const state = chatState(item, stats);
          const label = item.title?.trim() || agentLabel(id);
          return (
            <Tip key={item.name} label={`${agentLabel(id)} · ${state === "waiting" ? "needs you" : state}`}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => void focusSession(box, item.name)}
                className={cn(
                  "inline-flex h-7 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-label outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "bg-foreground text-background shadow-xs" : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <AgentIcon agent={id} className="size-3.5 shrink-0" />
                <span className="truncate">{label}</span>
                <StateGlyph state={state} className={cn("size-3 shrink-0", active && "text-background")} />
              </button>
            </Tip>
          );
        })}
      </div>
      <Tip label="Continue this work with another agent, model, or effort">
        <button
          type="button"
          aria-label="Change agent or model"
          onClick={() => openOrchestrate("handoff", box, session)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-label text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowRightLeftIcon className="size-3.5" />
          <span className="hidden @[560px]:inline">Change agent / model</span>
        </button>
      </Tip>
    </nav>
  );
}
