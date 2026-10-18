// node --experimental-strip-types --test src/lib/prefs-migrate.test.ts (pnpm test)
import assert from "node:assert/strict";
import { test } from "node:test";

import { migratePrefs, PREFS_VERSION } from "./prefs-migrate.ts";

test("prefs are saved at this version", () => {
  assert.equal(PREFS_VERSION, 4);
  assert.equal(migratePrefs({}).version, 4);
});

test("structured agents, off as the Labs default, are turned on once", () => {
  assert.equal(migratePrefs({ structuredClaude: false, version: 3 }).structuredClaude, true);
  assert.equal(migratePrefs({ structuredClaude: false, version: 2 }).structuredClaude, true);
  assert.equal(migratePrefs({ structuredClaude: false }).structuredClaude, true);
  // Never saved (before the setting existed): on too.
  assert.equal(migratePrefs({ labs: true, version: 3 }).structuredClaude, true);
  assert.equal(migratePrefs({ structuredClaude: true, version: 3 }).structuredClaude, true);
});

test("structured agents turned off after the move stay off", () => {
  const once = migratePrefs({ structuredClaude: false, version: 3 });
  assert.equal(migratePrefs({ ...once, structuredClaude: false }).structuredClaude, false);
  assert.equal(migratePrefs({ structuredClaude: false, version: 4 }).structuredClaude, false);
});

test("the move leaves the other prefs as they were", () => {
  const out = migratePrefs({ structuredClaude: false, approvals: "ask", labs: false, labsChosen: true, closeAgents: "keep", closeAgentsChosen: true, version: 3 });
  assert.deepEqual(out, { structuredClaude: true, approvals: "ask", labs: false, labsChosen: true, closeAgents: "keep", closeAgentsChosen: true, version: 4 });
});

test("the earlier moves still happen on the way", () => {
  assert.deepEqual(migratePrefs({ labs: false, closeAgents: "keep", agentCloseTips: 2 }), { labs: true, closeAgents: "stop", agentCloseTips: 0, structuredClaude: true, version: 4 });
  assert.equal(migratePrefs({ labs: false, version: 2 }).labs, true);
  assert.equal(migratePrefs({ labs: false, labsChosen: true, version: 2 }).labs, false);
});
