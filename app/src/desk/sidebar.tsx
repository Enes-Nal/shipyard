import { ChevronRightIcon, ClockIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, MoreHorizontalIcon, PlusIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { desk, type DeskChat, type DeskProject } from "@/lib/desk/api";
import { chatsOf, useDesk } from "@/lib/desk/store";
import { cn } from "@/lib/utils";

// The sidebar: your projects, each with its chats, newest first, as T3 Code
// lays them out. A chat says when it works, waits its turn, or made a branch.

export function DeskSidebar({ onAddProject }: { onAddProject(): void }) {
  const state = useDesk((s) => s.state);
  const project = useDesk((s) => s.project);
  const first = project ?? state.projects[0]?.id;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-border/80 bg-sidebar text-sidebar-foreground">
      <div className="flex flex-col gap-1 px-edge py-3">
        <Button className="w-full justify-start" variant="outline" onClick={() => (first ? void newChat(first) : onAddProject())}>
          <SquarePenIcon />
          New chat
        </Button>
      </div>
      <div className="flex items-center justify-between pl-lane pr-2">
        <span className="text-label text-muted-foreground">Projects</span>
        <Tip label="Add a project folder">
          <Button size="icon-xs" variant="ghost" aria-label="Add a project folder" onClick={onAddProject}>
            <FolderPlusIcon />
          </Button>
        </Tip>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-edge py-1">
        {state.projects.length === 0 && <p className="pl-lane pr-2 pt-2 text-desc text-muted-foreground">Add a folder on this PC to start chatting with an agent in it.</p>}
        {state.projects.map((p) => (
          <ProjectGroup key={p.id} project={p} chats={chatsOf(state, p.id)} />
        ))}
      </nav>
    </aside>
  );
}

async function newChat(project: string) {
  try {
    const c = await desk.newChat(project);
    await useDesk.getState().refresh();
    useDesk.getState().openChat(c.id);
  } catch (e) {
    toastManager.add({
      type: "error",
      title: "Couldn't start a chat",
      description: e instanceof Error ? e.message : String(e),
    });
  }
}

function ProjectGroup({ project: p, chats }: { project: DeskProject; chats: DeskChat[] }) {
  const [open, setOpen] = useState(true);
  const current = useDesk((s) => s.project === p.id);
  const remove = async () => {
    try {
      await desk.removeProject(p.id);
      if (useDesk.getState().project === p.id) useDesk.getState().setProject(undefined);
      await useDesk.getState().refresh();
    } catch (e) {
      toastManager.add({
        type: "error",
        title: "Couldn't remove the project",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <section className="mb-1">
      <div className={cn("group flex items-center gap-1 rounded-md pr-1 hover:bg-accent/60", current && "text-foreground")}>
        <button type="button" className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-row">{p.name}</span>
        </button>
        {p.branch && (
          <Tip label={p.dirty ? `${p.branch}, with uncommitted changes` : p.branch}>
            <span className="flex min-w-0 max-w-28 items-center gap-1 text-tag text-muted-foreground">
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{p.branch}</span>
              {p.dirty && <span className="size-1.5 shrink-0 rounded-full bg-warning" />}
            </span>
          </Tip>
        )}
        <Tip label={`New chat in ${p.name}`}>
          <Button size="icon-xs" variant="ghost" aria-label={`New chat in ${p.name}`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void newChat(p.id)}>
            <PlusIcon />
          </Button>
        </Tip>
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label={`More for ${p.name}`} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100" />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void remove()}>
              <Trash2Icon />
              Remove from Shipyard
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {p.missing && <p className="pl-lane text-meta text-destructive-foreground">This folder is gone</p>}
      {open && (
        <ul className="flex flex-col">
          {chats.map((c) => (
            <ChatRow key={c.id} chat={c} project={p} />
          ))}
          {chats.length === 0 && <li className="py-1 pl-lane text-meta text-muted-foreground">No chats yet</li>}
        </ul>
      )}
    </section>
  );
}

function ChatRow({ chat: c, project: p }: { chat: DeskChat; project: DeskProject }) {
  const open = useDesk((s) => s.open === c.id);
  // A chat that made a branch, or moved to one, says so beside its title.
  const moved = (c.moves?.length ?? 0) > 0 && c.branch && c.branch !== p.branch;
  const remove = async () => {
    try {
      await desk.removeChat(c.id);
      await useDesk.getState().refresh();
    } catch (e) {
      toastManager.add({
        type: "error",
        title: "Couldn't delete the chat",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => useDesk.getState().openChat(c.id)}
        aria-current={open ? "page" : undefined}
        className={cn("flex w-full items-center gap-2 rounded-md py-1.5 pl-lane pr-8 text-left hover:bg-accent/60", open && "bg-accent text-accent-foreground")}
      >
        <span className="min-w-0 flex-1 truncate text-desc">{c.title || "New chat"}</span>
        {(c.moves?.length ?? 0) > 0 && c.branch && (
          <Tip label={moved ? `Works on ${c.branch}` : `Made ${c.branch}`}>
            <span className={cn("flex max-w-24 items-center gap-0.5 rounded-sm px-1 text-tag", "bg-info/10 text-info-foreground")}>
              <GitBranchIcon className="size-3 shrink-0" />
              <span className="truncate">{c.branch}</span>
            </span>
          </Tip>
        )}
        <Status chat={c} />
      </button>
      <Tip label="Delete chat">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Delete chat"
          className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => void remove()}
          disabled={c.status === "running"}
        >
          <Trash2Icon />
        </Button>
      </Tip>
    </li>
  );
}

function Status({ chat: c }: { chat: DeskChat }) {
  if (c.status === "running") return <Spinner className="size-3.5 shrink-0 text-muted-foreground" />;
  if (c.status === "queued")
    return (
      <Tip label="Waiting for another chat in this project">
        <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </Tip>
    );
  if (c.error)
    return (
      <Tip label="The last turn didn't finish">
        <span className="size-2 shrink-0 rounded-full bg-destructive" />
      </Tip>
    );
  return null;
}
