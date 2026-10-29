import { ArrowDownIcon, ArrowUpIcon, CircleCheckBigIcon, CircleDashedIcon, CircleDotIcon, FolderGit2Icon, GitBranchIcon, GitCommitHorizontalIcon, GitPullRequestArrowIcon, PauseIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useMemo } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Button } from "@/components/ui/button";
import { agentLabel, agentOf, sessionState } from "@/lib/derive";
import { activityStage, type ActivityStage } from "@/lib/activity-stage";
import { openComposer } from "@/lib/composer";
import { forgeOf } from "@/lib/forge";
import { type MergeRequest, mrForBranch } from "@/lib/forge-view";
import { openUrl } from "@/lib/open-url";
import { useForgeView, useForgeViews } from "@/lib/use-forge-view";
import { ago } from "@/lib/format";
import { NONE, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import { PipelineBadge } from "@/views/worktrees/gitlab-panel";
import { openWorktree, type Row } from "@/views/worktrees/use-worktrees";

const columns: { stage: ActivityStage; title: string; description: string; Icon: typeof CircleDashedIcon }[] = [
  { stage: "todo", title: "Todo", description: "Branches waiting for an agent", Icon: CircleDashedIcon },
  { stage: "doing", title: "In progress", description: "Agents or files are active", Icon: CircleDotIcon },
  { stage: "done", title: "Done", description: "Committed and ready to review", Icon: CircleCheckBigIcon },
];

// ActivityBoard is each project's own folder (its main checkout: the branch
// it is on, what changed, what to push or pull), then the tasks, a branch in
// a worktree of its own each, by how far along they are. A GitLab project's
// open merge requests with no task here yet are Todo too: work waiting for
// an agent.
export function ActivityBoard({ rows, onOpen }: { rows: Row[]; onOpen(row: Row): void }) {
  const tasks = rows.filter((r) => !r.main);
  const mains = rows.filter((r) => r.main);
  const gitlab = useMemo(() => mains.filter((r) => forgeOf(r.remote).kind === "gitlab"), [mains]);
  const keys = useMemo(() => gitlab.map((r) => `${r.box}/${r.location}`), [gitlab]);
  const views = useForgeViews(keys);
  const waiting = useMemo(
    () =>
      gitlab.flatMap((p) =>
        (views[`${p.box}/${p.location}`]?.merge_requests ?? [])
          .filter((m) => m.state === "opened" && !rows.some((r) => r.box === p.box && r.location === p.location && r.branch === m.source_branch))
          .map((mr) => ({ project: p, mr })),
      ),
    [gitlab, views, rows],
  );
  return (
    <div className="min-h-full px-page py-4">
      {gitlab.map((p) => (
        <WatchForge key={p.key} box={p.box} location={p.location} />
      ))}
      {mains.length > 0 && (
        <section aria-label="Projects" className="mb-4">
          <h2 className="mb-2 text-label text-muted-foreground">Projects</h2>
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-3">
            {mains.map((row) => (
              <TaskCard key={row.key} row={row} onOpen={() => onOpen(row)} />
            ))}
          </div>
          {tasks.length === 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-4 py-3">
              <p className="min-w-0 flex-1 text-desc text-muted-foreground">
                No tasks yet. A task is a branch in a worktree of its own, with an agent working in it; it moves across the board below as the agent works.
              </p>
              <Button size="sm" onClick={() => openComposer({ box: mains[0].box, location: mains[0].location })}>
                <PlusIcon /> New task
              </Button>
            </div>
          )}
        </section>
      )}
      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-3">
      {columns.map((column) => {
        const inColumn = tasks.filter((r) => stageOf(r) === column.stage);
        const mrs = column.stage === "todo" ? waiting : [];
        return (
          <section key={column.stage} aria-label={column.title} className="min-w-0 rounded-xl border bg-muted/20">
            <header className="flex h-bar items-center gap-2 border-b px-3">
              <column.Icon className={cn("size-4", column.stage === "doing" ? "text-info-foreground" : column.stage === "done" ? "text-success-foreground" : "text-muted-foreground")} />
              <div className="min-w-0 flex-1">
                <h2 className="text-label">{column.title}</h2>
                <p className="truncate text-meta text-muted-foreground">{column.description}</p>
              </div>
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-tag tabular-nums">{inColumn.length + mrs.length}</span>
            </header>
            <div className="space-y-2 p-2">
              {inColumn.map((row) => (
                <TaskCard key={row.key} row={row} onOpen={() => onOpen(row)} />
              ))}
              {mrs.map(({ project, mr }) => (
                <MergeRequestCard key={`${project.key}!${mr.iid}`} project={project} mr={mr} />
              ))}
              {inColumn.length + mrs.length === 0 && <p className="px-2 py-8 text-center text-desc text-muted-foreground">Nothing here</p>}
            </div>
          </section>
        );
      })}
      </div>
    </div>
  );
}

// WatchForge keeps a GitLab project's merge requests current while the
// board is open.
function WatchForge({ box, location }: { box: string; location: string }) {
  useForgeView(box, location);
  return null;
}

