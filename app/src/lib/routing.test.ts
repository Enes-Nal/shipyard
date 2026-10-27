import assert from "node:assert/strict";
import test from "node:test";

import type { AgentPreset } from "./api.ts";
import { recommendRoute } from "./routing.ts";

const presets: AgentPreset[] = [
  { id: "claude", name: "Claude Code", command: "claude", models: ["opus", "sonnet", "haiku"], efforts: ["low", "medium", "high"] },
  { id: "codex", name: "Codex", command: "codex", models: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"], efforts: ["low", "medium", "high"] },
];

test("routes a narrow edit to an economical subscription model", () => {
  const route = recommendRoute("Fix a typo in one README file", presets);
  assert.equal(route?.tier, "economy");
  assert.deepEqual(route?.pick, { agent: "codex", model: "gpt-6-luna", effort: "low" });
});

test("routes normal implementation work to the balanced tier", () => {
  const route = recommendRoute("Add an account preferences panel and tests", presets);
  assert.equal(route?.tier, "balanced");
  assert.deepEqual(route?.pick, { agent: "codex", model: "gpt-6.1-sol", effort: "medium" });
});

test("routes risky architecture work to the strongest available agent", () => {
  const route = recommendRoute("Redesign authentication across the entire app and migrate every session safely", presets);
  assert.equal(route?.tier, "frontier");
  assert.deepEqual(route?.pick, { agent: "claude", model: "opus", effort: "high" });
});

test("uses the first installed agent when subscriptions are unavailable", () => {
  const route = recommendRoute("Build a settings panel", [{ id: "opencode", name: "OpenCode", command: "opencode" }]);
  assert.deepEqual(route?.pick, { agent: "opencode", model: "", effort: "" });
});

test("a disabled provider is never selected automatically", () => {
  const route = recommendRoute("Redesign authentication across the entire app", presets, {
    providers: { "codex-subscription": true, "claude-subscription": false, gemini: true, openrouter: true, local: true },
  });
  assert.equal(route?.provider, "codex-subscription");
  assert.equal(route?.pick.agent, "codex");
});

test("quality and usage preferences nudge the task by one tier", () => {
  assert.equal(recommendRoute("Add account preferences", presets, { objective: "quality" })?.tier, "frontier");
  assert.equal(recommendRoute("Add account preferences", presets, { objective: "usage" })?.tier, "economy");
});

test("an excluded model picks another explicitly allowed model without changing provider", () => {
  const route = recommendRoute("Fix a typo in one README file", presets, { excludedModels: ["codex:gpt-6-luna"] });
  assert.equal(route?.provider, "codex-subscription");
  assert.deepEqual(route?.pick, { agent: "codex", model: "gpt-6.1-sol", effort: "low" });
});

test("an agent with no allowed advertised models is removed from the route", () => {
  const route = recommendRoute("Add account preferences", presets, {
    excludedModels: ["codex:gpt-6.1-sol", "codex:gpt-6-luna", "codex:gpt-6-astra"],
  });
  assert.equal(route?.pick.agent, "claude");
});

