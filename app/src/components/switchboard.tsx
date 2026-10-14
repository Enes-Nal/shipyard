import { ArrowRightIcon, FolderGitIcon, Layers3Icon, PencilIcon, PlusIcon, SearchIcon, StarIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { AgentIcon, StateGlyph, stateText } from "@/components/agent-glyph";
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { boxApi, type Conversation } from "@/lib/api";
import { resumeConversation } from "@/lib/actions";
import { agentOf, sessionName, worktreeOf, type SessionState } from "@/lib/derive";
import { ago } from "@/lib/format";
import { useProjects } from "@/lib/project-groups";
import { useStore } from "@/lib/store";
import { setSwitchboardOpen, switchboardActions, useSwitchboard, useSwitchboardOpen } from "@/lib/switchboard";
import { cn } from "@/lib/utils";
import { refOf, openSession, selectWorktree, useWorkspaces, wsKey } from "@/lib/workspaces";
import { worktreeLabel } from "@/lib/worktree-names";
import { useAllSessions } from "@/hooks/use-agent-counts";
import { platformKeys } from "@/lib/platform";

interface BoardItem {
  id: string;
  title: string;
  place: string;
  area: string;
  at: number;
  agent?: string;
  state?: SessionState;
  kind: "conversation" | "worktree";
  open(): void;
}

const date = (s: string | undefined) => s ? Date.parse(s) || 0 : 0;

// The Switchboard gathers work from every box. A live or ended session is
// shown once; a structured conversation without its old session still has a
// card that can resume it. Recently visited worktrees fill in work without
// an agent. Areas are the existing project sections, with personal overrides.
export function Switchboard() {
  const open = useSwitchboardOpen((s) => s.open);
  const choices = useSwitchboard();
  const allSessions = useAllSessions();
  const boxes = useStore((s) => s.boxes);
  const status = useStore((s) => s.status);
  const client = useStore((s) => s.client);
  const spaces = useWorkspaces((s) => s.spaces);
  const { projects, sections } = useProjects();
  const [conversations, setConversations] = useState<Record<string, Conversation[]>>({});
  const [query, setQuery] = useState("");
  const [area, setArea] = useState("All");
  const [addingArea, setAddingArea] = useState(false);
  const [newArea, setNewArea] = useState("");
  const [showAllFocus, setShowAllFocus] = useState(false);
  const conversationBoxes = (status?.boxes ?? []).filter((b) => b.state === "online" && boxes[b.name]?.info?.capabilities?.includes("conversations")).map((b) => b.name).join("|");

  useEffect(() => {
    if (!open || !client) return;
    let live = true;
    for (const box of conversationBoxes.split("|").filter(Boolean)) {
      void boxApi.conversations(client, box, undefined, 200).then((list) => {
        if (live) setConversations((old) => ({ ...old, [box]: list }));
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [open, client, conversationBoxes]);

  useEffect(() => {
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) {
      if (conv.session) switchboardActions.migrate(`session:${box}:${conv.session}`, `conversation:${box}:${conv.id}`);
    }
  }, [conversations]);

  const items = useMemo(() => {
    const out: BoardItem[] = [];
    const conversationBySession = new Map<string, Conversation>();
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) if (conv.session) conversationBySession.set(`${box}:${conv.session}`, conv);
    const projectByLocation = new Map<string, { name: string; area?: string }>();
    for (const p of projects) for (const m of p.members) projectByLocation.set(`${m.box.name}/${m.loc.name}`, { name: p.name, area: p.section });
    const areaOf = (id: string, project?: string) => choices.assigned[id] ?? project ?? "Unsorted";
    const sessionIds = new Set<string>();
    for (const { box, session, state } of allSessions) {
      const agent = agentOf(session);
      if (!agent || session.service) continue;
      const conversation = conversationBySession.get(`${box}:${session.name}`);
      const id = conversation ? `conversation:${box}:${conversation.id}` : `session:${box}:${session.name}`;
      sessionIds.add(`${box}:${session.name}`);
      const found = worktreeOf(boxes[box]?.locations, session);
      const project = found && projectByLocation.get(`${box}/${found.location.name}`);
      out.push({
        id,
        title: sessionName(session, { sessions: boxes[box]?.sessions }),
        place: found ? `${project?.name ?? found.location.name} / ${worktreeLabel(found.worktree)}` : `${box} / Home`,
        area: areaOf(id, project?.area),
        at: date(session.state_since) || date(session.created),
        agent,
        state,
        kind: "conversation",
        open: () => openSession(box, session),
      });
    }
    for (const [box, list] of Object.entries(conversations)) for (const conv of list) {
      if (conv.session && sessionIds.has(`${box}:${conv.session}`)) continue;
      const found = boxes[box]?.locations?.flatMap((l) => (l.worktrees ?? []).map((w) => ({ location: l, worktree: w }))).find((x) => x.worktree.path === conv.dir);
      if (!found) continue;
      const id = `conversation:${box}:${conv.id}`;
      const project = projectByLocation.get(`${box}/${found.location.name}`);
      out.push({
        id,
        title: conv.title || "Untitled conversation",
        place: `${project?.name ?? found.location.name} / ${worktreeLabel(found.worktree)}`,
        area: areaOf(id, project?.area),
        at: date(conv.updated) || date(conv.created),
        agent: conv.agent,
        state: "exited",
        kind: "conversation",
        open: () => {
          selectWorktree(refOf(box, found.location, found.worktree));
          void resumeConversation(box, conv, wsKey(box, conv.dir));
        },
      });
    }
    for (const [key, ws] of Object.entries(spaces)) {
      if (!ws.visitedAt || !ws.ref.location) continue;
      const loc = boxes[ws.ref.box]?.locations?.find((l) => l.name === ws.ref.location);
      const wt = loc?.worktrees?.find((w) => w.path === ws.ref.path);
      if (!loc || !wt) continue;
      const id = `worktree:${key}`;
      if (!choices.focus.includes(id) && allSessions.some((entry) => entry.box === ws.ref.box && entry.session.dir === wt.path && !!agentOf(entry.session))) continue;
      const project = projectByLocation.get(`${ws.ref.box}/${loc.name}`);
      out.push({
        id,
        title: worktreeLabel(wt),
        place: `${project?.name ?? loc.name} / ${ws.ref.box}`,
        area: areaOf(id, project?.area),
        at: ws.visitedAt,
        kind: "worktree",
        open: () => selectWorktree(refOf(ws.ref.box, loc, wt)),
      });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [allSessions, boxes, conversations, spaces, projects, choices.assigned, choices.focus]);

  const areas = useMemo(() => ["All", ...new Set([...sections, ...choices.areas, ...items.map((i) => i.area)].filter((x) => !["all", "unsorted"].includes(x.toLowerCase()))), "Unsorted"], [sections, choices.areas, items]);
  const matching = items.filter((item) => (area === "All" || item.area === area) && `${item.title} ${item.place} ${item.area}`.toLowerCase().includes(query.trim().toLowerCase()));
  const focused = choices.focus.map((id) => matching.find((item) => item.id === id)).filter((item): item is BoardItem => !!item);
  const recent = matching.filter((item) => !choices.focus.includes(item.id)).slice(0, 24);
  const enter = (item: BoardItem) => { setSwitchboardOpen(false); item.open(); };
  const close = () => { setSwitchboardOpen(false); setQuery(""); setArea("All"); setAddingArea(false); };

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) close(); else setSwitchboardOpen(true); }}>
      <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="h-[min(760px,88vh)] max-w-[940px] overflow-hidden border-border/80 bg-background shadow-2xl">
        <div className="flex min-h-0 flex-1 flex-col">
          <header className="border-b bg-sidebar/70 px-6 pt-5 pb-4">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background shadow-sm"><Layers3Icon className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <DialogTitle className="font-heading text-xl leading-tight">Switchboard</DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">Pick up work across your boxes and areas.</DialogDescription>
              </div>
              <Kbd className="mt-1">{platformKeys("⌘⇧K")}</Kbd>
            </div>
            <label className="mt-5 flex h-10 items-center gap-2 rounded-lg border bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
              <input autoFocus aria-label="Search work" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && matching[0]) enter(matching[0]); }} placeholder="Find a conversation or worktree…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
            </label>
            <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5" aria-label="Areas">
              {areas.map((name) => <button key={name} type="button" aria-pressed={area === name} onClick={() => setArea(name)} className={cn("shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors", area === name ? "border-foreground/30 bg-foreground text-background" : "border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground")}>{name}</button>)}
              {addingArea ? (
                <form className="flex shrink-0 items-center gap-1" onSubmit={(e) => { e.preventDefault(); switchboardActions.addArea(newArea); setNewArea(""); setAddingArea(false); }}>
                  <input autoFocus aria-label="Area name" value={newArea} onChange={(e) => setNewArea(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setAddingArea(false); }} className="w-28 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring" />
                  <button type="submit" className="text-xs text-muted-foreground hover:text-foreground">Add</button>
                </form>
              ) : <button type="button" onClick={() => setAddingArea(true)} className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"><PlusIcon className="size-3" /> Area</button>}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-semibold tracking-wide">Focus <span className="ml-1 text-xs font-normal text-muted-foreground">{focused.length}</span></h2>
              {focused.length > 6 ? <button type="button" onClick={() => setShowAllFocus(!showAllFocus)} className="text-xs text-muted-foreground hover:text-foreground">{showAllFocus ? "Show fewer" : `Show all ${focused.length}`}</button> : <span className="text-xs text-muted-foreground">Star work to keep it here</span>}
            </div>
            {focused.length ? <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(showAllFocus ? focused : focused.slice(0, 6)).map((item) => <WorkCard key={item.id} item={item} areas={areas} note={choices.notes[item.id]} focused onOpen={() => enter(item)} />)}</div> : <div className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">{choices.focus.length ? "No focused work matches this view." : "Your focused work will appear here. Star a conversation or worktree below."}</div>}
            <div className="mt-7 mb-2 flex items-baseline justify-between">
              <h2 className="font-heading text-sm font-semibold tracking-wide">Recent work</h2>
              <span className="text-xs text-muted-foreground">{recent.length} shown</span>
            </div>
            {recent.length ? <div className="divide-y rounded-xl border">{recent.map((item) => <WorkRow key={item.id} item={item} areas={areas} note={choices.notes[item.id]} onOpen={() => enter(item)} />)}</div> : <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{query ? "No work matches your search." : "No recent work in this area."}</p>}
          </div>
          <footer className="flex items-center justify-between border-t bg-sidebar/60 px-6 py-2.5 text-xs text-muted-foreground"><span>Areas group work. Focus keeps your current threads close.</span><span>Esc to close</span></footer>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

function WorkMark({ item }: { item: BoardItem }) {
  return <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">{item.kind === "worktree" ? <FolderGitIcon className="size-4 text-muted-foreground" /> : <AgentIcon agent={item.agent} className="size-4" />}</span>;
}

function WorkActions({ item, areas, note, focused }: { item: BoardItem; areas: string[]; note?: string; focused: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const save = () => { switchboardActions.note(item.id, draft); setEditing(false); };
  return <div className="mt-3 flex items-center gap-2 border-t pt-2.5 text-xs">
    {editing ? <form className="flex min-w-0 flex-1 gap-1" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <input autoFocus aria-label={`Pickup note for ${item.title}`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setDraft(note ?? ""); setEditing(false); } }} placeholder="Where did you leave off?" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 outline-none focus:ring-2 focus:ring-ring" />
      <button type="submit" className="rounded-md px-2 hover:bg-accent">Save</button>
    </form> : <button type="button" onClick={() => { setDraft(note ?? ""); setEditing(true); }} className="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground">{note || "Add pickup note…"}</button>}
    <select aria-label={`Area for ${item.title}`} value={item.area} onChange={(e) => switchboardActions.assign(item.id, e.target.value)} className="max-w-28 rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground outline-none hover:bg-accent focus:ring-2 focus:ring-ring">
      {[...new Set([...areas.filter((x) => x !== "All"), item.area])].map((name) => <option key={name} value={name}>{name}</option>)}
    </select>
    <button type="button" aria-label={focused ? `Remove ${item.title} from Focus` : `Add ${item.title} to Focus`} aria-pressed={focused} onClick={() => switchboardActions.toggleFocus(item.id)} className={cn("rounded-md p-1.5 hover:bg-accent", focused ? "text-foreground" : "text-muted-foreground hover:text-foreground")}><StarIcon className={cn("size-3.5", focused && "fill-current")} /></button>
  </div>;
}

