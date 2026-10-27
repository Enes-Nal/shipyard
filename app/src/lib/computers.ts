import type { Client } from "@/lib/api";

// More than one computer on the same boxes: this one makes a join link
// (berth invite), another of yours pairs with every box in it (berth join),
// and both keep working. Each box lists the computers it trusts and can stop
// trusting one. See docs/guides/more-computers.mdx.

// A box in an invite. The link itself carries a single-use code for each;
// these fields are what the app shows.
export interface InvitedBox {
  name: string;
  addresses: string[];
  // The Terminal network (another tailnet) this computer reaches it through,
  // and that tailnet's name.
  network?: string;
  tailnet?: string;
}

export interface Invite {
  link: string;
  // This computer's name, as the other one will show it.
  from: string;
  expires: string;
  boxes: InvitedBox[];
  // Boxes that could not make a code: offline, or too old.
  skipped: { name: string; error: string }[];
}

// ready (only when checking a link), paired, already (this computer was
// paired with it before), needs-network (on a tailnet this computer has not
// signed in to), failed.
export type JoinStatus = "ready" | "paired" | "already" | "needs-network" | "failed";

export interface JoinResult {
  name: string;
  status: JoinStatus;
  error?: string;
  address?: string;
  network?: string;
  tailnet?: string;
  // When checking: reached through a network this computer has not signed
  // in to, so joining may ask for that first.
  sign_in?: boolean;
}

export interface JoinOutput {
  from: string;
  expires: string;
  boxes: JoinResult[];
}

// A computer a box trusts.
export interface TrustedComputer {
  name: string;
  fingerprint: string;
  paired_at: string;
  // The computer asking.
  you?: boolean;
}

export const computersApi = {
  invite: (c: Client, boxes: string[]) => c.laptop<Invite>("POST", "/v1/invite", { boxes }),
  // checkJoin reads a link without pairing: what it holds and what joining
  // would do.
  checkJoin: (c: Client, link: string) => c.laptop<JoinOutput>("POST", "/v1/join/check", { link }),
  join: (c: Client, link: string) => c.laptop<JoinOutput>("POST", "/v1/join", { link }),
  clients: async (c: Client, box: string) => (await c.box<TrustedComputer[] | null>(box, "GET", "clients")) ?? [],
  removeClient: (c: Client, box: string, name: string) => c.box<{ removed: string }>(box, "DELETE", `clients/${encodeURIComponent(name)}`),
};

const JOIN_LINK = /berth:\/\/join\?[^\s'"`<>]+/;

// findJoinLink pulls a join link out of pasted text: a message, the whole
// output of berth invite, or the link in quotes.
export function findJoinLink(text: string): string | undefined {
  return JOIN_LINK.exec(text)?.[0].replace(/[.,;:)\]]+$/, "");
}

// secondsLeft until an ISO time, never below zero.
export function secondsLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
}

// countdown reads 9:41.
export function countdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// boxList reads "devl, build and homelab".
export function boxList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "no boxes";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
