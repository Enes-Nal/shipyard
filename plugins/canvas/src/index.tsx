import { definePlugin, useBoxes, useCurrentWorktree, useEvent, useFleetSessions, useStorage, type CurrentWorktree, type ScreenProps, type Service, type Session } from "@berth/plugin";
import { AgentIcon, BrowserSurface, Button, HelperSurface, Icon, Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger, SessionSurface, ViewHeader } from "@berth/plugin/ui";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

const MIN_ZOOM = 0.55;
const MAX_ZOOM = 1.5;

type BaseNode = { id: string; box: string; source?: Worktree; x: number; y: number; w: number; h: number };
type SessionNode = BaseNode & { kind: "session"; session: string; agent?: string; mode: "chat" | "terminal" };
type PreviewNode = BaseNode & { kind: "preview"; port: number };
type HelperNode = BaseNode & { kind: "helper"; session: string; helper: string; name: string };
type Node = SessionNode | PreviewNode | HelperNode;
type Link = { from: string; to: string };
type Board = { nodes: Node[]; links: Link[] };
type Worktree = CurrentWorktree;
type Gesture = { id: string; kind: "move" | "resize"; x: number; y: number; node: Node };

const keyOf = (w: Worktree) => `${w.box}:${w.path}`;
const sessionId = (box: string, session: string) => `session:${box}:${session}`;
const previewId = (box: string, port: number) => `preview:${box}:${port}`;
const helperId = (box: string, session: string, helper: string) => `helper:${box}:${session}:${helper}`;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
type CanvasHelper = { id: string; name: string; state: "running" | "finished" };
const belongsTo = (path: string, w: Worktree) => path === w.path || path.startsWith(`${w.path}/`);

function linkGeometry(from: Node, to: Node) {
  const overlap = from.x < to.x + to.w && to.x < from.x + from.w;
  if (overlap && to.y >= from.y + from.h - 50) {
    const x1 = from.x + from.w / 2, y1 = from.y + from.h;
    const x2 = to.x + to.w / 2, y2 = to.y;
    const mid = (y1 + y2) / 2;
    return { x: (x1 + x2) / 2, y: mid, path: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}` };
  }
  const x1 = from.x + from.w, y1 = from.y + from.h / 2;
  const x2 = to.x, y2 = to.y + to.h / 2;
  const mid = (x1 + x2) / 2;
  return { x: mid, y: (y1 + y2) / 2, path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` };
}

export default definePlugin((berth) => {
  berth.addScreen({ id: "canvas", title: "Canvas", description: "Live work, together in one place.", layout: "fill", Component: CanvasScreen });
  berth.addSidebarItem({ id: "canvas", title: "Canvas", icon: "Workflow", screen: "canvas" });
  berth.addCommand({ id: "canvas", title: "Open canvas", group: "Workspace", run: () => berth.openScreen("canvas") });
});

