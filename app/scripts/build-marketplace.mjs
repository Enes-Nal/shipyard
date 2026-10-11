// Builds the plugin listing people browse in Settings → Plugins: every
// plugins/<id>/ whose berth-plugin.json says "marketplace": true becomes
// site/plugins/<id>/<version>/ (its manifest, its main module, and any
// themes and kits the manifest names), and site/plugins/index.json lists
// them with each file's size and SHA-256. The laptop agent reads that index
// from the public site and installs from it (internal/agent/marketplace.go).
//
// site/plugins/ is committed, like site/demo/: publishing a plugin is running
// this and committing what it wrote. Bump the plugin's version when its code
// changes; the folder is rebuilt from nothing each time, so the listing is
// only ever what the sources build.
//
// The bundle is built as a plugin in ~/.berth/plugins is: React and the
// Shipyard SDK stay external, and it is not minified, so the code a person is
// asked to allow can be read.
//
//   node scripts/build-marketplace.mjs           build site/plugins/
//   node scripts/build-marketplace.mjs --check   fail if site/plugins/ is not what the sources build
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..", "..", "plugins");
const site = resolve(import.meta.dirname, "..", "..", "site", "plugins");
// Packages a plugin bundles (not React or the SDK) come from the app's.
const nodePaths = [resolve(import.meta.dirname, "..", "node_modules")];
const check = process.argv.includes("--check");
const MANIFEST = "berth-plugin.json";

// The same limits the agent holds a listing to.
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const MAX_FILE = 16 << 20;

function fail(message) {
  console.error(`build-marketplace: ${message}`);
  process.exit(1);
}

// inside is a path the manifest names, kept inside the plugin's folder.
function inside(id, rel) {
  const clean = posix.normalize(String(rel));
  if (!clean || clean.startsWith("..") || posix.isAbsolute(clean) || clean.includes("\\")) fail(`${id}: ${rel} is not a path inside the plugin's folder`);
  return clean.replace(/\/$/, "");
}

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, base)));
    else if (e.isFile()) out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

async function buildAll(out) {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const plugins = [];
  const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  for (const dir of dirs) {
    let m;
    try {
      m = JSON.parse(await readFile(join(root, dir.name, MANIFEST), "utf8"));
    } catch {
      continue;
    }
    if (!m.marketplace) continue;
    const id = m.id ?? dir.name;
    if (!ID.test(id)) fail(`${dir.name}: the id ${JSON.stringify(id)} must be lowercase letters, digits and dashes`);
    if (m.builtin) fail(`${id}: a plugin is built in or in the marketplace, not both`);
    if (!VERSION.test(m.version ?? "")) fail(`${id}: its ${MANIFEST} needs a version`);
    if (plugins.some((p) => p.id === id)) fail(`${id}: listed twice`);
    const main = inside(id, m.main ?? "dist/index.js");
    const target = join(out, id, m.version);
    await mkdir(target, { recursive: true });

    await build({
      // From the plugin's own folder, so the bundle is the same wherever
      // this runs from.
      absWorkingDir: join(root, dir.name),
      entryPoints: ["src/index.tsx"],
      bundle: true,
      format: "esm",
      jsx: "automatic",
      // A plugin can carry a script it runs on boxes as text.
      loader: { ".py": "text", ".sh": "text" },
      target: "es2022",
      external: ["react", "react/jsx-runtime", "react-dom", "@berth/plugin", "@berth/plugin/ui"],
      outfile: join(target, main),
      nodePaths,
      logLevel: "warning",
    });
    for (const rel of [...(m.themes ?? []), ...(m.kits ?? [])]) {
      const clean = inside(id, rel);
      await mkdir(dirname(join(target, clean)), { recursive: true });
      await cp(join(root, dir.name, clean), join(target, clean), { recursive: true });
    }
    // The manifest as it is installed: "marketplace" is about this
    // repository, not about the plugin.
    const { marketplace, ...manifest } = { ...m, id, main };
    await writeFile(join(target, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");

    const files = [];
    for (const path of await walk(target)) {
      const data = await readFile(join(target, path));
      if (data.length > MAX_FILE) fail(`${id}: ${path} is larger than ${MAX_FILE >> 20} MB`);
      files.push({ path, url: `${id}/${m.version}/${path}`, sha256: createHash("sha256").update(data).digest("hex"), size: data.length });
    }
    plugins.push({ id, name: m.name ?? id, description: m.description, version: m.version, author: m.author, homepage: m.homepage, files });
  }
  await writeFile(join(out, "index.json"), JSON.stringify({ plugins }, null, 2) + "\n");
  return plugins;
}

if (check) {
  const tmp = await mkdtemp(join(tmpdir(), "berth-marketplace-"));
  try {
    await buildAll(tmp);
    const [want, have] = await Promise.all([walk(tmp), walk(site).catch(() => [])]);
    const stale = new Set([...want.filter((p) => !have.includes(p)), ...have.filter((p) => !want.includes(p))]);
    for (const p of want.filter((p) => have.includes(p))) {
      if (!(await readFile(join(tmp, p))).equals(await readFile(join(site, p)))) stale.add(p);
    }
    if (stale.size) fail(`site/plugins/ is not what plugins/ builds (${[...stale].sort().join(", ")}). Run pnpm -C app build:marketplace and commit it.`);
    console.log("marketplace: site/plugins/ is up to date");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
} else {
  const plugins = await buildAll(site);
  console.log(`marketplace: ${plugins.map((p) => `${p.id} ${p.version}`).join(", ") || "none"}`);
}
