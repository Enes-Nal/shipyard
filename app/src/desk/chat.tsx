import { ArrowUpIcon, ClockIcon, GitBranchIcon, GitBranchPlusIcon, KeyRoundIcon, ShieldCheckIcon, ShieldIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { ConversationView } from "@/components/conversation/conversation-view";
import { ChatScope } from "@/components/conversation/notice-card";
import { Tip } from "@/components/tip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { desk, type BranchMove, type ChatAccess, type DeskChat, type DeskProject } from "@/lib/desk/api";
import { branchFor, validBranch } from "@/lib/desk/branch";
import { useDesk } from "@/lib/desk/store";
import type { TranscriptItem } from "@/lib/transcript";
import { cn } from "@/lib/utils";

// ChatPane is one chat: its branch and what it is doing at the top, the
// conversation drawn as cards (components/conversation), and the composer.

const EMPTY: TranscriptItem[] = [];

export function ChatPane({ chat, project }: { chat: DeskChat; project: DeskProject }) {
  const items = useDesk((s) => s.conversations[chat.id]?.items ?? EMPTY);
  const running = chat.status === "running";
  // While it works, the conversation ends on a line that says so.
  const shown = useMemo<TranscriptItem[]>(
    () =>
      running
        ? [
            ...items,
            {
              kind: "thinking",
              id: "desk-thinking",
              since: chat.since ?? Date.now(),
            },
          ]
        : items,
    [items, running, chat.since],
  );
  // The agent's own record already says why the turn stopped (a notice).
  const told = !!chat.error && items.some((it) => it.kind === "notice" && it.text.trim() === chat.error?.trim());
  const other = useDesk((s) => (project.running && project.running !== chat.id ? s.state.chats.find((c) => c.id === project.running) : undefined));
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatHeader chat={chat} project={project} />
      {(chat.moves?.length ?? 0) > 0 && <BranchMoves moves={chat.moves!} />}
      {/* The conversation's rows are drawn in this scroller (ChatList). */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-page pt-6 pb-4">
        {items.length === 0 && !running && !chat.queued?.length ? (
          <Start project={project} />
        ) : (
          <ChatScope
            value={{
              who: "Claude Code",
              send: (t) => void desk.send(chat.id, t).then(() => useDesk.getState().refresh()),
            }}
          >
            <ConversationView
              items={shown}
              who="Claude"
              onAnswer={() =>
                toastManager.add({
                  type: "info",
                  title: "Answer in your next message",
                  description: "Answering the agent's questions here comes with approvals, in a later version.",
                })
              }
              tail={<Tail chat={chat} other={other} told={told} />}
              tailSize={(chat.queued?.length ?? 0) + (chat.error ? 1 : 0)}
            />
          </ChatScope>
        )}
      </div>
      <Composer chat={chat} project={project} />
    </div>
  );
}

function ChatHeader({ chat, project }: { chat: DeskChat; project: DeskProject }) {
  return (
    <header className="flex h-bar shrink-0 items-center gap-3 border-b border-border/80 px-page">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <h1 className="truncate text-heading">{chat.title || "New chat"}</h1>
        <span className="shrink-0 text-meta text-muted-foreground">{project.name}</span>
      </div>
      {chat.branch && (
        <Tip label={project.branch && project.branch !== chat.branch ? `This chat works on ${chat.branch}; the folder is on ${project.branch} now. Sending switches it.` : `On ${chat.branch}`}>
          <span className="flex max-w-56 items-center gap-1 rounded-md border border-border/80 px-2 py-0.5 text-label">
            <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{chat.branch}</span>
          </span>
        </Tip>
      )}
      {chat.status === "running" && (
        <Button size="sm" variant="outline" onClick={() => void desk.stop(chat.id)}>
          <SquareIcon />
          Stop
        </Button>
      )}
    </header>
  );
}

// BranchMoves says what this chat did with branches, newest last: the
// branch it started, and each one the agent moved to.
function BranchMoves({ moves }: { moves: BranchMove[] }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 bg-info/5 px-page py-2">
      {moves.map((m, i) => (
        <span key={i} className="flex items-center gap-1.5 rounded-md bg-background px-2 py-1 text-label shadow-xs">
          <GitBranchPlusIcon className="size-3.5 text-info-foreground" />
          {m.kind === "created" ? (
            <>
              Made <b className="font-semibold">{m.to}</b>
              {m.from && <span className="text-muted-foreground">from {m.from}</span>}
            </>
          ) : (
            <>
              Moved to <b className="font-semibold">{m.to}</b>
              {m.from && <span className="text-muted-foreground">from {m.from}</span>}
            </>
          )}
        </span>
      ))}
    </div>
  );
}

