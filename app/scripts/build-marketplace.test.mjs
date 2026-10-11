// The listing build and a plugin's helper: its manifest's words are carried
// into the listing, and the builds of a helper this repository makes are
// listed by the checksums of the files that are released, never by ones
// someone typed. Run on fixture plugins (testdata/marketplace), into a
// folder of the test's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "build-marketplace.mjs");
const fixtures = join(import.meta.dirname, "testdata", "marketplace");
const PLATFORMS = ["linux-amd64", "linux-arm64", "darwin-arm64", "darwin-amd64"];

function run(...args) {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// builds writes a stand-in for each platform's build of berth-leadline.
function builds(dir, mark = "") {
  mkdirSync(dir, { recursive: true });
  const sums = {};
  for (const platform of PLATFORMS) {
    const data = Buffer.from(`the build of berth-leadline for ${platform}${mark}\n`);
    writeFileSync(join(dir, `berth-leadline-${platform}`), data);
    sums[platform] = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  }
  return sums;
}

const read = (...path) => JSON.parse(readFileSync(join(...path), "utf8"));

test("a helper is listed with the checksums of its released builds", () => {
  const tmp = mkdtempSync(join(tmpdir(), "berth-marketplace-test-"));
  try {
    const out = join(tmp, "site");
    const bin = join(tmp, "bin");
    const sums = builds(bin);
    const source = read(fixtures, "acme-traces", "berth-plugin.json").box.helper;

    // Released: the four builds are there, and are what is listed.
    let r = run("--plugins", fixtures, "--out", out, "--helper-bin", bin);
    assert.equal(r.code, 0, r.out);
    const manifest = read(out, "acme-traces", "1.2.0", "berth-plugin.json");
    assert.equal(manifest.marketplace, undefined);
    const helper = manifest.box.helper;
    // The manifest's own words, as they were written.
    for (const key of ["name", "version", "args", "ready", "attach", "attach_env"]) assert.deepEqual(helper[key], source[key], key);
    // Its builds: every platform, at the release's address, by the files'
    // own checksums. What the plugin's manifest said of them is gone.
    assert.deepEqual(Object.keys(helper.assets), PLATFORMS);
    for (const platform of PLATFORMS) {
      assert.deepEqual(helper.assets[platform], {
        url: `https://github.com/cosscom/shipyard/releases/download/leadline-helper-v0.3.0/berth-leadline-${platform}`,
        ...sums[platform],
      });
    }
    // The listing names the manifest by its bytes, so the checksums in it
    // are part of what a person allows.
    const index = read(out, "index.json");
    const listed = index.plugins.find((p) => p.id === "acme-traces").files.find((f) => f.path === "berth-plugin.json");
    const bytes = readFileSync(join(out, "acme-traces", "1.2.0", "berth-plugin.json"));
    assert.equal(listed.sha256, createHash("sha256").update(bytes).digest("hex"));
    // A helper built somewhere else keeps the builds its plugin names.
    assert.deepEqual(read(out, "acme-own", "2.0.0", "berth-plugin.json").box.helper, read(fixtures, "acme-own", "berth-plugin.json").box.helper);

    // The listing is rebuilt and checked without the builds: the released
    // checksums are kept as they are.
    rmSync(bin, { recursive: true });
    r = run("--plugins", fixtures, "--out", out, "--check");
    assert.equal(r.code, 0, r.out);
    r = run("--plugins", fixtures, "--out", out);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(read(out, "acme-traces", "1.2.0", "berth-plugin.json"), manifest);

    // Other builds under a version that is released are refused: the
    // version has to change with them.
    builds(bin, ", built again");
    r = run("--plugins", fixtures, "--out", out, "--helper-bin", bin);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /already listed with other checksums/);
    assert.deepEqual(read(out, "acme-traces", "1.2.0", "berth-plugin.json"), manifest);

    // A build that is missing stops a release.
    rmSync(join(bin, "berth-leadline-darwin-amd64"));
    r = run("--plugins", fixtures, "--out", join(tmp, "site-2"), "--helper-bin", bin);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /berth-leadline-darwin-amd64 is not there/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a helper with no release yet is listed with no builds", () => {
  const tmp = mkdtempSync(join(tmpdir(), "berth-marketplace-test-"));
  try {
    const out = join(tmp, "site");
    let r = run("--plugins", fixtures, "--out", out);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /berth-leadline 0\.3\.0 has no released builds yet/);
    // Never the placeholder the plugin's manifest was written with.
    assert.deepEqual(read(out, "acme-traces", "1.2.0", "berth-plugin.json").box.helper.assets, {});
    r = run("--plugins", fixtures, "--out", out, "--check");
    assert.equal(r.code, 0, r.out);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a helper's own builds are checked", () => {
  const tmp = mkdtempSync(join(tmpdir(), "berth-marketplace-test-"));
  try {
    const good = read(fixtures, "acme-own", "berth-plugin.json");
    const asset = good.box.helper.assets["linux-amd64"];
    const cases = {
      "plain http": [{ "linux-amd64": { ...asset, url: "http://downloads.acme.example/acme-helper" } }, /plain https:\/\/ address/],
      "a password in the address": [{ "linux-amd64": { ...asset, url: "https://user:pw@downloads.acme.example/acme-helper" } }, /plain https:\/\/ address/],
      "no checksum": [{ "linux-amd64": { ...asset, sha256: "" } }, /no SHA-256 checksum/],
      "no size": [{ "linux-amd64": { ...asset, size: 0 } }, /size must be between/],
      "a platform nothing runs": [{ "plan9-mips": asset }, /is not a platform/],
      "no builds at all": [undefined, /assets must be an object/],
    };
    let n = 0;
    for (const [what, [assets, message]] of Object.entries(cases)) {
      const plugins = join(tmp, `plugins-${n++}`);
      cpSync(join(fixtures, "acme-own"), join(plugins, "acme-own"), { recursive: true });
      const m = structuredClone(good);
      m.box.helper.assets = assets;
      writeFileSync(join(plugins, "acme-own", "berth-plugin.json"), JSON.stringify(m));
      const r = run("--plugins", plugins, "--out", join(tmp, "site"));
      assert.equal(r.code, 1, `${what}: ${r.out}`);
      assert.match(r.out, message, what);
    }
    // And a helper's name is a file's name, nothing more.
    const plugins = join(tmp, "plugins-name");
    cpSync(join(fixtures, "acme-own"), join(plugins, "acme-own"), { recursive: true });
    const m = structuredClone(good);
    m.box.helper.name = "../acme-helper";
    writeFileSync(join(plugins, "acme-own", "berth-plugin.json"), JSON.stringify(m));
    const r = run("--plugins", plugins, "--out", join(tmp, "site"));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /helper's name/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
