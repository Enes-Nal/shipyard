import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Windows development opens the real app instead of sample fixtures", () => {
  const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.windows.conf.json", import.meta.url), "utf8")) as {
    build?: { devUrl?: string };
  };

  assert.doesNotMatch(config.build?.devUrl ?? "", /[?&]mock=/, "Windows must not force the synthetic workspace");
});
