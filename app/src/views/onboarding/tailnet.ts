import { useCallback, useEffect, useState } from "react";

import { type Client, type Discovery, laptopApi, type Machine, type NetworkInfo } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { useStore } from "@/lib/store";

// The tailnets Add a box lists machines from: this computer's own, through
// the Tailscale app, and the ones Terminal signed in to itself (networks). Both
// are read once when the flow is on its way (onboarding's welcome, opening
// the dialog), so the screen is laid out once, with the answer in hand.

export type TailscaleState = "running" | "stopped" | "logged-out" | "missing" | "unknown";

export interface SystemTailnet {
  state: TailscaleState;
  // The tailnet's name, as the admin console shows it.
  name?: string;
  discovery?: Discovery;
  error?: string;
}

// stateFromError reads an older agent's discover failure, from before it
// reported Tailscale's state.
function stateFromError(message: string): TailscaleState {
  if (/not installed/i.test(message)) return "missing";
  if (/logged out|needs? (a )?login/i.test(message)) return "logged-out";
  if (/not connected/i.test(message)) return "stopped";
  return "unknown";
}

function readSystem(client: Client): Promise<SystemTailnet> {
  return laptopApi.discover(client).then(
    (d) => ({ state: d.tailscale ?? "running", name: d.tailnet, discovery: d }),
    (err) => {
      const error = errorMessage(err);
      return { state: stateFromError(error), error };
    },
  );
}

let cached: { client: Client; at: number; system: Promise<SystemTailnet>; networks: Promise<NetworkInfo[]> } | undefined;
const byNetwork = new Map<string, { at: number; found: Promise<Discovery> }>();
const FRESH_MS = 15_000;

// prefetchTailnets starts reading the tailnets, or reuses a read from the
// last few seconds.
export function prefetchTailnets(client: Client | undefined, force = false) {
  if (!client) return undefined;
  if (force || !cached || cached.client !== client || Date.now() - cached.at > FRESH_MS) {
    cached = { client, at: Date.now(), system: readSystem(client), networks: laptopApi.networks(client).catch(() => []) };
  }
  return cached;
}

// discoverNetwork lists the machines on one of Terminal's own networks.
export function discoverNetwork(client: Client, name: string, force = false): Promise<Discovery> {
  const hit = byNetwork.get(name);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return hit.found;
  const found = laptopApi.discover(client, name);
  byNetwork.set(name, { at: Date.now(), found });
  found.catch(() => byNetwork.delete(name));
  return found;
}

// How long the screen waits for the tailnets before laying itself out
// without them. A local `tailscale status` answers well within it.
const WAIT_MS = 1500;

// useTailnets is what Add a box knows about tailnets. ready turns true once
// both reads are in (or the wait is over), and stays true: refresh re-reads
// in place, keeping what is shown until the new answer comes.
export function useTailnets() {
  const client = useStore((s) => s.client);
  const [system, setSystem] = useState<SystemTailnet>();
  const [networks, setNetworks] = useState<NetworkInfo[]>();
  const [waited, setWaited] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const read = prefetchTailnets(client, nonce > 0);
    if (!read) return;
    let live = true;
    read.system.then((s) => live && setSystem(s));
    read.networks.then((n) => live && setNetworks(n));
    return () => {
      live = false;
    };
  }, [client, nonce]);

  useEffect(() => {
    const t = setTimeout(() => setWaited(true), WAIT_MS);
    return () => clearTimeout(t);
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Coming back to the app, after turning Tailscale on, say: look again.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return { ready: waited || (!!system && !!networks), system, networks: networks ?? [], refresh };
}

// A tailnet the list can show: this computer's, or one of Terminal's networks.
export interface TailnetSource {
  key: string;
  label: string;
  // The Terminal network to reach it through; none for this computer's own.
  network?: string;
}

export function sourcesOf(system: SystemTailnet | undefined, networks: NetworkInfo[]): TailnetSource[] {
  const out: TailnetSource[] = [];
  if (system?.state === "running") out.push({ key: "system", label: system.name || "This Mac's tailnet" });
  for (const n of networks) out.push({ key: `network:${n.name}`, label: n.name, network: n.name });
  return out;
}

// boxable reports whether a tailnet lists anything that could be a box.
export function boxable(system: SystemTailnet | undefined): boolean {
  return system?.state === "running" && (system.discovery?.machines.length ?? 0) > 0;
}

// rank orders machines: ones to set up first (Linux, then Macs), then
// paired ones, then offline ones.
export function rank(m: Machine): number {
  const group = !m.online ? 2 : m.box ? 1 : 0;
  return group * 2 + (m.os === "linux" ? 0 : 1);
}

export const sortMachines = (ms: Machine[]) => [...ms].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