// MergeRequestCard is an open merge request on GitLab with no task here:
// Work on it starts one on its branch.
function MergeRequestCard({ project, mr }: { project: Row; mr: MergeRequest }) {
  return (
    <article aria-label={`!${mr.iid} ${mr.title}`} className="rounded-lg border border-dashed bg-background p-3 shadow-xs/5">
      <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
        <ProjectLabel box={project.box} scope={`repo:${project.location}`} />
        <span className="rounded bg-[#fc6d26]/12 px-1.5 py-px text-[#c94f16] dark:text-[#fc8b52]">GitLab</span>
      </span>
      <button type="button" onClick={() => void openUrl(mr.url)} className="mt-1 flex w-full min-w-0 items-start gap-1.5 rounded text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        <GitPullRequestArrowIcon className="mt-0.5 size-3.5 shrink-0 text-success-foreground" />
        <span className="min-w-0 text-body">
          <span className="text-muted-foreground">!{mr.iid}</span> {mr.title}
        </span>
      </button>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
        <GitBranchIcon className="size-3 shrink-0" />
        <span className="truncate font-mono">{mr.source_branch}</span>
        <span className="ml-auto shrink-0">{ago(mr.updated)}</span>
      </div>
      <div className="mt-3 flex min-h-7 items-center gap-1.5 border-t pt-2 text-meta">
        {mr.draft && <span className="rounded border px-1.5 text-tag text-muted-foreground">Draft</span>}
        <PipelineBadge pipeline={mr.pipeline} />
        {mr.author && <span className="truncate text-muted-foreground">{mr.author}</span>}
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => openComposer({ box: project.box, location: project.location, name: mr.url })}>
          <PlayIcon /> Work on it
        </Button>
      </div>
    </article>
  );
}

function stageOf(row: Row): ActivityStage {
  const sessions = useStore.getState().boxes[row.box]?.sessions ?? NONE;
  const stats = useStore.getState().boxes[row.box]?.stats;
  const running = sessions.some((s) => s.dir === row.path && !s.exited && !s.service && ["running", "waiting"].includes(sessionState(s, stats)));
  return activityStage({ paused: row.paused, running, changed: row.changed, untracked: row.untracked, ahead: row.ahead });
}

function TaskCard({ row, onOpen }: { row: Row; onOpen(): void }) {
  const all = useStore((s) => s.boxes[row.box]?.sessions ?? NONE);
  const stats = useStore((s) => s.boxes[row.box]?.stats);
  const sessions = useMemo(() => all.filter((s) => s.dir === row.path && !s.exited && !s.service && agentOf(s)), [all, row.path]);
  const forge = forgeOf(row.remote);
  const files = row.changed + row.untracked;
  // A GitLab branch's merge request, and the pipeline for its head.
  const { view } = useForgeView(row.box, row.location, forge.kind === "gitlab");
  const mr = row.main ? undefined : mrForBranch(view, row.branch);
  return (
    <article className="rounded-lg border bg-background p-3 shadow-xs/5">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
            <ProjectLabel box={row.box} scope={`repo:${row.location}`} />
            {forge.kind === "gitlab" && <span className="rounded bg-[#fc6d26]/12 px-1.5 py-px text-[#c94f16] dark:text-[#fc8b52]">GitLab</span>}
          </span>
          <span className="mt-1 flex items-center gap-1.5">
            {row.main ? <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" /> : <GitBranchIcon className="size-3.5 shrink-0 text-info-foreground" />}
            <span className="truncate font-medium text-body">{row.main ? row.branch || row.name : row.title?.trim() || row.branch || row.name}</span>
            {row.main && <span className="shrink-0 rounded border px-1.5 text-tag text-muted-foreground">main folder</span>}
          </span>
        </button>
        {row.paused && <PauseIcon className="mt-1 size-3.5 text-warning-foreground" aria-label="Paused" />}
      </div>

      {row.last_commit && (
        <button type="button" onClick={onOpen} className="mt-2 flex w-full min-w-0 items-center gap-1.5 rounded text-left text-meta text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <GitCommitHorizontalIcon className="size-3 shrink-0" />
          <span className="truncate">{row.last_commit.subject}</span>
          <span className="ml-auto shrink-0">{ago(row.last_commit.time)}</span>
        </button>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-meta">
        {files > 0 && <span className="rounded bg-warning/12 px-1.5 py-0.5 text-warning-foreground">{files} {files === 1 ? "file" : "files"}</span>}
        {row.published === false && <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">Not pushed</span>}
        {(row.outgoing ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded bg-info/10 px-1.5 py-0.5 text-info-foreground"><ArrowUpIcon className="size-3" />{row.outgoing} to push</span>
        )}
        {(row.incoming ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded bg-warning/12 px-1.5 py-0.5 text-warning-foreground"><ArrowDownIcon className="size-3" />{row.incoming} to pull</span>
        )}
        {row.published === true && (row.outgoing ?? 0) === 0 && (row.incoming ?? 0) === 0 && <span className="rounded bg-success/10 px-1.5 py-0.5 text-success-foreground">Synced</span>}
        {mr && (
          <>
            <button type="button" onClick={() => void openUrl(mr.url)} className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground hover:text-foreground">
              !{mr.iid}
              {mr.state === "merged" ? " merged" : ""}
            </button>
            <PipelineBadge pipeline={mr.pipeline} />
          </>
        )}
      </div>

      <div className="mt-3 flex min-h-7 items-center gap-1 border-t pt-2">
        {sessions.length ? (
          <>
            {sessions.slice(0, 3).map((session) => {
              const agent = agentOf(session)!;
              const state = sessionState(session, stats);
              return <span key={session.name} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-1 text-tag" aria-label={`${agentLabel(agent)} ${state}`}><AgentIcon agent={agent} className="size-3" />{agentLabel(agent)}</span>;
            })}
            {sessions.length > 3 && <span className="text-tag text-muted-foreground">+{sessions.length - 3}</span>}
          </>
        ) : (
          <span className="text-meta text-muted-foreground">No agent active</span>
        )}
        <Button size="xs" variant="ghost" className="ml-auto" onClick={() => openWorktree(row)}>Open</Button>
      </div>
    </article>
  );
}
