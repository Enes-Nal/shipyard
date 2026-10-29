import assert from "node:assert/strict";
import { test } from "node:test";

import { fromWslPath, isWslDrive, toWslPath } from "./wsl-path.ts";

test("a Windows path is the same folder under /mnt in WSL", () => {
  assert.equal(toWslPath("E:\\Code\\shop"), "/mnt/e/Code/shop");
  assert.equal(toWslPath("e:/Code/shop/"), "/mnt/e/Code/shop");
  assert.equal(toWslPath("C:\\"), "/mnt/c");
  assert.equal(toWslPath("C:"), "/mnt/c");
  assert.equal(toWslPath("  D:\\New folder\\app  "), "/mnt/d/New folder/app");
});

test("Linux paths and names are left alone", () => {
  for (const p of ["~", "~/code/shop", "/home/me", "/mnt/e/Code", "shop", "\\\\server\\share"]) assert.equal(toWslPath(p), p);
});

test("a drive under /mnt reads as Windows", () => {
  assert.equal(fromWslPath("/mnt/e/Code/shop"), "E:\\Code\\shop");
  assert.equal(fromWslPath("/mnt/c"), "C:\\");
  assert.equal(fromWslPath("/mnt/c/"), "C:\\");
  for (const p of ["/mnt", "/mnt/wsl", "/mnt/wslg/x", "/home/me", "~"]) assert.equal(fromWslPath(p), p);
});

test("there and back", () => {
  for (const p of ["E:\\Code\\New folder", "C:\\"]) assert.equal(fromWslPath(toWslPath(p)), p);
});

test("only single letters in /mnt are drives", () => {
  assert.ok(isWslDrive("c"));
  assert.ok(!isWslDrive("wsl"));
  assert.ok(!isWslDrive("wslg"));
});