// Tail sits under the conversation: messages waiting their turn, and why
// the last turn didn't finish.
// told: the conversation's own notice already says what went wrong, so
// only what to do about it is added.
function Tail({ chat, other, told }: { chat: DeskChat; other?: DeskChat; told: boolean }) {
  const auth = chat.error && /authenticat|log ?in|oauth|credential/i.test(chat.error);
  return (
    <div className="flex flex-col gap-2">
      {chat.queued?.map((q, i) => (
        <div key={i} className="ml-auto flex max-w-[80%] flex-col items-end gap-1">
          <div className="rounded-xl bg-secondary px-3 py-2 text-body text-secondary-foreground opacity-70">{q}</div>
          <span className="flex items-center gap-1 text-meta text-muted-foreground">
            <ClockIcon className="size-3" />
            {other ? `Waits for “${other.title || "another chat"}” to finish in this project` : "Sends when this turn ends"}
          </span>
        </div>
      ))}
      {told && auth && (
        <p className="text-desc text-muted-foreground">
          Open a terminal, run <code className="text-mono">claude</code>, type <code className="text-mono">/login</code>, then send your message again.
        </p>
      )}
      {chat.error && !told && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          {auth ? <KeyRoundIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" /> : <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />}
          <div className="min-w-0 text-desc">
            <p className="font-medium">{auth ? "Claude Code needs you to log in" : "The turn didn't finish"}</p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground">{chat.error}</p>
            {auth && (
              <p className="mt-1 text-muted-foreground">
                Open a terminal, run <code className="text-mono">claude</code>, type <code className="text-mono">/login</code>, then send your message again.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Start({ project }: { project: DeskProject }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-page text-center">
      <p className="text-title">What should Claude do?</p>
      <p className="max-w-md text-desc text-muted-foreground">
        It works right in <span className="font-medium text-foreground">{project.path}</span>
        {project.branch ? (
          <>
            , on <span className="font-medium text-foreground">{project.branch}</span> or a new branch you pick below.
          </>
        ) : (
          "."
        )}
      </p>
    </div>
  );
}

const ACCESS: Record<ChatAccess, { label: string; tip: string }> = {
  full: {
    label: "Full access",
    tip: "Claude runs commands and edits files without asking",
  },
  edits: {
    label: "Edits only",
    tip: "Claude edits files; commands it would run are refused",
  },
};

function Composer({ chat, project }: { chat: DeskChat; project: DeskProject }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // A new chat picks its branch once: stay where the folder is, or a new one.
  const first = !chat.started && !chat.queued?.length && chat.status === "idle";
  const [newBranch, setNewBranch] = useState(false);
  const [name, setName] = useState("");
  const [named, setNamed] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText("");
    setNewBranch(false);
    setName("");
    setNamed(false);
    area.current?.focus();
  }, [chat.id]);
  const branch = named ? name : branchFor(text);
  const canBranch = first && project.repo;
  const badName = canBranch && newBranch && !validBranch(branch);

  const send = async () => {
    const t = text.trim();
    if (!t || sending || badName) return;
    setSending(true);
    try {
      await desk.send(chat.id, t, canBranch && newBranch ? branch : undefined);
      setText("");
      await useDesk.getState().refresh();
      void useDesk.getState().loadItems(chat.id);
    } catch (e) {
      toastManager.add({
        type: "error",
        title: "Couldn't send",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const setAccess = (access: ChatAccess) => void desk.updateChat(chat.id, { access }).then(() => useDesk.getState().refresh());

  return (
    <div className="shrink-0 px-page pb-4">
      <div className="mx-auto max-w-3xl rounded-xl border border-input bg-background shadow-xs/5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          placeholder={chat.status === "running" ? "Send another message when this turn ends…" : "Ask Claude to build, fix or explain something…"}
          className="block max-h-64 min-h-16 w-full resize-none bg-transparent px-3 pt-3 text-body outline-none placeholder:text-muted-foreground/72"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {canBranch && (
            <div className="flex items-center gap-1 rounded-lg bg-muted p-0.5 text-label">
              <button type="button" className={cn("flex items-center gap-1 rounded-md px-2 py-1", !newBranch && "bg-background shadow-xs")} onClick={() => setNewBranch(false)}>
                <GitBranchIcon className="size-3.5" />
                {project.branch ?? "Current branch"}
              </button>
              <button type="button" className={cn("flex items-center gap-1 rounded-md px-2 py-1", newBranch && "bg-background shadow-xs")} onClick={() => setNewBranch(true)}>
                <GitBranchPlusIcon className="size-3.5" />
                New branch
              </button>
            </div>
          )}
          {canBranch && newBranch && (
            <Input
              size="sm"
              aria-label="New branch name"
              aria-invalid={badName || undefined}
              className="w-56"
              value={branch}
              onChange={(e) => {
                setNamed(true);
                setName(e.target.value);
              }}
            />
          )}
          {!canBranch && chat.branch && (
            <span className="flex items-center gap-1 text-label text-muted-foreground">
              <GitBranchIcon className="size-3.5" />
              {chat.branch}
            </span>
          )}
          <div className="flex-1" />
          <Menu>
            <Tip label={ACCESS[chat.access].tip}>
              <MenuTrigger render={<Button size="sm" variant="ghost" />}>
                {chat.access === "full" ? <ShieldIcon /> : <ShieldCheckIcon />}
                {ACCESS[chat.access].label}
              </MenuTrigger>
            </Tip>
            <MenuPopup align="end">
              <MenuRadioGroup value={chat.access} onValueChange={(v) => setAccess(v as ChatAccess)}>
                {(Object.keys(ACCESS) as ChatAccess[]).map((a) => (
                  <MenuRadioItem key={a} value={a}>
                    <span className="flex flex-col">
                      <span>{ACCESS[a].label}</span>
                      <span className="text-meta text-muted-foreground">{ACCESS[a].tip}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
          <Tip label="Send (Enter)">
            <Button size="icon-sm" aria-label="Send" disabled={!text.trim() || sending || badName} onClick={() => void send()}>
              {sending ? <Spinner /> : <ArrowUpIcon />}
            </Button>
          </Tip>
        </div>
      </div>
    </div>
  );
}
