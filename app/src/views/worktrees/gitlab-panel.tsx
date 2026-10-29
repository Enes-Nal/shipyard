import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  CopyIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  GitPullRequestArrowIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { AgentIcon } from "@/components/agent-glyph";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { openComposer } from "@/lib/composer";
import { agentLabel, agentOf } from "@/lib/derive";
import { ago } from "@/lib/format";
import { type Attributed, defaultPipeline, type ForgePipeline, type ForgeView, type MergeRequest, mrForBranch, type PipelineTone, pipelineTone, problemCopy, timeline, toneLabel } from "@/lib/forge-view";
import { openUrl } from "@/lib/open-url";
import { useIsWslBox } from "@/lib/local-box";
import { NONE, useStore } from "@/lib/store";
import { refreshForge, useForgeView } from "@/lib/use-forge-view";
import { cn } from "@/lib/utils";
import { type Commit, worktreesApi } from "@/lib/worktrees";
import { ProjectLabel } from "@/views/automations/flows/project-label";
import { openWorktree, type Row } from "@/views/worktrees/use-worktrees";

// GitLabPanel is each project as its GitLab sees it: merge requests with
// their pipelines and the agents behind them, what the agents committed,
// the latest pipelines, and origin's branches. GitLab is asked by the box,
// through glab; a project elsewhere still has its branches and timeline.
export function GitLabPanel({ rows }: { rows: Row[] }) {
  const projects = useMemo(() => {
    const seen = new Map<string, { box: string; location: string; rows: Row[] }>();
    for (const r of rows) {
      const k = `${r.box}/${r.location}`;
      if (!seen.has(k)) seen.set(k, { box: r.box, location: r.location, rows: [] });
      seen.get(k)!.rows.push(r);
    }
    return [...seen.values()];
  }, [rows]);
  return (
    <div className="space-y-6 px-page py-4">
      {projects.map((p) => (
        <ProjectForge key={`${p.box}/${p.location}`} box={p.box} location={p.location} rows={p.rows} />
      ))}
    </div>
  );
}

// agentsAt are the agents that worked in a folder, in the order they began.
function useAgentsAt(box: string) {
  const sessions = useStore((s) => s.boxes[box]?.sessions ?? NONE);
  return useMemo(() => {
    const by = new Map<string, string[]>();
    for (const s of [...sessions].sort((a, b) => (a.created ?? "").localeCompare(b.created ?? ""))) {
      const agent = agentOf(s);
      if (!agent || !s.dir) continue;
      const list = by.get(s.dir) ?? [];
      if (!list.includes(agent)) list.push(agent);
      by.set(s.dir, list);
    }
    return (dir?: string) => (dir ? (by.get(dir) ?? []) : []);
  }, [sessions]);
}

