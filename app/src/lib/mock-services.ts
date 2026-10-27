import type { BerthEvent, Session, TerminalConnection, TerminalHandlers } from "@/lib/api";

// Mock mode's services that run in a terminal of their own: each
// worktree's "web" dev server (a Next.js app), whose session the box lists
// with service set. It starts and stops for real here: Ctrl-C in its tab
// stops it as on a box, the tab keeps what it printed, and Start runs it
// again in the same tab.

export const serviceSessionName = (loc: string, wt: string, svc: string) => `svc-${loc}-${wt}-${svc}`;

// What lib/mock.ts lends: its sessions, worktree paths, dev ports and events.
interface Deps {
  sessions(box: string): Session[];
  path(box: string, loc: string, wt: string): string;
  port(box: string, path: string): number;
  emit(e: Omit<BerthEvent, "time">): void;
}
let deps: Deps | undefined;
export const wireMockServices = (d: Deps) => void (deps = d);
export const mockWorktreePath = (box: string, loc: string, wt: string) => deps?.path(box, loc, wt);

// mockTerminalService is a terminal service's session and whether it runs,
// after starting (run true) or stopping (run false) it when asked. Its
// session is made the first time it starts and kept when it stops.
export function mockTerminalService(box: string, loc: string, wt: string, svc: { name: string; title?: string; run: string }, run?: boolean): { session: string; running: boolean } {
  const name = serviceSessionName(loc, wt, svc.name);
  if (!deps) return { session: name, running: false };
  const list = deps.sessions(box);
  let s = list.find((x) => x.name === name);
  if (run !== undefined) {
    const path = deps.path(box, loc, wt);
    if (!s && run) {
      s = { name, title: svc.title || svc.name, location: loc === wt ? loc : `${loc}/${wt}`, dir: path, command: svc.run, created: new Date().toISOString(), attached: 0, exited: true, service: svc.name };
      list.push(s);
    }
    if (s && s.exited !== !run) {
      s.exited = !run;
      if (run) mockServiceStarted(s, deps.port(box, path));
    }
  }
  return { session: name, running: !!s && !s.exited };
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const purple = (s: string) => `\x1b[35m${s}\x1b[0m`;

// What a Next.js dev server prints as it starts and serves a few pages.
function startup(s: Session, port: number): string[] {
  return [
    "\r\n",
    `> shop@0.1.0 dev ${s.dir}\r\n`,
    `> next dev --turbopack --port ${port}\r\n\r\n`,
    `   ${purple(bold("▲ Next.js 15.5.4"))} ${dim("(Turbopack)")}\r\n`,
    `   - Local:        http://localhost:${port}\r\n`,
    "   - Network:      http://10.0.0.12:" + port + "\r\n",
    "   - Environments: .env.local\r\n\r\n",
    ` ${green("✓")} Starting...\r\n`,
    ` ${green("✓")} Ready in 1182ms\r\n`,
    ` ${dim("○")} Compiling / ...\r\n`,
    ` ${green("✓")} Compiled / in 2.4s\r\n`,
    ` GET / ${green("200")} in 2611ms\r\n`,
    ` ${dim("○")} Compiling /api/checkout ...\r\n`,
    ` ${green("✓")} Compiled /api/checkout in 412ms\r\n`,
    ` POST /api/checkout ${green("200")} in 486ms\r\n`,
    ` GET /orders ${green("200")} in 74ms\r\n`,
    ` GET /orders/1042 ${green("200")} in 61ms\r\n`,
  ];
}

const stopped = (s: Session) => `\r\n\x1b[33m■\x1b[0m ${s.title || s.service} stopped (exit 130). Start it again from Shipkit to run it here.\r\n`;

// Attached tabs, by session, so a start shows in a tab that is already open.
const attached = new Map<string, Set<(lines: string[]) => void>>();

// mockServiceStarted plays a service's start in its open tabs.
export function mockServiceStarted(s: Session, port: number) {
  for (const play of attached.get(s.name) ?? []) play(startup(s, port));
}

// mockServiceAttach is a tab on a service's terminal. interrupt is Ctrl-C:
// the service stops, as tmux would end its program.
export function mockServiceAttach(box: string, session: string, h: TerminalHandlers): TerminalConnection {
  const s = () => deps?.sessions(box).find((x) => x.name === session);
  const port = deps?.port(box, s()?.dir ?? "") ?? 3100;
  // Ctrl-C ends the program; the box notices and says so.
  const interrupt = () => {
    const cur = s();
    if (!cur || !deps) return;
    cur.exited = true;
    const [loc, wt = loc] = (cur.location ?? "").split("/");
    deps.emit({ type: "service.stopped", box, data: { location: loc, name: wt, path: cur.dir, service: cur.service, session, exit_status: 130 } });
  };
  const timers: number[] = [];
  let open = true;
  const queue: string[] = [];
  let pumping = false;
  const pump = () => {
    if (!open || pumping) return;
    const next = queue.shift();
    if (next === undefined) return;
    pumping = true;
    h.onData(next);
    timers.push(
      window.setTimeout(() => {
        pumping = false;
        pump();
      }, 70),
    );
  };
  const play = (lines: string[]) => {
    queue.push(...lines);
    pump();
  };
  const now = s();
  timers.push(window.setTimeout(() => h.onOpen(), 120));
  timers.push(
    window.setTimeout(() => {
      h.onData("\x1b[2J\x1b[H");
      if (!now) return;
      // The screen as tmux redraws it on attach: everything so far, all at
      // once, then its stopped line if it has stopped.
      h.onData(startup(now, port).join(""));
      if (now.exited) h.onData(`^C\r\n${stopped(now)}`);
    }, 160),
  );
  const mine = (lines: string[]) => {
    h.onData("\x1b[2J\x1b[H");
    play(lines);
  };
  const set = attached.get(now?.name ?? "") ?? new Set();
  set.add(mine);
  if (now) attached.set(now.name, set);
  return {
    send(data: Uint8Array | string) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      const cur = s();
      if (!cur || cur.exited) return;
      if (text.includes("\x03")) {
        queue.length = 0;
        h.onData(`^C\r\n${stopped(cur)}`);
        interrupt();
        return;
      }
      // A dev server reads no keys; Enter just moves the cursor down, as it would.
      h.onData(text.replace(/\r/g, "\r\n").replace(/\x7f/g, ""));
    },
    resize() {},
    close() {
      open = false;
      set.delete(mine);
      timers.forEach(clearTimeout);
      h.onClose(true);
    },
  };
}
