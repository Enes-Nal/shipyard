import { useCallback, useEffect, useRef, useState } from "react";

import { basename, classify, dirname, hasTrailingPathSeparator, type Intent, isPathRoot, join, type Link, pathSeparator, trimTrailingPathSeparators, validFolder } from "@/components/add-project/intent";
import { shortPath, uniqueName } from "@/components/add-project/unique-name";
import type { Location } from "@/lib/api";
import { type FsEntry, type FsListing, locationName, projectsApi } from "@/lib/projects";
import { useStore } from "@/lib/store";

// usePlan turns what was typed into what will happen on the box, by looking:
// the box lists the folders involved, and the projects it already has are
// checked, so the line under the field says exactly what Enter does. It also
// offers rows to pick from: folders on the box, and projects on other boxes
// that this one does not have yet.

export type Plan =
  | { do: "open"; loc: Location; link?: Link; note?: string }
  // path is the folder's full path on the box.
  | { do: "add"; path: string; name: string; git: boolean; slug?: string; note?: string }
  | { do: "clone"; url: string; display: string; parent: string; folder: string; slug?: string; link?: Link }
  | { do: "create"; parent: string; folder: string }
  // A folder typed with a trailing slash: a place to look in, as in a
  // shell, not something to add. Its folders are the rows; Enter takes one.
  | { do: "look"; path: string }
  | { do: "blocked"; message: string };

export interface Row {
  key: string;
  // repo: a git folder not added yet; project: one already added here;
  // folder: any other folder; elsewhere: a project on another box; new: the
  // folder the plan will make, shown among its neighbours.
  kind: "repo" | "project" | "folder" | "elsewhere" | "new";
  group: string;
  title: string;
  detail?: string;
  badge?: string;
  // What the field becomes when the row is completed with Tab.
  fill: string;
  entry?: FsEntry;
  loc?: Location;
}

export interface Destination {
  parent?: string;
  folder?: string;
}

