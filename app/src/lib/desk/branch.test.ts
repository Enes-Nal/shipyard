import assert from "node:assert/strict";
import { test } from "node:test";

import { branchFor, validBranch } from "./branch.ts";

test("branchFor suggests a branch from a first message, as the desk does", () => {
  assert.equal(branchFor("Add rate limiting to the API"), "add-rate-limiting-to-the");
  assert.equal(branchFor("  fix: Login *breaks* on Safari"), "fix-login-breaks-on-safari");
  assert.equal(branchFor("???"), "chat");
  assert.equal(branchFor("a".repeat(60)).length, 40);
});

test("validBranch takes what git takes", () => {
  for (const ok of ["feat/x", "fix-1", "user/a.b"]) assert.ok(validBranch(ok), ok);
  for (const bad of ["", "a..b", "-x", "x.lock", "has space", "a/", "/a", "a~b"]) assert.ok(!validBranch(bad), bad);
});