function ProjectForge({ box, location, rows }: { box: string; location: string; rows: Row[] }) {
  const { view, error, loading } = useForgeView(box, location);
  const agentsAt = useAgentsAt(box);
  const tasks = rows.filter((r) => !r.main);
  const taskFor = (branch: string) => tasks.find((r) => r.branch === branch) ?? rows.find((r) => r.branch === branch);
  const wsl = useIsWslBox(box);
  const problem = view && problemCopy(view, box, wsl);
  const main = defaultPipeline(view);
  return (
    <section aria-label={`${location} on GitLab`} className="min-w-0">
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <ProjectLabel box={box} scope={`repo:${location}`} />
        {view?.project && (
          <button type="button" onClick={() => void openUrl(view.project!.url)} className="inline-flex items-center gap-1 font-mono text-desc text-muted-foreground hover:text-foreground">
            {view.project.path}
            <ExternalLinkIcon className="size-3" />
          </button>
        )}
        {main && (
          <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground">
            {view?.project?.default_branch} <PipelineBadge pipeline={main} />
          </span>
        )}
        <span className="ml-auto flex items-center gap-2 text-meta text-muted-foreground">
          {view && <span>Updated {ago(view.fetched)}</span>}
          <Button size="xs" variant="ghost" aria-label={`Refresh ${location}`} disabled={loading} onClick={() => refreshForge(box, location)}>
            {loading ? <LoaderIcon className="animate-spin" /> : <RefreshCwIcon />}
            Refresh
          </Button>
        </span>
      </header>

      {error && <Notice tone="warning" title="Couldn't read this project's GitLab" text={error} />}
      {problem && <Notice tone="warning" title={problem.title} text={problem.text} command={problem.command} />}
      {view && view.kind !== "gitlab" && (
        <Notice
          tone="info"
          title={view.host ? `${location} isn't on GitLab` : `${location} has no remote`}
          text={view.host ? `Its origin is ${view.host}. Merge requests and pipelines are for GitLab projects; its branches and what agents committed are below.` : "Its branches and what agents committed are below."}
        />
      )}
      {!view && loading && <p className="flex items-center gap-2 py-6 text-desc text-muted-foreground"><LoaderIcon className="size-3.5 animate-spin" /> Asking GitLab…</p>}

      {view && (
        <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-2">
          {view.kind === "gitlab" && !view.problem && (
            <Card title="Merge requests" count={view.merge_requests.filter((m) => m.state === "opened").length}>
              <MergeRequests box={box} location={location} view={view} taskFor={taskFor} agentsAt={agentsAt} />
            </Card>
          )}
          <Card title="What agents committed">
            <AgentTimeline box={box} location={location} tasks={tasks} agentsAt={agentsAt} />
          </Card>
          {view.kind === "gitlab" && !view.problem && (
            <Card title="Pipelines" count={view.pipelines.length}>
              <Pipelines pipelines={view.pipelines} />
            </Card>
          )}
          <Card title="Branches on origin" count={view.branches.length}>
            <Branches box={box} location={location} view={view} taskFor={taskFor} agentsAt={agentsAt} />
          </Card>
        </div>
      )}
    </section>
  );
}

