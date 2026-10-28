import { useEffect, useState } from "react";
import { create } from "zustand";

import { type Client, CommandError, type StreamLine } from "@/lib/api";
import { useStore } from "@/lib/store";

// Use this Mac: this computer as a box of its own. The agent installs the
// berthd the app carries as a launch agent listening on loopback only, and
// pairs with it, with nothing to copy (internal/agent/localbox.go,
// docs/reference/app-api.mdx).

// LocalBoxStatus is GET /v1/boxes/local.
export interface LocalBoxStatus {
  // Whether this computer can be a box (macOS or Linux), and whether there
  // is a berthd to install; reason says why not.
  supported: boolean;
  available: boolean;
  reason?: string;
  // A berthd service is installed for this user; owned: Terminal installed it
  // (rather than the install script).
  installed: boolean;
  owned: boolean;
  running: boolean;
  listen?: string;
  program?: string;
  // The name this laptop knows it by, once paired.
  box?: string;
  // What setting up will call it: this computer's hostname.
  name: string;
}

// follow runs a streamed set up or removal and returns the box it paired.
async function follow(c: Client, path: string, body: unknown, onLine: (line: string) => void, signal?: AbortSignal): Promise<string> {
  let failure: string | undefined;
  let box = "";
  let finished = false;
  await c.stream(
    "POST",
    path,
    body,
    (v) => {
      const l = v as StreamLine & { box?: string };
      if (l.line !== undefined) onLine(l.line);
      if (l.done) {
        finished = true;
        failure = l.error;
        box = l.box ?? "";
      }
    },
    signal,
  );
  if (failure) throw new CommandError(failure);
  if (!finished && !signal?.aborted) throw new Error("The agent stopped answering before it finished.");
  return box;
}

export const localBoxApi = {
  status: (c: Client) => c.laptop<LocalBoxStatus>("GET", "/v1/boxes/local"),
  // setUp installs berthd here and pairs with it; run again, it reconnects.
  // It resolves with the box's name.
  setUp: (c: Client, onLine: (line: string) => void, signal?: AbortSignal) => follow(c, "/v1/boxes/local", undefined, onLine, signal),
  // remove forgets the box, stops berthd and removes its service; with
  // removeData its state (keys, project list, session records) goes too.
  remove: (c: Client, removeData: boolean, onLine: (line: string) => void, signal?: AbortSignal) =>
    follow(c, "/v1/boxes/local/uninstall", { remove_data: removeData }, onLine, signal).then(() => undefined),
};

// The box set up on this computer in this session, so the next step can
// speak of "this Mac" before the agent's status has caught up.
export const useLocalBoxName = create<{ name?: string }>()(() => ({}));

// isLocalBox is whether a box runs on this computer.
export function useIsLocalBox(box: string): boolean {
  const flagged = useStore((s) => !!s.status?.boxes.find((b) => b.name === box)?.local);
  const justSetUp = useLocalBoxName((s) => s.name === box);
  return flagged || justSetUp;
}

// How long Add a box waits for the answer before laying itself out without
// the option; the agent answers from local files, well within it.
const WAIT_MS = 1500;

// useLocalBox reads whether this computer can be set up as a box. ready
// turns true once it knows (or stops waiting), so the screen is laid out
// once.
// recheck asks again, for a computer that was just made ready (WSL set up
// on Windows).
export function useLocalBox(): { ready: boolean; status?: LocalBoxStatus; recheck(): void } {
  const client = useStore((s) => s.client);
  const [status, setStatus] = useState<LocalBoxStatus>();
  const [settled, setSettled] = useState(false);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    if (!client) return;
    let live = true;
    localBoxApi.status(client).then(
      (s) => live && (setStatus(s), setSettled(true)),
      // An agent from before Use this Mac: no option.
      () => live && setSettled(true),
    );
    const t = setTimeout(() => live && setSettled(true), WAIT_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [client, asked]);
  return { ready: settled, status, recheck: () => setAsked((n) => n + 1) };
}

// offerLocalBox is whether Add a box offers Use this Mac: it can be one,
// and isn't paired as one already.
export const offerLocalBox = (s?: LocalBoxStatus) => !!s && s.supported && s.available && !s.box;