function CanvasScreen({ berth }: ScreenProps) {
  const boxes = useBoxes();
  const here = useCurrentWorktree();
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [stamp, setStamp] = useState(0);
  const [savedKey, setSavedKey] = useStorage("selected-worktree", "");
  const [sourceKey, setSourceKey] = useState("");
  const [boards, setBoards] = useStorage<Record<string, Board>>("boards", {});
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [linkFrom, setLinkFrom] = useState<string>();
  const [selectedNode, setSelectedNode] = useState<string>();
  const [transient, setTransient] = useState<Partial<Node> & { id: string }>();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const panGesture = useRef<{ x: number; y: number; startX: number; startY: number } | undefined>(undefined);
  const [services, setServices] = useState<Record<string, Service[]>>({});
  const [helpers, setHelpers] = useState<Record<string, CanvasHelper[]>>({});
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const online = boxes.filter((b) => b.state === "online").map((b) => b.name).join("|");

  useEvent("worktree.*", () => setStamp((n) => n + 1));
  useEvent("service.*", () => setStamp((n) => n + 1));
  useEffect(() => {
    let live = true;
    const names = online ? online.split("|") : [];
    void Promise.all(names.map(async (box) => {
      const locations = await berth.api.locations(box).catch(() => []);
      return locations.flatMap((location) => (location.worktrees ?? []).map((wt) => ({ box, location: location.name, worktree: wt.name, path: wt.path, main: wt.main })));
    })).then((groups) => {
      if (live) setWorktrees(groups.flat().sort((a, b) => `${a.location}/${a.worktree}`.localeCompare(`${b.location}/${b.worktree}`)));
    });
    return () => { live = false; };
  }, [berth, online, stamp]);

  const allWorktrees = useMemo(() => here && !worktrees.some((w) => keyOf(w) === keyOf(here)) ? [here, ...worktrees] : worktrees, [here, worktrees]);
  const boardKey = allWorktrees.some((w) => keyOf(w) === savedKey) ? savedKey : here && allWorktrees.some((w) => keyOf(w) === keyOf(here)) ? keyOf(here) : allWorktrees[0] ? keyOf(allWorktrees[0]) : "";
  const worktree = allWorktrees.find((w) => keyOf(w) === boardKey);
  const sourceWorktree = allWorktrees.find((w) => keyOf(w) === sourceKey) ?? worktree;
  const fleetSessions = useFleetSessions();
  const ownedSessions = useMemo(() => (fleetSessions[worktree?.box ?? ""] ?? []).filter((s) => worktree && belongsTo(s.dir, worktree)), [fleetSessions, worktree]);
  const sourceSessions = useMemo(() => (fleetSessions[sourceWorktree?.box ?? ""] ?? []).filter((s) => sourceWorktree && belongsTo(s.dir, sourceWorktree)), [fleetSessions, sourceWorktree]);
  const ownedServices = (services[worktree?.box ?? ""] ?? []).filter((s) => worktree && (s.path === worktree.path || s.location === worktree.location && s.worktree === worktree.worktree));
  const sourceServices = (services[sourceWorktree?.box ?? ""] ?? []).filter((s) => sourceWorktree && (s.path === sourceWorktree.path || s.location === sourceWorktree.location && s.worktree === sourceWorktree.worktree));

  useEffect(() => {
    let live = true;
    const names = online ? online.split("|") : [];
    const load = () => void Promise.all(names.map(async (box) => [box, await berth.api.services(box).catch(() => [])] as const)).then((pairs) => {
      if (live) setServices(Object.fromEntries(pairs));
    });
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [berth, online, stamp]);

  const sourceAgentNames = sourceSessions.filter((s) => !!s.agent).map((s) => s.name).join("|");
  useEffect(() => {
    if (!sourceWorktree) { setHelpers({}); return; }
    let live = true;
    const names = sourceAgentNames ? sourceAgentNames.split("|") : [];
    const load = () => void Promise.all(names.map(async (session) => {
      const result = await berth.api.request<{ helpers?: CanvasHelper[] }>(sourceWorktree.box, "GET", `sessions/${encodeURIComponent(session)}/subagents`).catch(() => ({ helpers: [] }));
      return [session, result.helpers ?? []] as const;
    })).then((pairs) => { if (live) setHelpers(Object.fromEntries(pairs)); });
    load();
    const timer = window.setInterval(() => { if (!document.hidden) load(); }, 5_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [berth, sourceWorktree?.box, sourceAgentNames]);

  const suggested = useMemo<Board>(() => {
    const first = [...ownedSessions].sort((a, b) => Number(!!b.agent) - Number(!!a.agent) || b.created.localeCompare(a.created)).slice(0, 3);
    const nodes: Node[] = first.map((s, i) => ({ id: sessionId(worktree!.box, s.name), kind: "session", box: worktree!.box, source: worktree, session: s.name, agent: s.agent, mode: s.agent ? "chat" : "terminal", x: i === 0 ? 150 : i === 1 ? 680 : 185, y: i === 0 ? 155 : i === 1 ? 130 : 655, w: i === 1 ? 455 : 480, h: i === 0 ? 440 : i === 1 ? 285 : 300 }));
    const firstService = ownedServices[0];
    if (firstService && worktree) nodes.push({ id: previewId(worktree.box, firstService.port), kind: "preview", box: worktree.box, source: worktree, port: firstService.port, x: 735, y: 455, w: 545, h: 320 });
    return { nodes, links: [] };
  }, [ownedSessions, services, worktree]);
  const board = boards[boardKey] ?? suggested;
  const boardRef = useRef(board);
  boardRef.current = board;
  const save = (next: Board) => { setBoards({ ...boards, [boardKey]: next }); };
  const replace = (id: string, patch: Partial<Node>) => save({ ...boardRef.current, nodes: boardRef.current.nodes.map((n) => n.id === id ? { ...n, ...patch } as Node : n) });
  const remove = (id: string) => {
    save({ nodes: boardRef.current.nodes.filter((n) => n.id !== id), links: boardRef.current.links.filter((l) => l.from !== id && l.to !== id) });
    if (selectedNode === id) setSelectedNode(undefined);
    if (linkFrom === id) setLinkFrom(undefined);
  };
  const add = (node: Node) => {
    if (boardRef.current.nodes.some((n) => n.id === node.id)) { setSelectedNode(node.id); return; }
    const centerX = (viewport.current?.clientWidth ?? 1100) / 2;
    const centerY = (viewport.current?.clientHeight ?? 700) / 2;
    const offset = boardRef.current.nodes.length % 4 * 34;
    save({ ...boardRef.current, nodes: [...boardRef.current.nodes, { ...node, x: Math.round((centerX - pan.x) / zoom - node.w / 2 + offset), y: Math.round((centerY - pan.y) / zoom - node.h / 2 + offset) }] });
    setSelectedNode(node.id);
  };
  const addSession = (s: Session, source: Worktree) => add({ id: sessionId(source.box, s.name), kind: "session", box: source.box, source, session: s.name, agent: s.agent, mode: s.agent ? "chat" : "terminal", x: 0, y: 0, w: 480, h: 460 });
  const addPreview = (svc: Service, source: Worktree) => add({ id: previewId(source.box, svc.port), kind: "preview", box: source.box, source, port: svc.port, x: 0, y: 0, w: 570, h: 385 });
  const addHelper = (s: Session, helper: CanvasHelper, source: Worktree) => add({ id: helperId(source.box, s.name, helper.id), kind: "helper", box: source.box, source, session: s.name, helper: helper.id, name: helper.name, x: 0, y: 0, w: 480, h: 460 });
  const createTerminal = async () => {
    if (!sourceWorktree || creating) return;
    setCreating(true);
    setCreateError("");
    try { addSession(await berth.api.startSession(sourceWorktree), sourceWorktree); }
    catch (err) { setCreateError(err instanceof Error ? err.message : String(err)); }
    finally { setCreating(false); }
  };

  useEffect(() => { setLinkFrom(undefined); setSelectedNode(undefined); setPan({ x: 0, y: 0 }); setZoom(1); setSourceKey(boardKey); }, [boardKey]);
  const begin = (e: ReactPointerEvent<HTMLElement>, node: Node, kind: Gesture["kind"]) => {
    if (e.button !== 0 || linkFrom || (e.target as HTMLElement).closest("button")) return;
    gesture.current = { id: node.id, kind, x: e.clientX, y: e.clientY, node };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedNode(node.id);
    e.preventDefault();
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const g = gesture.current;
    if (!g) return;
    const dx = (e.clientX - g.x) / zoom;
    const dy = (e.clientY - g.y) / zoom;
    setTransient(g.kind === "move"
      ? { id: g.id, x: Math.round(g.node.x + dx), y: Math.round(g.node.y + dy) }
      : { id: g.id, w: clamp(Math.round(g.node.w + dx), 340, 1100), h: clamp(Math.round(g.node.h + dy), 250, 850) });
  };
  const end = () => {
    if (gesture.current && transient) replace(gesture.current.id, transient);
    gesture.current = undefined;
    setTransient(undefined);
  };
  const clickNode = (id: string) => {
    if (linkFrom && linkFrom !== id) {
      if (!board.links.some((l) => l.from === linkFrom && l.to === id)) save({ ...board, links: [...board.links, { from: linkFrom, to: id }] });
      setLinkFrom(undefined);
    }
    setSelectedNode(id);
  };
  const shown = board.nodes.map((n) => n.id === transient?.id ? { ...n, ...transient } as Node : n);
  const byId = new Map(shown.map((n) => [n.id, n]));
  const zoomTo = (next: number) => {
    const value = clamp(Math.round(next * 100) / 100, MIN_ZOOM, MAX_ZOOM);
    const cx = (viewport.current?.clientWidth ?? 0) / 2;
    const cy = (viewport.current?.clientHeight ?? 0) / 2;
    setPan((p) => ({ x: cx - (cx - p.x) * value / zoom, y: cy - (cy - p.y) * value / zoom }));
    setZoom(value);
  };
  const startPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    panGesture.current = { x: e.clientX, y: e.clientY, startX: pan.x, startY: pan.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSelectedNode(undefined);
  };
  const movePan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = panGesture.current;
    if (g) setPan({ x: g.startX + e.clientX - g.x, y: g.startY + e.clientY - g.y });
  };

  return <div className="flex h-full min-h-0 flex-col bg-background">
    <ViewHeader title="Canvas" description={worktree ? `${worktree.location} / ${worktree.worktree} · live spatial workspace` : "Arrange live chats, terminals and previews."} actions={worktree && <span className="text-xs text-muted-foreground">{board.nodes.length} {board.nodes.length === 1 ? "node" : "nodes"}</span>} />
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-card/70 px-4">
      <Icon name="Workflow" className="size-4 text-primary" />
      <select aria-label="Canvas worktree" className="max-w-64 min-w-36 rounded-md border bg-background px-2 py-1.5 text-xs font-medium text-foreground" value={boardKey} onChange={(e) => setSavedKey(e.target.value)}>
        {allWorktrees.map((w) => <option key={keyOf(w)} value={keyOf(w)}>{w.location} / {w.worktree} · {w.box}</option>)}
      </select>
      {worktree && <><span className="text-xs text-muted-foreground">Add from</span><select aria-label="Source worktree" className="max-w-64 min-w-36 rounded-md border bg-background px-2 py-1.5 text-xs text-foreground" value={sourceWorktree ? keyOf(sourceWorktree) : ""} onChange={(e) => setSourceKey(e.target.value)}>
        {allWorktrees.map((w) => <option key={keyOf(w)} value={keyOf(w)}>{w.location} / {w.worktree} · {w.box}</option>)}
      </select></>}
      <div className="flex-1" />
      {createError && <span role="alert" className="max-w-60 truncate text-xs text-destructive">{createError}</span>}
      {linkFrom && <span className="text-xs text-primary">Choose a node for a visual link · <button className="underline" onClick={() => setLinkFrom(undefined)}>Cancel</button></span>}
      {sourceWorktree && <Menu><MenuTrigger render={<Button size="sm" variant="outline" />}><Icon name="Plus" className="size-3.5" /> Add node</MenuTrigger><MenuPopup align="end" className="max-h-80 min-w-64 overflow-y-auto">
        <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{sourceWorktree.location} / {sourceWorktree.worktree} · {sourceWorktree.box}</div>
        <MenuItem disabled={creating} onClick={() => void createTerminal()}><Icon name="SquareTerminal" className="size-3.5" /> New terminal</MenuItem>
        <MenuSeparator />
        {sourceSessions.length ? sourceSessions.map((s) => <MenuItem key={s.name} onClick={() => addSession(s, sourceWorktree)}><Icon name={s.agent ? "Bot" : "SquareTerminal"} className="size-3.5" /> <span className="max-w-52 truncate">{s.title || s.name}</span></MenuItem>) : <MenuItem disabled>No sessions in this worktree</MenuItem>}
        <MenuSeparator />
        {sourceServices.length ? sourceServices.map((svc) => <MenuItem key={svc.port} onClick={() => addPreview(svc, sourceWorktree)}><Icon name="Globe" className="size-3.5" /> Preview · port {svc.port}</MenuItem>) : <MenuItem disabled>No running previews</MenuItem>}
        {Object.values(helpers).some((list) => list.length) && <><MenuSeparator /><div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Subagents · read only</div>{sourceSessions.flatMap((s) => (helpers[s.name] ?? []).map((helper) => <MenuItem key={`${s.name}:${helper.id}`} onClick={() => addHelper(s, helper, sourceWorktree)}><Icon name="Bot" className="size-3.5" /> <span className="max-w-52 truncate">{helper.name}</span></MenuItem>))}</>}
      </MenuPopup></Menu>}
      <Button size="sm" variant="ghost" onClick={() => { setPan({ x: 0, y: 0 }); setZoom(1); }}><Icon name="Scan" className="size-3.5" /> Reset view</Button>
    </div>
    <div ref={viewport} className="relative min-h-0 flex-1 overflow-hidden bg-muted/20" style={{ backgroundImage: "radial-gradient(color-mix(in oklab, var(--foreground) 13%, transparent) 1px, transparent 1px)", backgroundSize: `${24 * zoom}px ${24 * zoom}px`, backgroundPosition: `${pan.x}px ${pan.y}px` }} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={() => { panGesture.current = undefined; }} onPointerCancel={() => { panGesture.current = undefined; }}>
      {worktree ? <div className="absolute top-0 left-0" style={{ width: 0, height: 0, overflow: "visible", pointerEvents: "none", transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}>
        <div className="pointer-events-none absolute top-10 left-14 w-80"><div className="font-mono text-[10px] tracking-[.18em] text-primary">WORKTREE CANVAS</div><div className="mt-1 text-2xl font-semibold tracking-tight">{worktree.worktree}</div><div className="text-xs text-muted-foreground">{worktree.location} · {worktree.box}</div></div>
        <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" aria-hidden="true">{board.links.map((link) => {
          const from = byId.get(link.from), to = byId.get(link.to);
          if (!from || !to) return null;
          return <path key={`${link.from}:${link.to}`} d={linkGeometry(from, to).path} fill="none" stroke="var(--primary)" strokeWidth="2" opacity=".65" />;
        })}</svg>
        {board.links.map((link) => {
          const from = byId.get(link.from), to = byId.get(link.to);
          if (!from || !to) return null;
          const mid = linkGeometry(from, to);
          return <button key={`remove:${link.from}:${link.to}`} aria-label="Remove visual link" className="absolute z-10 flex size-5 items-center justify-center rounded-full border bg-card text-xs text-muted-foreground shadow-sm hover:text-foreground" style={{ left: mid.x - 10, top: mid.y - 10, pointerEvents: "auto" }} onPointerDown={(e) => e.stopPropagation()} onClick={() => save({ ...board, links: board.links.filter((l) => l !== link) })}>×</button>;
        })}
        {shown.map((node) => {
          const isSession = node.kind === "session";
          const source = node.source ?? worktree;
          const liveSession = node.kind !== "preview" ? fleetSessions[node.box]?.find((s) => s.name === node.session) : undefined;
          const label = isSession ? liveSession?.title || node.session : node.kind === "helper" ? node.name : `Preview · ${node.port}`;
          const active = selectedNode === node.id;
          return <section key={node.id} aria-label={`${label} canvas node`} className={`absolute flex flex-col overflow-hidden rounded-xl border bg-card shadow-xl ${active ? "border-primary ring-1 ring-primary/30" : "border-border"}`} style={{ left: node.x, top: node.y, width: node.w, height: node.h, pointerEvents: "auto" }} onClick={() => clickNode(node.id)}>
            <header className={`flex h-12 shrink-0 cursor-grab items-center gap-2 border-b bg-muted/50 px-3 active:cursor-grabbing ${linkFrom ? "cursor-crosshair" : ""}`} onPointerDown={(e) => begin(e, node, "move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
              {isSession ? <AgentIcon agent={liveSession?.agent ?? node.agent} className="size-4 shrink-0" /> : <Icon name={node.kind === "helper" ? "Bot" : "Globe"} className="size-4 shrink-0 text-primary" />}
              <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold">{label}</span><span className="block truncate text-[9px] text-muted-foreground">{source ? `${source.location} / ${source.worktree} · ${source.box}` : node.box}{node.kind === "helper" ? " · subagent" : ""}</span></span>
              {isSession && <span className="rounded-full border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">{liveSession?.exited ? "ended" : liveSession?.agent_state ?? (node.agent ? "agent" : "shell")}</span>}
              {node.kind === "helper" && <span className="rounded-full border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">read only</span>}
              {isSession && <button aria-label={node.mode === "chat" ? "Show terminal" : "Show chat"} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); replace(node.id, { mode: node.mode === "chat" ? "terminal" : "chat" }); }}><Icon name={node.mode === "chat" ? "SquareTerminal" : "MessageSquare"} className="size-3.5" /></button>}
              <button aria-label="Link from this node" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); setLinkFrom(node.id); }}><Icon name="Link2" className="size-3.5" /></button>
              <button aria-label={isSession ? "Open session in workspace" : node.kind === "helper" ? "Open parent session" : "Open preview in browser"} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); if (node.kind !== "preview") berth.openTerminal(node.box, node.session); else { if (source) berth.openWorktree(source); berth.openBrowser(berth.api.serviceUrl(node.box, node.port)); } }}><Icon name="ArrowUpRight" className="size-3.5" /></button>
              <button aria-label="Remove node" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={(e) => { e.stopPropagation(); remove(node.id); }}><Icon name="X" className="size-3.5" /></button>
            </header>
            <div className="relative min-h-0 flex-1 overflow-hidden">{node.kind === "session"
              ? <SessionSurface box={node.box} session={node.session} agent={liveSession?.agent ?? node.agent} mode={node.mode} visible focused={active} onModeChange={(mode: "chat" | "terminal") => replace(node.id, { mode })} />
              : node.kind === "helper" ? <HelperSurface box={node.box} session={node.session} helper={node.helper} name={node.name} onClose={() => remove(node.id)} />
              : <BrowserSurface id={node.id} url={berth.api.serviceUrl(node.box, node.port)} worktree={source ? keyOf(source) : boardKey} visible />}</div>
            <div role="button" tabIndex={0} aria-label={`Resize ${label}`} className="absolute right-0 bottom-0 z-10 size-4 cursor-nwse-resize rounded-tl bg-card/85 text-center text-[10px] leading-4 text-muted-foreground" onPointerDown={(e) => { e.stopPropagation(); begin(e, node, "resize"); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={(e) => {
              if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
              e.preventDefault();
              replace(node.id, { w: clamp(node.w + (e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0), 340, 1100), h: clamp(node.h + (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0), 250, 850) });
            }}>⌟</div>
          </section>;
        })}
        {!shown.length && <div className="absolute top-52 left-60 flex w-96 flex-col items-center rounded-xl border bg-card/85 px-7 py-8 text-center shadow-lg"><Icon name="Workflow" className="mb-3 size-7 text-primary" /><h2 className="text-base font-semibold">Give this worktree some room</h2><p className="mt-2 text-sm text-muted-foreground">Add sessions, subagents, or previews from any worktree. Your layout stays on this computer.</p><Button size="sm" className="mt-4" onClick={() => void createTerminal()}>New terminal</Button></div>}
      </div> : <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a worktree to start its canvas.</div>}
      <div className="absolute right-4 bottom-4 z-20 flex w-fit items-center overflow-hidden rounded-lg border bg-card shadow-lg"><button aria-label="Zoom out" className="px-3 py-2 text-sm hover:bg-accent" onClick={() => zoomTo(zoom - .1)}>−</button><span className="min-w-12 border-x px-2 py-2 text-center font-mono text-xs">{Math.round(zoom * 100)}%</span><button aria-label="Zoom in" className="px-3 py-2 text-sm hover:bg-accent" onClick={() => zoomTo(zoom + .1)}>+</button></div>
    </div>
  </div>;
}