function Card({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0 rounded-xl border bg-muted/20">
      <header className="flex h-bar-pane items-center gap-2 border-b px-3">
        <h3 className="text-label">{title}</h3>
        {count !== undefined && <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-tag tabular-nums">{count}</span>}
      </header>
      <div className="p-1.5">{children}</div>
    </section>
  );
}

function Notice({ tone, title, text, command }: { tone: "warning" | "info"; title: string; text: string; command?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role={tone === "warning" ? "alert" : undefined} className={cn("mb-3 rounded-xl border px-4 py-3", tone === "warning" ? "border-warning/40 bg-warning/6" : "bg-muted/20")}>
      <p className="flex items-center gap-2 text-label">
        {tone === "warning" && <TriangleAlertIcon className="size-4 shrink-0 text-warning-foreground" />}
        {title}
      </p>
      <p className="mt-1 text-desc text-muted-foreground">{text}</p>
      {command && (
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 truncate rounded-md bg-muted px-2 py-1 font-mono text-desc">{command}</code>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void navigator.clipboard?.writeText(command).then(
                () => setCopied(true),
                () => {},
              )
            }
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </div>
  );
}

const toneIcon: Record<PipelineTone, typeof CircleCheckIcon> = { passed: CircleCheckIcon, failed: CircleXIcon, running: CircleDotIcon, waiting: CircleDashedIcon, other: CircleDashedIcon };
const toneClass: Record<PipelineTone, string> = {
  passed: "bg-success/10 text-success-foreground",
  failed: "bg-destructive/10 text-destructive-foreground",
  running: "bg-info/10 text-info-foreground",
  waiting: "bg-warning/12 text-warning-foreground",
  other: "bg-muted text-muted-foreground",
};

export function PipelineBadge({ pipeline }: { pipeline?: ForgePipeline }) {
  if (!pipeline) return <span className="rounded bg-muted px-1.5 py-0.5 text-tag text-muted-foreground">No pipeline</span>;
  const tone = pipelineTone(pipeline.status);
  const Icon = toneIcon[tone];
  return (
    <Tip label={`Pipeline #${pipeline.id}: ${pipeline.status}, ${ago(pipeline.updated)}`}>
      <button type="button" onClick={() => void openUrl(pipeline.url)} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-tag", toneClass[tone])}>
        <Icon className={cn("size-3", tone === "running" && "animate-pulse")} />
        {toneLabel[tone]}
      </button>
    </Tip>
  );
}

function Agents({ agents }: { agents: string[] }) {
  if (!agents.length) return null;
  return (
    <span className="inline-flex items-center gap-1">
      {agents.map((a) => (
        <span key={a} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-tag" aria-label={`By ${agentLabel(a)}`}>
          <AgentIcon agent={a} className="size-3" />
          {agentLabel(a)}
        </span>
      ))}
    </span>
  );
}

type TaskFor = (branch: string) => Row | undefined;
type AgentsAt = (dir?: string) => string[];

function MergeRequests({ box, location, view, taskFor, agentsAt }: { box: string; location: string; view: ForgeView; taskFor: TaskFor; agentsAt: AgentsAt }) {
  const open = view.merge_requests.filter((m) => m.state === "opened");
  const merged = view.merge_requests.filter((m) => m.state === "merged").slice(0, 5);
  if (!open.length && !merged.length) return <Empty text="No merge requests." />;
  return (
    <ul className="space-y-1">
      {[...open, ...merged].map((mr) => (
        <MergeRequestRow key={mr.iid} box={box} location={location} mr={mr} task={taskFor(mr.source_branch)} agentsAt={agentsAt} />
      ))}
    </ul>
  );
}

function MergeRequestRow({ box, location, mr, task, agentsAt }: { box: string; location: string; mr: MergeRequest; task?: Row; agentsAt: AgentsAt }) {
  const merged = mr.state === "merged";
  return (
    <li aria-label={`!${mr.iid} ${mr.title}`} className="rounded-lg px-2.5 py-2 hover:bg-accent/40">
      <div className="flex items-start gap-2">
        {merged ? <GitMergeIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <GitPullRequestArrowIcon className="mt-0.5 size-4 shrink-0 text-success-foreground" />}
        <div className="min-w-0 flex-1">
          <button type="button" onClick={() => void openUrl(mr.url)} className="block max-w-full truncate text-left text-body hover:underline">
            <span className="text-muted-foreground">!{mr.iid}</span> {mr.title}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
            {mr.draft && <span className="rounded border px-1.5 text-tag">Draft</span>}
            {merged && <span className="rounded bg-muted px-1.5 text-tag">Merged</span>}
            <span className="font-mono">
              {mr.source_branch} → {mr.target_branch}
            </span>
            {mr.author && <span>· {mr.author}</span>}
            <span>· {ago(mr.updated)}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <PipelineBadge pipeline={mr.pipeline} />
            <Agents agents={agentsAt(task?.path)} />
          </div>
        </div>
        {!merged &&
          (task && !task.main ? (
            <Button size="xs" variant="outline" onClick={() => openWorktree(task)}>
              Open task
            </Button>
          ) : (
            <Tip label="Start a task on this merge request's branch, with an agent">
              <Button size="xs" variant="outline" onClick={() => openComposer({ box, location, name: mr.url })}>
                <PlayIcon /> Work on it
              </Button>
            </Tip>
          ))}
      </div>
    </li>
  );
}

function Pipelines({ pipelines }: { pipelines: ForgePipeline[] }) {
  if (!pipelines.length) return <Empty text="No pipelines yet." />;
  return (
    <ul className="space-y-0.5">
      {pipelines.slice(0, 10).map((p) => (
        <li key={p.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-meta hover:bg-accent/40">
          <PipelineBadge pipeline={p} />
          <span className="min-w-0 truncate font-mono text-foreground">{p.ref.replace(/^refs\/merge-requests\/(\d+)\/head$/, "!$1")}</span>
          <span className="font-mono text-muted-foreground">{p.sha.slice(0, 7)}</span>
          <span className="ml-auto shrink-0 text-muted-foreground">{ago(p.updated)}</span>
        </li>
      ))}
    </ul>
  );
}

function Branches({ box, location, view, taskFor, agentsAt }: { box: string; location: string; view: ForgeView; taskFor: TaskFor; agentsAt: AgentsAt }) {
  if (!view.branches.length) return <Empty text="No branches on origin. Fetching needs the box to reach it." />;
  return (
    <ul className="space-y-0.5">
      {view.branches.map((b) => {
        const task = taskFor(b.name);
        const mr = mrForBranch(view, b.name);
        return (
          <li key={b.name} aria-label={`Branch ${b.name}`} className="rounded-lg px-2.5 py-1.5 hover:bg-accent/40">
            <div className="flex items-center gap-2">
              <GitBranchIcon className={cn("size-3.5 shrink-0", b.default ? "text-muted-foreground" : "text-info-foreground")} />
              <span className="min-w-0 truncate font-mono text-desc">{b.name}</span>
              {b.default && <span className="rounded border px-1.5 text-tag text-muted-foreground">default</span>}
              {mr && (
                <button type="button" onClick={() => void openUrl(mr.url)} className="rounded bg-muted px-1.5 text-tag text-muted-foreground hover:text-foreground">
                  !{mr.iid}
                </button>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-tag">
                {b.ahead > 0 && (
                  <Tip label={`${b.ahead} ahead of ${view.project?.default_branch ?? "the default branch"}`}>
                    <span className="inline-flex items-center gap-0.5 text-info-foreground"><ArrowUpIcon className="size-3" />{b.ahead}</span>
                  </Tip>
                )}
                {b.behind > 0 && (
                  <Tip label={`${b.behind} behind ${view.project?.default_branch ?? "the default branch"}`}>
                    <span className="inline-flex items-center gap-0.5 text-warning-foreground"><ArrowDownIcon className="size-3" />{b.behind}</span>
                  </Tip>
                )}
              </span>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 pl-5 text-meta text-muted-foreground">
              {b.last_commit && (
                <>
                  <span className="min-w-0 truncate">{b.last_commit.subject}</span>
                  <span className="shrink-0">· {b.last_commit.author} · {ago(b.last_commit.time)}</span>
                </>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <Agents agents={agentsAt(task?.path)} />
                {task && !task.main ? (
                  <Button size="xs" variant="ghost" onClick={() => openWorktree(task)}>
                    Open
                  </Button>
                ) : (
                  !b.default && (
                    <Button size="xs" variant="ghost" onClick={() => openComposer({ box, location, name: b.name })}>
                      Work on it
                    </Button>
                  )
                )}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// AgentTimeline is what each task's agents committed that its base doesn't
// have yet, newest first, across the project's tasks.
function AgentTimeline({ box, location, tasks, agentsAt }: { box: string; location: string; tasks: Row[]; agentsAt: AgentsAt }) {
  const client = useStore((s) => s.client);
  const [items, setItems] = useState<Attributed<Commit & { task: Row }>[]>();
  // Read again when a task gets a new commit.
  const stamp = tasks.map((t) => `${t.name}:${t.last_commit?.sha ?? ""}`).join(",");
  useEffect(() => {
    if (!client) return;
    let live = true;
    Promise.all(
      tasks.map((t) =>
        worktreesApi.log(client, box, location, t.name, 15).then(
          (l) => ({ commits: (l.commits ?? []).filter((c) => !c.on_base).map((c) => ({ ...c, task: t })), agents: agentsAt(t.path) }),
          () => ({ commits: [], agents: [] }),
        ),
      ),
    ).then((per) => live && setItems(timeline(per, 20)));
    return () => {
      live = false;
    };
    // stamp stands for tasks' commits; agentsAt for their sessions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, box, location, stamp, agentsAt]);
  if (!tasks.length) return <Empty text="No tasks yet. What an agent commits in a task shows here, with who made it." />;
  if (!items) return <p className="flex items-center gap-2 px-2.5 py-3 text-desc text-muted-foreground"><LoaderIcon className="size-3.5 animate-spin" /> Reading commits…</p>;
  if (!items.length) return <Empty text="No commits in this project's tasks yet." />;
  return (
    <ol className="relative space-y-0.5">
      {items.map(({ item: c, agents }) => (
        <li key={c.sha} className="flex items-start gap-2 rounded-lg px-2.5 py-1.5 hover:bg-accent/40">
          <GitCommitHorizontalIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => openWorktree(c.task)} className="block max-w-full truncate text-left text-desc hover:underline">
              {c.subject}
            </button>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-muted-foreground">
              <span className="font-mono">{c.short}</span>
              <span className="font-mono">{c.task.branch}</span>
              <span>· {ago(c.time)}</span>
              {agents.length ? <Agents agents={agents} /> : <span>· {c.author}</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-2.5 py-4 text-center text-desc text-muted-foreground">{text}</p>;
}
