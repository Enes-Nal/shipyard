// Builds the plugins that ship with the app: every plugins/<id>/ whose
// berth-plugin.json says "builtin": true becomes one ES module in
// public/builtin-plugins/<id>/, listed in public/builtin-plugins/index.json.
// React and the Terminal SDK stay external: the app provides them at runtime,
// as it does for plugins in ~/.berth/plugins.
//
// A built-in can also keep heavy code out of its main module: each file in
// its src/lazy/ becomes <id>/lazy/<name>.js, code-split into chunks there,
// for the plugin to import() by URL only when it needs it (and a worker to
// start from). React and the SDK in those resolve to the app's own through
// the shims, as no import map reaches a worker.
//
//   node scripts/build-plugins.mjs           build once
//   node scripts/build-plugins.mjs --watch   rebuild on change
import { context, build } from "esbuild";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..", "plugins");
const out = resolve(import.meta.dirname, "..", "public", "builtin-plugins");
const shims = resolve(import.meta.dirname, "..", "public", "shims");
// Packages a plugin bundles (not React or the SDK) come from the app's.
const nodePaths = [resolve(import.meta.dirname, "..", "node_modules")];
const watch = process.argv.includes("--watch");

const manifests = [];
for (const dir of await readdir(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  let m;
  try {
    m = JSON.parse(await readFile(join(root, dir.name, "berth-plugin.json"), "utf8"));
  } catch {
    continue;
  }
  if (!m.builtin) continue;
  // A plugin still being written must not keep the app from starting.
  try {
    await readFile(join(root, dir.name, "src", "index.tsx"));
  } catch {
    console.warn(`skipping built-in plugin ${dir.name}: no src/index.tsx yet`);
    continue;
  }
  manifests.push({ ...m, id: m.id ?? dir.name, dir: dir.name });
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

async function lazyEntries(dir) {
  try {
    const files = await readdir(dir, { withFileTypes: true });
    return files.filter((f) => f.isFile() && /\.(ts|tsx|js)$/.test(f.name) && !f.name.endsWith(".d.ts")).map((f) => ({ in: join(dir, f.name), out: basename(f.name, extname(f.name)) }));
  } catch {
    return [];
  }
}

// Shiki's Oniguruma engine (a 600 KB wasm chunk) is never used: built-ins
// highlight with its JavaScript regex engine, which needs no wasm.
const noWasm = {
  name: "no-shiki-wasm",
  setup(b) {
    b.onResolve({ filter: /^shiki\/wasm$/ }, () => ({ path: "shiki-wasm", namespace: "no-wasm" }));
    b.onLoad({ filter: /.*/, namespace: "no-wasm" }, () => ({ contents: "export default undefined;", loader: "js" }));
  },
};

// A lazy entry that only imports a module (a worker's script) means it,
// even when its package says it has no side effects.
const entryImports = {
  name: "lazy-entry-imports",
  setup(b) {
    b.onResolve({ filter: /.*/ }, async (args) => {
      if (args.pluginData?.entryImport || !/[\\/]src[\\/]lazy[\\/][^\\/]+$/.test(args.importer)) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir, importer: args.importer, pluginData: { entryImport: true } });
      return r.errors.length ? undefined : { ...r, sideEffects: true };
    });
  },
};

const index = [];
for (const m of manifests) {
  const { dir, builtin, ...manifest } = m;
  const target = join(out, m.id);
  await mkdir(target, { recursive: true });
  const options = {
    entryPoints: [join(root, dir, "src", "index.tsx")],
    bundle: true,
    format: "esm",
    jsx: "automatic",
    // A plugin can carry a script it runs on boxes as text.
    loader: { ".py": "text", ".sh": "text" },
    target: "es2022",
    external: ["react", "react/jsx-runtime", "react-dom", "@berth/plugin", "@berth/plugin/ui"],
    outfile: join(target, "index.js"),
    nodePaths,
    logLevel: "warning",
  };
  const lazy = await lazyEntries(join(root, dir, "src", "lazy"));
  const lazyOptions = lazy.length && {
    entryPoints: lazy,
    bundle: true,
    splitting: true,
    format: "esm",
    jsx: "automatic",
    target: "es2022",
    minify: !watch,
    outdir: join(target, "lazy"),
    chunkNames: "chunks/[name]-[hash]",
    alias: {
      react: join(shims, "react.js"),
      "react/jsx-runtime": join(shims, "react-jsx-runtime.js"),
      "react/jsx-dev-runtime": join(shims, "react-jsx-runtime.js"),
      "react-dom": join(shims, "react-dom.js"),
      "@berth/plugin": join(shims, "berth-plugin.js"),
      "@berth/plugin/ui": join(shims, "berth-plugin-ui.js"),
    },
    plugins: [noWasm, entryImports],
    nodePaths,
    logLevel: "warning",
  };
  try {
    if (watch) {
      await (await context(options)).watch();
      if (lazyOptions) await (await context(lazyOptions)).watch();
    } else {
      await build(options);
      if (lazyOptions) await build(lazyOptions);
    }
  } catch (err) {
    console.warn(`skipping built-in plugin ${m.id}: ${err.message.split("\n")[0]}`);
    continue;
  }
  const info = { ...manifest, main: "index.js" };
  await writeFile(join(target, "berth-plugin.json"), JSON.stringify(info, null, 2) + "\n");
  index.push(info);
}
await writeFile(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`built-in plugins: ${index.map((p) => p.id).join(", ") || "none"}${watch ? " (watching)" : ""}`);
