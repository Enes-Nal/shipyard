import assert from "node:assert/strict";
import test from "node:test";

import { basename, dirname, isPathRoot, join, pathSeparator, trimTrailingPathSeparators } from "./box-path.ts";

test("Windows paths are classified and manipulated without changing separators", () => {
  assert.equal(dirname("C:\\Users\\dev\\Projects\\shop"), "C:\\Users\\dev\\Projects");
  assert.equal(dirname("C:\\Users"), "C:\\");
  assert.equal(basename("C:\\Users\\dev\\Projects\\shop\\"), "shop");
  assert.equal(join("C:\\Users\\dev\\Projects", "shop"), "C:\\Users\\dev\\Projects\\shop");
  assert.equal(join("C:\\", "Users"), "C:\\Users");
  assert.equal(pathSeparator("C:\\Users\\dev"), "\\");
  assert.equal(trimTrailingPathSeparators("C:\\"), "C:\\");
  assert.equal(isPathRoot("C:\\"), true);
});

test("POSIX project paths keep their existing behavior", () => {
  assert.equal(dirname("/home/me/work/shop"), "/home/me/work");
  assert.equal(basename("/home/me/work/shop/"), "shop");
  assert.equal(join("/home/me/work", "shop"), "/home/me/work/shop");
});
