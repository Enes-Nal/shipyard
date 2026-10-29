import type { Service } from "@berth/plugin";

import { type BrowserContext, portUrl } from "./browser-url.ts";

// What runs in a worktree, as the box sees it (GET services: what listens
// in the worktree's folder or port block, with its command line), named for
// people: its dev server (the port Terminal gave it, $BERTH_PORT), the tools
// dev servers bring along, known by command or usual port, and the rest:
// helpers (an agent's headless Chrome, language servers, inspectors) that
// listen without being anything to open.

export interface LiveService {
  port: number;
  // A name, never a path: "Dev server", "Prisma Studio", "node".
  label: string;
  // What runs it, short ("Next.js", "node"), for the dev server.
  detail?: string;
  // The command line as the box reported it, for a tooltip.
  command?: string;
  // dev and web open in a tab; data (a database, a cache) has an address
  // but no page; other is a helper, listed apart.
  kind: "dev" | "web" | "data" | "other";
  // The private URL (dev, web), or where it listens on the box.
  url: string;
}

type Kind = LiveService["kind"];

// Known by their command line, first match wins.
const BY_COMMAND: [RegExp, string, Kind][] = [
  [/--remote-debugging-port|\bchrom(e|ium)\b|headless_shell/i, "Chrome (DevTools)", "other"],
  [/agent-browser/i, "Agent browser", "other"],
  [/(^|\/)berthd?(\s|$)/i, "Terminal", "other"],
  [/language-?server|tsserver|\bgopls\b|rust-analyzer|pyright|eslint_d|copilot|\bvscode/i, "Language server", "other"],
  [/--inspect\b|--inspect=/i, "Node inspector", "other"],
  [/prisma(\.js)?\s+studio|prisma-studio/i, "Prisma Studio", "web"],
  [/drizzle-kit\s+studio/i, "Drizzle Studio", "web"],
  [/storybook/i, "Storybook", "web"],
  [/\bnext(-server|\.js)?\b|next\s+(dev|start)/i, "Next.js", "dev"],
  [/\bvite\b/i, "Vite", "dev"],
  [/\bastro\b/i, "Astro", "dev"],
  [/\bremix\b/i, "Remix", "dev"],
  [/\bnuxt\b/i, "Nuxt", "dev"],
  [/jupyter/i, "Jupyter", "web"],
  [/mailpit/i, "Mailpit", "web"],
  [/\bpostgres\b/i, "PostgreSQL", "data"],
  [/\bmysqld?\b/i, "MySQL", "data"],
  [/redis-server|\bredis\b/i, "Redis", "data"],
  [/\bmongod\b/i, "MongoDB", "data"],
];

// Known by their usual port, when the command doesn't say.
const BY_PORT: Record<number, [string, Kind]> = {
  5555: ["Prisma Studio", "web"],
  4983: ["Drizzle Studio", "web"],
  6006: ["Storybook", "web"],
  8025: ["Mailpit", "web"],
  8888: ["Jupyter", "web"],
  5432: ["PostgreSQL", "data"],
  3306: ["MySQL", "data"],
  6379: ["Redis", "data"],
  27017: ["MongoDB", "data"],
  9229: ["Node inspector", "other"],
  24678: ["Vite HMR", "other"],
};

// Runtimes that serve pages more often than not: their port opens in a tab.
const RUNTIMES = /^(node|bun|deno|python[\d.]*|ruby|php|java|dotnet|uvicorn|gunicorn|hypercorn|rails|puma|unicorn|air|caddy|nginx|httpd|hugo|jekyll|serve|http-server)$/i;

// executable is a command line's program, without its folder.
export function executable(command?: string): string | undefined {
  const first = command?.trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const prog = first?.[1] ?? first?.[2] ?? first?.[3];
  return prog?.split("/").pop() || undefined;
}

// middle shortens text in the middle, keeping both ends.
export function middle(s: string, max = 40): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - (max - 1 - half))}`;
}

function identify(s: Service): { name: string; kind: Kind } {
  const cmd = s.process ?? "";
  const byCmd = BY_COMMAND.find(([re]) => re.test(cmd));
  if (byCmd) return { name: byCmd[1], kind: byCmd[2] };
  const byPort = BY_PORT[s.port];
  if (byPort) return { name: byPort[0], kind: byPort[1] };
  const exe = executable(cmd);
  if (!exe) return { name: `Port ${s.port}`, kind: "other" };
  return { name: middle(exe, 24), kind: RUNTIMES.test(exe) ? "web" : "other" };
}

// liveServices lists what listens in a worktree: its dev server first, then
// what opens in a tab, then data stores, then helpers. devPort is the
// worktree's own port ($BERTH_PORT); ctx is how its URLs are made.
export function liveServices(services: Service[] | undefined, ctx: Required<Pick<BrowserContext, "ref">> & BrowserContext, devPort?: number): LiveService[] {
  const ref = ctx.ref;
  const here = (services ?? []).filter((s) => s.path === ref.path).sort((a, b) => a.port - b.port);
  const known = here.map((s) => ({ s, ...identify(s) }));
  // The dev server: what listens on the worktree's own port, else the
  // lowest framework or runtime that serves pages.
  // A listener the box can't name (an older macOS box reports none) on
  // that port is still the worktree's own server, not a helper.
  const own = (k: (typeof known)[number]) => k.s.port === devPort && k.kind !== "data" && (k.kind !== "other" || !k.s.process);
  const dev = known.find(own) ?? known.find((k) => k.kind === "dev") ?? known.find((k) => k.kind === "web" && RUNTIMES.test(executable(k.s.process) ?? ""));
  const order: Record<Kind, number> = { dev: 0, web: 1, data: 2, other: 3 };
  return known
    .map(({ s, name, kind }): LiveService => {
      const isDev = dev?.s === s;
      // A second framework server is still a page to open, not "the" dev server.
      const k: Kind = isDev ? "dev" : kind === "dev" ? "web" : kind;
      const url = k === "data" || k === "other" ? `localhost:${s.port} on ${ref.box}` : (portUrl(s.port, ctx) ?? "");
      return { port: s.port, label: isDev ? "Dev server" : name, detail: isDev ? name : undefined, command: s.process || undefined, kind: k, url };
    })
    .sort((a, b) => order[a.kind] - order[b.kind] || a.port - b.port);
}
