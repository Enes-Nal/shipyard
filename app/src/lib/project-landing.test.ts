// node --experimental-strip-types --test src/lib/project-landing.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Location, Session } from "@berth/plugin";

import { landingAgent } from "./project-landing.ts";

const loc = { name: "shop", path: "/src/shop", repo: true, scripts: {}, worktrees: [{ path: "/src/shop", main: true }, { path: "/wt/shop-a" }, { path: "/wt/shop-b" }] } as unknown as Location;

const agent = (name: string, dir: string, extra: Partial<Session> = {}): Session =>
  ({ name, dir, agent: "claude", command: "claude", created: "2026-10-20T09:00:00Z", exited: false, attached: 0, ...extra }) as Session;

test("lands on the agent whose work changed last", () => {
  const sessions = [
    agent("a", "/wt/shop-a", { agent_state: "running", state_since: "2026-10-20T10:00:00Z" }),
    agent("b", "/wt/shop-b", { agent_state: "waiting", state_since: "2026-10-20T11:00:00Z" }),
  ];
  assert.equal(landingAgent([{ box: "mini", loc, sessions }])?.session.name, "b");
});

test("across the project's boxes", () => {
  const a = agent("a", "/wt/shop-a", { agent_state: "running", state_since: "2026-10-20T10:00:00Z" });
  const b = agent("b", "/wt/shop-b", { agent_state: "running", state_since: "2026-10-20T12:00:00Z" });
  assert.deepEqual(
    landingAgent([
      { box: "mini", loc, sessions: [a] },
      { box: "studio", loc, sessions: [b] },
    ]),
    { box: "studio", session: b },
  );
});

test("an agent done, idle, exited or elsewhere, a shell or a service doesn't count: a new task then", () => {
  const sessions = [
    agent("done", "/wt/shop-a", { agent_state: "finished" }),
    agent("idle", "/wt/shop-a", { agent_state: "idle" }),
    agent("gone", "/wt/shop-b", { exited: true }),
    agent("other", "/wt/notes-a", { agent_state: "running" }),
    agent("shell", "/wt/shop-b", { agent: undefined, command: "zsh" }),
    agent("dev", "/wt/shop-b", { service: "web", agent: undefined, command: "pnpm dev" }),
  ];
  assert.equal(landingAgent([{ box: "mini", loc, sessions }]), undefined);
  assert.equal(landingAgent([]), undefined);
});

test("with no state change on record, by when it started", () => {
  const sessions = [agent("old", "/wt/shop-a", { created: "2026-10-20T08:00:00Z" }), agent("new", "/src/shop", { created: "2026-10-20T09:30:00Z" })];
  assert.equal(landingAgent([{ box: "mini", loc, sessions }])?.session.name, "new");
});
