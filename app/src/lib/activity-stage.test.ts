import assert from "node:assert/strict";
import test from "node:test";

import { activityStage } from "./activity-stage.ts";

test("visualizes untouched and paused branches as todo", () => {
  assert.equal(activityStage({ running: false, changed: 0, untracked: 0, ahead: 0 }), "todo");
  assert.equal(activityStage({ paused: true, running: false, changed: 0, untracked: 0, ahead: 2 }), "todo");
});

test("agent activity and files in flight stay in progress", () => {
  assert.equal(activityStage({ running: true, changed: 0, untracked: 0, ahead: 0 }), "doing");
  assert.equal(activityStage({ running: false, changed: 1, untracked: 0, ahead: 2 }), "doing");
});

test("a clean committed branch is done", () => {
  assert.equal(activityStage({ running: false, changed: 0, untracked: 0, ahead: 2 }), "done");
});
