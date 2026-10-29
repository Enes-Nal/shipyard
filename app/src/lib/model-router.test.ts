import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPreset } from "@/lib/api";
import { routeTask } from "./model-router.ts";

const presets: AgentPreset[] = [
  { id: "codex", name: "Codex", command: "codex", models: ["gpt-5", "gpt-5-mini"], efforts: ["low", "medium", "xhigh"] },
  { id: "opencode", name: "OpenCode", command: "opencode", models: ["qwen-free", "claude-sonnet"], efforts: ["low", "high"] },
];

test("routes repetitive work to a free-friendly worker", () => {
  assert.deepEqual(routeTask("Format these files and sort imports", presets, { enabled: true, mode: "balanced", preferFree: true }), {
    agent: "opencode",
    model: "qwen-free",
    effort: "low",
    lane: "worker",
    reason: "Routine work goes to a free or local-friendly model",
  });
});

test("routes architectural work to the strongest lead at high effort", () => {
  const route = routeTask("Architect a secure database migration across the whole system", presets, { enabled: true, mode: "balanced", preferFree: true });
  assert.equal(route?.lane, "lead");
  assert.equal(route?.model, "gpt-5");
  assert.equal(route?.effort, "xhigh");
});

test("does not let a mechanical word demote an otherwise complex task", () => {
  const route = routeTask("Refactor this module and update snapshots", presets, {
    enabled: true,
    mode: "balanced",
    preferFree: true,
  });
  assert.equal(route?.lane, "lead");
});

test("save mode keeps moderate work on a worker", () => {
  const route = routeTask("Refactor this helper", presets, {
    enabled: true,
    mode: "save",
    preferFree: true,
  });
  assert.equal(route?.lane, "worker");
});

test("save mode still escalates migrations and other high-risk work", () => {
  const route = routeTask("Plan the database migration", presets, {
    enabled: true,
    mode: "save",
    preferFree: true,
  });
  assert.equal(route?.lane, "lead");
});

test("quality mode keeps even short work on the lead lane", () => {
  assert.equal(routeTask("Fix this typo", presets, { enabled: true, mode: "quality", preferFree: true })?.lane, "lead");
});

test("does nothing until routing and a task are present", () => {
  assert.equal(routeTask("A task", presets, { enabled: false, mode: "balanced", preferFree: true }), undefined);
  assert.equal(routeTask("", presets, { enabled: true, mode: "balanced", preferFree: true }), undefined);
});
