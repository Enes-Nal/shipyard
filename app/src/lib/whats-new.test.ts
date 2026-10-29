import assert from "node:assert/strict";
import { test } from "node:test";

import { compareVersions, decide, latestRelease, type Release } from "./whats-new-model.ts";
import { RELEASES } from "./whats-new-releases.ts";

const r = (version: string): Release => ({ version, items: [], also: [] });
const releases = [r("0.3.10"), r("0.4.0")];

test("versions order by their numbers", () => {
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("0.3.9", "0.3.10"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("dev", "0.0.1"), -1);
});

test("a first install shows nothing and has seen this version", () => {
  assert.deepEqual(decide({ firstRun: true, seen: null, current: "0.4.0", releases }), { seen: "0.4.0" });
});

test("an update shows the newest release it includes, once", () => {
  const d = decide({ firstRun: false, seen: "0.3.9", current: "0.4.0", releases });
  assert.equal(d.show?.version, "0.4.0");
  assert.equal(d.seen, "0.4.0");
  // Started again: seen now.
  assert.equal(decide({ firstRun: false, seen: d.seen, current: "0.4.0", releases }).show, undefined);
});

test("a release the app doesn't include yet isn't shown", () => {
  assert.equal(decide({ firstRun: false, seen: "0.3.9", current: "0.3.10", releases }).show?.version, "0.3.10");
  assert.equal(decide({ firstRun: false, seen: "0.3.8", current: "0.3.9", releases }).show, undefined);
});

test("prefs from a Terminal older than the card count as an update", () => {
  assert.equal(decide({ firstRun: false, seen: undefined, current: "0.3.10", releases }).show?.version, "0.3.10");
});

test("an update with no notes of its own shows nothing new", () => {
  assert.equal(decide({ firstRun: false, seen: "0.4.0", current: "0.4.1", releases }).show, undefined);
});

test("seen never moves back to an older build", () => {
  assert.equal(decide({ firstRun: false, seen: "0.4.0", current: "0.3.9", releases }).seen, "0.4.0");
});

test("each release's notes are short and each item leads somewhere", () => {
  assert.ok(latestRelease(RELEASES));
  for (const rel of RELEASES) {
    assert.ok(rel.items.length >= 4 && rel.items.length <= 6, `${rel.version}: 4 to 6 highlights`);
    assert.equal(new Set(rel.items.map((i) => i.id)).size, rel.items.length);
    for (const i of rel.items) {
      assert.ok(i.title.length <= 40, `${i.id}: title is short`);
      assert.ok(i.body.length <= 200, `${i.id}: body is a sentence or two`);
      assert.ok(i.show || i.keys || i.docs, `${i.id}: a Show me, a key or a page`);
    }
  }
});