export function usePlan(box: string, input: string, dest: Destination, enabled: boolean) {
  const cache = useRef(new Map<string, Promise<FsListing>>());
  const [base, setBase] = useState<string>();
  const [home, setHome] = useState<string>();
  const [state, setState] = useState<{ plan?: Plan; rows: Row[]; for: string }>({ rows: [], for: "" });
  const [pending, setPending] = useState(false);
  const seq = useRef(0);
  const locs = useStore((s) => s.boxes[box]?.locations);

  const ls = useCallback(
    (path: string) => {
      let p = cache.current.get(path);
      if (!p) {
        const client = useStore.getState().client;
        if (!client) return Promise.reject(new Error("not connected"));
        p = projectsApi.list(client, box, path);
        cache.current.set(path, p);
        // A failed listing may succeed later (a folder made meanwhile).
        p.catch(() => cache.current.delete(path));
      }
      return p;
    },
    [box],
  );

  // Where projects live on this box: ~/work when it is there, else home.
  useEffect(() => {
    cache.current = new Map();
    setBase(undefined);
    if (!enabled) return;
    let live = true;
    ls("~/work")
      .then((l) => live && (setBase("~/work"), setHome(l.home)))
      .catch(() =>
        ls("~")
          .then((l) => live && (setBase("~"), setHome(l.home)))
          .catch(() => live && setBase("~")),
      );
    return () => {
      live = false;
    };
  }, [box, enabled, ls]);

  const intent = classify(input);
  const key = JSON.stringify([input.trim(), dest.parent, dest.folder, base, locs?.length]);

  useEffect(() => {
    if (!enabled || base === undefined) return;
    const n = ++seq.current;
    setPending(true);
    const t = setTimeout(
      async () => {
        const ctx: Ctx = { box, base, home, locs: locs ?? [], ls, dest };
        let out: { plan?: Plan; rows: Row[] };
        try {
          out = await resolve(intent, ctx);
        } catch (err) {
          out = { plan: { do: "blocked", message: err instanceof Error ? err.message : String(err) }, rows: [] };
        }
        if (n !== seq.current) return;
        setState({ ...out, for: key });
        setPending(false);
      },
      input.trim() ? 160 : 0,
    );
    return () => clearTimeout(t);
    // key covers input, dest, base and the box's projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, box]);

  // While the box looks, the last answer stays up (marked pending) rather
  // than blinking away on every keystroke.
  return { intent, plan: state.plan, rows: state.rows, pending: pending || state.for !== key, base: base ?? "~/work", home };
}

interface Ctx {
  box: string;
  base: string;
  home?: string;
  locs: Location[];
  ls(path: string): Promise<FsListing>;
  dest: Destination;
}

async function resolve(intent: Intent, ctx: Ctx): Promise<{ plan?: Plan; rows: Row[] }> {
  switch (intent.kind) {
    case "empty":
      // Projects this box lacks but another box has come first: few, and
      // the likeliest reason to be here.
      return { rows: [...elsewhereRows(ctx, () => true), ...(await folderRows(ctx, ctx.base, () => true, true))] };
    case "path":
      return resolvePath(intent.text, ctx);
    case "repo":
      return resolveRepo(intent, ctx);
    case "name":
      return resolveName(intent.name, ctx);
  }
}

async function resolvePath(text: string, ctx: Ctx): Promise<{ plan?: Plan; rows: Row[] }> {
  const { box, ls } = ctx;
  const norm = trimTrailingPathSeparators(text) || "/";
  const drill = hasTrailingPathSeparator(text) && text !== norm;
  if (norm === "~" || isPathRoot(norm)) {
    return { rows: await folderRows(ctx, norm, () => true) };
  }
  const parent = dirname(norm);
  const name = basename(norm);
  let pl: FsListing;
  try {
    pl = await ls(parent);
  } catch {
    return { plan: { do: "blocked", message: `There is no folder ${parent} on ${box}.` }, rows: [] };
  }
  const entry = pl.entries.find((e) => e.name === name);
  const where = shortPath(pl.path, pl.home);
  if (entry) {
    const rows = drill ? await folderRows(ctx, entry.path, () => true).catch(() => []) : rowsFrom(ctx, pl, (e) => e.name !== name && e.name.toLowerCase().startsWith(name.toLowerCase()));
    // "~/work/" is the inside of ~/work, not ~/work: only a repository or a
    // project there is taken as it is.
    if (drill && !entry.git && !ctx.locs.some((l) => l.path === entry.path)) return { plan: { do: "look", path: join(where, name) }, rows };
    return { plan: planFor(entry, ctx), rows };
  }
  const rows = rowsFrom(ctx, pl, (e) => e.name.toLowerCase().startsWith(name.toLowerCase()));
  if (drill) return { plan: { do: "blocked", message: `There is no folder ${join(where, name)} on ${box}.` }, rows };
  if (!validFolder(name)) return { plan: { do: "blocked", message: `“${name}” can't be a folder name: letters, digits, dot, dash and underscore.` }, rows };
  return { plan: { do: "create", parent: where, folder: name }, rows: withNew(rows.length ? rows : rowsFrom(ctx, pl, () => true), where, name) };
}

async function resolveRepo(intent: Extract<Intent, { kind: "repo" }>, ctx: Ctx): Promise<{ plan?: Plan; rows: Row[] }> {
  const { box, base, ls, dest, locs } = ctx;
  const same = (s?: string) => !!s && !!intent.slug && s.toLowerCase() === intent.slug.toLowerCase();
  const here = locs.find((l) => same(l.slug));
  if (here) return { plan: { do: "open", loc: here, link: intent.link, note: `${intent.slug} is already on ${box}` }, rows: await folderRows(ctx, dirname(here.path), () => true) };
  const parent = (dest.parent ?? "").trim() || base;
  const folder = (dest.folder ?? "").trim() || intent.folder;
  if (!validFolder(folder)) return { plan: { do: "blocked", message: `“${folder}” can't be a folder name.` }, rows: [] };
  const pl = await ls(parent).catch(() => undefined);
  const hit = pl?.entries.find((e) => e.name === folder);
  if (hit) {
    const rows = rowsFrom(ctx, pl!, () => true);
    if (hit.git && same(hit.slug)) return { plan: { ...(planFor(hit, ctx) as Extract<Plan, { do: "add" }>), note: "Already cloned there; added as it is." }, rows };
    return { plan: { do: "blocked", message: `${join(parent, folder)} already exists on ${box}. Pick another folder name.` }, rows };
  }
  const where = pl ? shortPath(pl.path, pl.home) : parent;
  return { plan: { do: "clone", url: intent.url, display: intent.display, parent, folder, slug: intent.slug, link: intent.link }, rows: withNew(pl ? rowsFrom(ctx, pl, () => true) : [], where, folder) };
}

async function resolveName(name: string, ctx: Ctx): Promise<{ plan?: Plan; rows: Row[] }> {
  const { box, base, ls, locs } = ctx;
  const clean = locationName(name);
  const q = name.toLowerCase();
  const loc = locs.find((l) => l.name === name || l.name === clean);
  const bl = await ls(base).catch(() => undefined);
  const match = (e: FsEntry) => e.name.toLowerCase().includes(q);
  const rows = [...(bl ? rowsFrom(ctx, bl, (e) => match(e) && e.name !== clean) : []), ...elsewhereRows(ctx, (l) => l.name.toLowerCase().includes(q) || !!l.slug?.toLowerCase().includes(q))];
  if (loc) return { plan: { do: "open", loc, note: `Already a project on ${box}` }, rows: rows.length ? rows : await folderRows(ctx, dirname(loc.path), () => true) };
  const entry = bl?.entries.find((e) => e.name === name || e.name === clean);
  if (entry) return { plan: planFor(entry, ctx), rows };
  if (!clean || !validFolder(clean)) return { plan: { do: "blocked", message: `“${name}” can't be a folder name.` }, rows };
  const parent = bl ? shortPath(bl.path, bl.home) : base;
  return { plan: { do: "create", parent, folder: clean }, rows: rows.length ? rows : withNew(bl ? rowsFrom(ctx, bl, () => true) : [], parent, clean) };
}

function planFor(e: FsEntry, ctx: Ctx): Plan {
  const loc = ctx.locs.find((l) => l.path === e.path);
  if (loc) return { do: "open", loc, note: `Already a project on ${ctx.box}` };
  return { do: "add", path: e.path, name: uniqueName(ctx.box, e.name), git: !!e.git, slug: e.slug };
}

async function folderRows(ctx: Ctx, path: string, keep: (e: FsEntry) => boolean, likely = false): Promise<Row[]> {
  const l = await ctx.ls(path).catch(() => undefined);
  if (!l) return [];
  return rowsFrom(ctx, l, keep, likely);
}

// rowsFrom lists a folder's entries as rows: repositories not added yet
// first, then projects already here, then plain folders.
function rowsFrom(ctx: Ctx, l: FsListing, keep: (e: FsEntry) => boolean, likely = false): Row[] {
  const where = shortPath(l.path, l.home);
  const group = likely ? `On ${ctx.box} · ${where}` : `In ${where}`;
  const rank = (r: Row) => ({ repo: 0, project: 1, folder: 2, elsewhere: 3, new: 0 })[r.kind];
  return l.entries
    .filter(keep)
    .map((e): Row => {
      const loc = ctx.locs.find((x) => x.path === e.path);
      const kind = loc ? "project" : e.git ? "repo" : "folder";
      const path = join(where, e.name);
      return { key: e.path, kind, group, title: e.name, detail: e.slug, badge: loc ? "added" : undefined, fill: kind === "folder" ? `${path}${pathSeparator(path)}` : path, entry: e, loc };
    })
    .sort((a, b) => rank(a) - rank(b));
}

// withNew puts the folder a clone or create will make among the folders
// already there, so it is plain where it lands.
function withNew(rows: Row[], where: string, name: string): Row[] {
  const group = rows[0]?.group ?? `In ${where}`;
  const row: Row = { key: `new:${name}`, kind: "new", group, title: name, badge: "new", fill: join(where, name) };
  const sorted = [...rows].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const at = sorted.findIndex((r) => r.title.localeCompare(name, undefined, { sensitivity: "base" }) > 0);
  return at < 0 ? [...sorted, row] : [...sorted.slice(0, at), row, ...sorted.slice(at)];
}

// elsewhereRows are projects on the person's other online boxes that this
// box has not got: a project can live on several boxes, and this is how it
// gets here.
function elsewhereRows(ctx: Ctx, keep: (l: Location) => boolean): Row[] {
  const st = useStore.getState();
  const here = new Set(ctx.locs.map((l) => l.slug?.toLowerCase()).filter(Boolean));
  const seen = new Map<string, Row>();
  for (const b of st.status?.boxes ?? []) {
    if (b.name === ctx.box || b.state !== "online") continue;
    for (const l of st.boxes[b.name]?.locations ?? []) {
      const slug = l.slug?.toLowerCase();
      if (!slug || !l.remote || here.has(slug) || !keep(l)) continue;
      const had = seen.get(slug);
      if (had) had.badge = `${had.badge}, ${b.name}`;
      else seen.set(slug, { key: `elsewhere:${slug}`, kind: "elsewhere", group: "On your other boxes", title: l.name, detail: l.slug, badge: `on ${b.name}`, fill: l.remote, loc: l });
    }
  }
  return [...seen.values()];
}
