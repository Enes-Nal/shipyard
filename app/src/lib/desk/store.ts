import { create } from "zustand";

import { desk, type DeskChat, type DeskState } from "@/lib/desk/api";
import { mergeItems } from "@/lib/desk/merge";
import type { TranscriptItem } from "@/lib/transcript";

// The desk's projects and chats as the window shows them, the chat that is
// open, and the conversation of each chat that was opened.

interface Conversation {
  items: TranscriptItem[];
  next: number;
  gen?: string;
}

interface DeskStore {
  state: DeskState;
  loaded: boolean;
  connected: boolean;
  // Why the desk couldn't be reached, when it couldn't.
  failure?: string;
  open?: string;
  // The project a new chat starts in when none is open.
  project?: string;
  conversations: Record<string, Conversation>;
  setConnected(up: boolean): void;
  refresh(): Promise<void>;
  openChat(id: string | undefined): void;
  setProject(id: string | undefined): void;
  loadItems(chat: string): Promise<void>;
}

// One read of a chat at a time; another asked meanwhile runs after it.
const reading = new Map<string, Promise<void>>();
const again = new Set<string>();

export const useDesk = create<DeskStore>()((set, get) => ({
  state: { projects: [], chats: [] },
  loaded: false,
  connected: false,
  conversations: {},
  setConnected: (connected) => set({ connected }),
  refresh: async () => {
    try {
      const state = await desk.state();
      set({ state, loaded: true, failure: undefined });
      const { open } = get();
      if (open && !state.chats.some((c) => c.id === open)) set({ open: undefined });
    } catch (e) {
      set({
        failure: e instanceof Error ? e.message : String(e),
        loaded: true,
      });
    }
  },
  openChat: (open) => {
    const chat = get().state.chats.find((c) => c.id === open);
    set({ open, project: chat?.project ?? get().project });
    if (open) void get().loadItems(open);
  },
  setProject: (project) => set({ project }),
  loadItems: async (chat) => {
    const running = reading.get(chat);
    if (running) {
      again.add(chat);
      return running;
    }
    const read = (async () => {
      do {
        again.delete(chat);
        const held = get().conversations[chat];
        const page = await desk.items(chat, held?.next ?? 0, held?.gen).catch(() => undefined);
        if (!page) return;
        const items = mergeItems(page.reset ? [] : (get().conversations[chat]?.items ?? []), page);
        set((s) => ({
          conversations: {
            ...s.conversations,
            [chat]: { items, next: page.next, gen: page.gen },
          },
        }));
      } while (again.has(chat));
    })().finally(() => reading.delete(chat));
    reading.set(chat, read);
    return read;
  },
}));

export const chatsOf = (state: DeskState, project: string): DeskChat[] => state.chats.filter((c) => c.project === project).sort((a, b) => b.updated - a.updated);
