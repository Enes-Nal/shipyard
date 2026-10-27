import { ArrowDownIcon, ArrowUpIcon, GitBranchIcon, GitCommitHorizontalIcon, PanelsTopLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Tip } from "@/components/tip";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { type WorktreeStatus, worktreesApi } from "@/lib/worktrees";
import { forgeOf } from "@/lib/forge";

// GitWorkstream is the worktree's live footprint beside its conversation:
// commits, uncommitted files and drift from the base, refreshed while the
// pane is visible. Several agents can share a worktree, so it deliberately
// says "worktree" instead of claiming a file for the wrong agent.
export function GitWorkstream({ box, dir, visible }: { box: string; dir?: string; visible: boolean }) {
  const client = useStore((s) => s.client);
  const [status, setStatus] = useState<WorktreeStatus>();
  useEffect(() => {
    if (!client || !dir || !visible) {
      setStatus(undefined);
      return;
    }
    setStatus(undefined);
    let alive = true;
    const read = () => {
      if (document.hidden) return;
      worktreesApi.list(client, box).then(
        (all) => alive && setStatus(all.find((w) => w.path === dir)),
        () => alive && setStatus(undefined),
      );
    };
    read();
    const timer = window.setInterval(read, 10_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [client, box, dir, visible]);
  if (!status) return null;

  const files = status.changed + status.untracked;
  const clean = files === 0;
  const dots = Math.min(status.ahead, 4);
  const branch = status.branch || status.name;
  const forge = forgeOf(status.remote);
  return (
    <div className="relative z-10 flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/24 px-edge text-meta">
      <Tip label={`Branch ${branch}`}>
        <span className="flex min-w-0 max-w-48 items-center gap-1.5 font-mono text-foreground">
          <GitBranchIcon className="size-3.5 shrink-0 text-info-foreground" />
          <span className="truncate">{branch}</span>
        </span>
      </Tip>
      {forge.kind === "gitlab" && <span className="shrink-0 rounded bg-[#fc6d26]/12 px-1.5 py-px text-tag text-[#c94f16] dark:text-[#fc8b52]">GitLab</span>}
      <div className="flex min-w-16 flex-1 items-center" aria-label={`${status.ahead} commits ahead and ${files} changed files`}>
        <span className="size-2 rounded-full border border-muted-foreground/60 bg-background" />
        <span className="h-px min-w-2 flex-1 bg-border" />
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className="contents">
            <span className="size-2 rounded-full bg-info" />
            <span className="h-px min-w-2 flex-1 bg-info/45" />
          </span>
        ))}
        {status.ahead > dots && <span className="mr-1 font-mono text-tag text-info-foreground">+{status.ahead - dots}</span>}
        <span className={cn("size-2.5 rotate-45 rounded-[2px] border", clean ? "border-success/60 bg-success/15" : "border-warning/70 bg-warning/30")} />
      </div>
      <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
        {!clean && <span>{files} {files === 1 ? "file" : "files"}</span>}
        {clean && <span className="text-success-foreground">Clean</span>}
        {status.published === false && <span>Not pushed</span>}
        {(status.outgoing ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5" aria-label={`${status.outgoing ?? 0} commits to push`}>
            <ArrowUpIcon className="size-3" />{status.outgoing}
          </span>
        )}
        {(status.incoming ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5" aria-label={`${status.incoming ?? 0} commits to pull`}>
            <ArrowDownIcon className="size-3" />{status.incoming}
          </span>
        )}
        {status.last_commit && (
          <Tip label={status.last_commit.subject}>
            <span className="hidden max-w-44 items-center gap-1 font-mono text-tag @[700px]:inline-flex">
              <GitCommitHorizontalIcon className="size-3" />
              <span>{status.last_commit.short}</span>
            </span>
          </Tip>
        )}
      </div>
      <Tip label="Open the full worktree and commit graph">
        <button
          type="button"
          onClick={() => useStore.getState().setView({ kind: "worktrees" })}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Open worktree Git graph"
        >
          <PanelsTopLeftIcon className="size-3.5" />
        </button>
      </Tip>
    </div>
  );
}
