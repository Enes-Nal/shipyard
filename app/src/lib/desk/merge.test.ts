import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptItem } from "../transcript.ts";
import { mergeItems } from "./merge.ts";

const text = (id: string, t: string) => ({ kind: "text", id, text: t }) as TranscriptItem;

test("mergeItems replaces items the desk sends again and appends the rest", () => {
  const held = [text("a", "one"), text("b", "two")];
  const got = mergeItems(held, {
    items: [text("b", "two, done"), text("c", "three")],
  });
  assert.deepEqual(
    got.map((it) => (it as { text: string }).text),
    ["one", "two, done", "three"],
  );
});

test("mergeItems keeps what it holds when nothing is new", () => {
  assert.equal(mergeItems([text("a", "one")], { items: null }).length, 1);
});

test("mergeItems takes a page read afresh whole", () => {
  const got = mergeItems([text("a", "old")], {
    items: [text("x", "new")],
    reset: true,
  });
  assert.deepEqual(
    got.map((it) => it.id),
    ["x"],
  );
});
