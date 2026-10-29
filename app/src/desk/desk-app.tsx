import { FolderOpenIcon, FolderPlusIcon, MessageSquarePlusIcon, PlugZapIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorBoundary } from "@/components/error-boundary";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToastProvider, toastManager } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WindowsTitlebar } from "@/components/window-titlebar";
import { ChatPane } from "@/desk/chat";
import { DeskSidebar } from "@/desk/sidebar";
import { useApplyTheme } from "@/hooks/use-theme";
import { hasTrafficLights, isTauri } from "@/lib/api";
import { desk, listen } from "@/lib/desk/api";
import { useDesk } from "@/lib/desk/store";

// DeskApp is Shipyard on Windows: chats with coding agents in your own
// project folders, listed on the left as in T3 Code, with no boxes and no
// worktrees. Its backend is the desk (cmd/berth-desk).

export function DeskApp() {
  useApplyTheme();
  const [adding, setAdding] = useState(false);
  useEffect(
    () =>
      listen(
        (e) => {
          const s = useDesk.getState();
          if (e.type === "state") void s.refresh();
          else if (s.open === e.chat || s.conversations[e.chat]) void s.loadItems(e.chat);
        },
        (up) => useDesk.getState().setConnected(up),
      ),
    [],
  );
  return (
    <TooltipProvider delay={300}>
      <ToastProvider position="bottom-right" viewportClassName="max-w-88 data-[position=bottom-right]:bottom-3 data-[position=bottom-right]:right-3">
        <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
          <WindowsTitlebar />
          {hasTrafficLights() && <div data-tauri-drag-region className="h-bar shrink-0" />}
          <ErrorBoundary scope="the window">
            <Body onAddProject={() => setAdding(true)} />
          </ErrorBoundary>
        </div>
        <AddProjectDialog open={adding} onOpenChange={setAdding} />
      </ToastProvider>
    </TooltipProvider>
  );
}

function Body({ onAddProject }: { onAddProject(): void }) {
  const loaded = useDesk((s) => s.loaded);
  const failure = useDesk((s) => s.failure);
  const connected = useDesk((s) => s.connected);
  const open = useDesk((s) => s.state.chats.find((c) => c.id === s.open));
  const project = useDesk((s) => s.state.projects.find((p) => p.id === open?.project));
  if (!loaded) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (failure && !connected) return <DeskDown why={failure} />;
  return (
    <div className="flex min-h-0 flex-1">
      <DeskSidebar onAddProject={onAddProject} />
      <main className="min-w-0 flex-1">{open && project ? <ChatPane key={open.id} chat={open} project={project} /> : <Welcome onAddProject={onAddProject} />}</main>
    </div>
  );
}

function Welcome({ onAddProject }: { onAddProject(): void }) {
  const projects = useDesk((s) => s.state.projects);
  const current = useDesk((s) => s.project) ?? projects[0]?.id;
  const start = async () => {
    if (!current) return onAddProject();
    try {
      const c = await desk.newChat(current);
      await useDesk.getState().refresh();
      useDesk.getState().openChat(c.id);
    } catch (e) {
      toastManager.add({
        type: "error",
        title: "Couldn't start a chat",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-page text-center">
      <p className="text-title">{projects.length ? "Pick a chat, or start one" : "Add a project to start"}</p>
      <p className="max-w-md text-desc text-muted-foreground">Agents work right in your project's folder on this PC. Each project runs one chat at a time; a message to another waits its turn.</p>
      <div className="flex gap-2">
        {projects.length > 0 && (
          <Button onClick={() => void start()}>
            <MessageSquarePlusIcon />
            New chat
          </Button>
        )}
        <Button variant={projects.length ? "outline" : "default"} onClick={onAddProject}>
          <FolderPlusIcon />
          Add a project
        </Button>
      </div>
    </div>
  );
}

function DeskDown({ why }: { why: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-page text-center">
      <PlugZapIcon className="size-6 text-muted-foreground" />
      <p className="text-title">Shipyard's backend isn't running</p>
      <p className="max-w-lg whitespace-pre-wrap text-desc text-muted-foreground">{why}</p>
      <Button variant="outline" onClick={() => void useDesk.getState().refresh()}>
        Try again
      </Button>
    </div>
  );
}

function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPath("");
  }, [open]);
  const add = async (p = path) => {
    if (!p.trim()) return;
    setBusy(true);
    try {
      const project = await desk.addProject(p);
      await useDesk.getState().refresh();
      useDesk.getState().setProject(project.id);
      onOpenChange(false);
    } catch (e) {
      toastManager.add({
        type: "error",
        title: "Couldn't add the project",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };
  const browse = async () => {
    const picked = await desk.pickFolder();
    if (picked) {
      setPath(picked);
      await add(picked);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>A folder on this PC. Agents work in it directly, on the branch it has checked out or one you pick per chat.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {isTauri() && (
            <Button variant="outline" onClick={() => void browse()} disabled={busy}>
              <FolderOpenIcon />
              Choose a folder…
            </Button>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <Input aria-label="Folder path" placeholder="E:\Code\my-app" value={path} onChange={(e) => setPath(e.target.value)} />
            <Button type="submit" disabled={busy || !path.trim()}>
              {busy ? <Spinner /> : null}
              Add
            </Button>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
