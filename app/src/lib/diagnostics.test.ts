// node --experimental-strip-types --test src/lib/diagnostics.test.ts (pnpm test)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type Diagnostics, formatDiagnostics, redact } from "./diagnostics-format.ts";

const testdata = new URL("../../../internal/doctor/testdata/", import.meta.url);

// Copy diagnostics and `berth doctor --report` print the same text: both
// are held to the one golden file (internal/doctor/report_test.go).
test("the app's report is the CLI's, byte for byte", () => {
  const d = JSON.parse(readFileSync(new URL("diagnostics.json", testdata), "utf8")) as Diagnostics;
  // Git may check this fixture out with CRLF on Windows, while the app and Go
  // formatter intentionally emit portable LF-delimited diagnostics.
  const golden = readFileSync(new URL("diagnostics.golden", testdata), "utf8").replaceAll("\r\n", "\n");
  const got = formatDiagnostics(d);
  assert.equal(got, golden);
  for (const secret of ["alex", "/home/other", "example.com", "op://Private", "ghp_", "sk-ant", "eyJhbGci"]) assert.ok(!got.includes(secret), `the report still has ${secret}`);
  assert.ok(got.split("\n").length <= 61, "the report should paste into a chat (about 60 lines)");
});

// The same table as internal/doctor/report_test.go's TestRedact.
test("redact takes out homes, references, emails and tokens, and keeps the rest", () => {
  const cases: [string, string, string][] = [
    ["/Users/sean/.local/bin/claude", "/Users/sean", "~/.local/bin/claude"],
    ["PATH=/Users/sean/bin:/home/me/bin:/usr/bin", "", "PATH=~/bin:~/bin:/usr/bin"],
    ["C:\\Users\\Sean\\bin", "", "~\\bin"],
    ["key op://Private/OpenAI/credential here", "", "key op://[redacted] here"],
    ["signed out as sean@cal.com.", "", "signed out as [email]."],
    ["git clone https://sean:s3cret@github.com/acme/shop.git", "", "git clone https://[redacted]@github.com/acme/shop.git"],
    ["http://127.0.0.1:1378/?token=4f9a2b&agent=x", "", "http://127.0.0.1:1378/?token=[redacted]&agent=x"],
    ['{"token":"abc123","name":"x"}', "", '{"token":"[redacted]","name":"x"}'],
    ["API_KEY: hunter2", "", "API_KEY: [redacted]"],
    ["Authorization: Bearer eyJhbGciOi.payload.sig", "", "Authorization: Bearer [redacted]"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", "", "[redacted] leaked"],
    ["build b9758a308077 · sha256:9f2c…", "", "build b9758a308077 · sha256:9f2c…"],
    ["node_modules/.bin/agent-browser-linux-x64/daemon", "", "node_modules/.bin/agent-browser-linux-x64/daemon"],
    ["internationalization-and-localization-settings", "", "internationalization-and-localization-settings"],
    ["12345678901234567890123456789012345", "", "12345678901234567890123456789012345"],
    ["7.1k tokens · berth ui-token", "", "7.1k tokens · berth ui-token"],
  ];
  for (const [input, home, want] of cases) assert.equal(redact(input, home), want, input);
});