function WorkCard({ item, areas, note, focused, onOpen }: { item: BoardItem; areas: string[]; note?: string; focused: boolean; onOpen(): void }) {
  return <article className="group min-w-0 rounded-xl border bg-card p-3.5 shadow-sm transition-colors hover:border-foreground/30">
    <button type="button" onClick={onOpen} className="flex w-full items-start gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <WorkMark item={item} />
      <span className="min-w-0 flex-1"><span className="block truncate font-medium text-sm">{item.title}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.place}</span></span>
      <ArrowRightIcon className="mt-2 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
    <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">{item.state && <StateGlyph state={item.state} />}<span>{item.state ? stateText(item.state) : "Worktree"}</span><span className="ml-auto">{ago(new Date(item.at).toISOString())}</span></div>
    <WorkActions item={item} areas={areas} note={note} focused={focused} />
  </article>;
}

function WorkRow({ item, areas, note, onOpen }: { item: BoardItem; areas: string[]; note?: string; onOpen(): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const save = () => { switchboardActions.note(item.id, draft); setEditing(false); };
  return <article className="group min-w-0 px-3 py-2.5 hover:bg-accent/35">
    <div className="flex items-center gap-3">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"><WorkMark item={item} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.title}</span><span className="block truncate text-xs text-muted-foreground">{note || item.place}</span></span></button>
      {item.state && <StateGlyph state={item.state} />}
      <span className="w-18 shrink-0 text-right text-xs text-muted-foreground">{ago(new Date(item.at).toISOString())}</span>
      <select aria-label={`Area for ${item.title}`} value={item.area} onChange={(e) => switchboardActions.assign(item.id, e.target.value)} className="max-w-23 shrink-0 rounded-md bg-transparent px-1 py-1 text-xs text-muted-foreground outline-none hover:bg-accent focus:ring-2 focus:ring-ring">
        {[...new Set([...areas.filter((x) => x !== "All"), item.area])].map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <button type="button" aria-label={`${note ? "Edit" : "Add"} pickup note for ${item.title}`} onClick={() => { setDraft(note ?? ""); setEditing(true); }} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><PencilIcon className="size-3.5" /></button>
      <button type="button" aria-label={`Add ${item.title} to Focus`} onClick={() => switchboardActions.toggleFocus(item.id)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><StarIcon className="size-3.5" /></button>
    </div>
    {editing && <form className="ml-11 mt-2 flex gap-1" onSubmit={(e) => { e.preventDefault(); save(); }}><input autoFocus aria-label={`Pickup note for ${item.title}`} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }} placeholder="Where did you leave off?" className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring" /><button type="submit" className="rounded-md px-2 text-xs hover:bg-accent">Save</button></form>}
  </article>;
}
