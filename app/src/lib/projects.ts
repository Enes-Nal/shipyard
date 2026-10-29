import type { Client, Location } from "@/lib/api";
import { isWslBox } from "@/lib/local-box";
import { toWslPath } from "@/lib/wsl-path";

// onBox is a path as the box knows it: E:\Code on this PC's WSL box is
// /mnt/e/Code there.
const onBox = (box: string, path: string) => (isWslBox(box) ? toWslPath(path) : path);
const onBoxMaybe = (box: string, path?: string) => (path ? onBox(box, path) : path);

// The box calls behind adding projects and making worktrees: browse folders,
// clone, create, list branches, and resolve what someone typed (a name, a
// branch, #1234, a GitHub or GitLab URL) into a worktree to make.

const enc = encodeURIComponent;

export interface FsEntry {
  name: string;
  path: string;
  git?: boolean;
  // owner/name on a forge, for a repository with such an origin.
  slug?: string;
}

export interface FsListing {
  path: string;
  parent?: string;
  home: string;
  entries: FsEntry[];
}

export type ResolveKind = "smart" | "github" | "gitlab" | "branch" | "name";

export interface Resolution {
  kind: "pr" | "issue" | "branch" | "remote-branch" | "name";
  // The worktree's name and the branch it checks out or creates.
  name: string;
  branch: string;
  base?: string;
  pr?: number;
  // The ref the box fetches for a pull or merge request, like pull/9035/head.
  ref?: string;
  title?: string;
  url?: string;
  // True when the branch already exists, locally or on origin.
  exists?: boolean;
  // Why the box fell back to something simpler, if it did.
  note?: string;
}

export interface Branch {
  name: string;
  remote?: boolean;
  current?: boolean;
}

export const projectsApi = {
  list: (c: Client, box: string, path: string, hidden = false) => c.box<FsListing>(box, "GET", `fs?${new URLSearchParams({ path: onBox(box, path), ...(hidden ? { hidden: "1" } : {}) })}`),
  create: (c: Client, box: string, name: string, parent?: string) => c.box<Location>(box, "POST", "locations/new", { name, parent: onBoxMaybe(box, parent) || undefined }),
  add: (c: Client, box: string, name: string, path: string) => c.box<Location>(box, "POST", "locations", { name, path: onBox(box, path) }),
  resolve: (c: Client, box: string, location: string, input: string, kind: ResolveKind) => c.box<Resolution>(box, "POST", `locations/${enc(location)}/resolve`, { input, kind }),
  branches: (c: Client, box: string, location: string) => c.box<{ default?: string; branches: Branch[] | null }>(box, "GET", `locations/${enc(location)}/branches`),

  // clone streams git's progress to onLine and resolves with the new
  // location once the box has added it.
  async clone(c: Client, box: string, req: { url: string; parent?: string; name?: string }, onLine: (line: string) => void, signal?: AbortSignal): Promise<Location> {
    let location: Location | undefined;
    let failure: string | undefined;
    await c.stream(
      "POST",
      `/v1/boxes/${enc(box)}/api/locations/clone`,
      { ...req, parent: onBoxMaybe(box, req.parent) },
      (v) => {
        const m = v as { line?: string; done?: boolean; error?: string; location?: Location };
        if (m.line !== undefined) onLine(m.line);
        if (m.done) {
          failure = m.error;
          location = m.location;
        }
      },
      signal,
    );
    if (failure) throw new Error(failure);
    if (!location) throw new Error(signal?.aborted ? "cancelled" : "The box stopped answering before the clone finished.");
    return location;
  },
};

// repoName guesses a project's name from a clone URL:
// git@github.com:acme/shop.git → shop.
export function repoName(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

// A location's name must be a safe single path word for the box.
export const locationName = (s: string) =>
  s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 48);

// worktreeSlug is what git and the box accept as a worktree name.
export const worktreeSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

// describe is the one line under the input that says what will happen.
export function describe(r: Resolution): string {
  const title = r.title ? ` · "${r.title}"` : "";
  switch (r.kind) {
    case "pr":
      return `PR #${r.pr}${title} · branch ${r.branch}`;
    case "issue": {
      const n = /\/(?:issues|-\/issues)\/(\d+)/.exec(r.url ?? "")?.[1];
      return `Issue${n ? ` #${n}` : ""}${r.title ? ` "${r.title}"` : ""} → new branch ${r.branch}${r.base ? ` from ${r.base}` : ""}`;
    }
    case "branch":
      return r.exists === false ? `New branch ${r.branch}${r.base ? ` from ${r.base}` : ""}` : `Existing branch ${r.branch}`;
    case "remote-branch":
      return `Remote branch origin/${r.branch}, tracked as ${r.branch}`;
    default:
      return `New branch ${r.branch}${r.base ? ` from ${r.base}` : ""}`;
  }
}

// promptFor is the first prompt for an agent starting on an issue or PR.
export function promptFor(r: Resolution): string {
  if (r.kind === "issue") return `Work on ${r.url ?? "the issue"}${r.title ? `: ${r.title}` : ""}.\n\nRead it first, then plan the change before editing.`;
  if (r.kind === "pr") return `Pick up PR #${r.pr}${r.title ? ` (${r.title})` : ""}${r.url ? ` ${r.url}` : ""}. Read its description and review comments, then continue the work.`;
  return "";
}

// A project is one repository, wherever it is checked out: the same slug on
// several boxes is one project. Locations without a forge slug are their own
// project, by name.
export const projectKey = (loc: Pick<Location, "name" | "slug">) => (loc.slug ? loc.slug.toLowerCase() : `name:${loc.name}`);

// What the person set about a project, kept by the laptop agent
// (/v1/app/projects): its display name, group, and the box new worktrees
// go to by default.
export interface AppProject {
  id: string;
  name?: string;
  group?: string;
  default_box?: string;
  [extra: string]: unknown;
}

export interface AppProjects {
  projects: AppProject[];
  [extra: string]: unknown;
}

export const appProjectsApi = {
  get: async (c: Client): Promise<AppProjects> => {
    const doc = await c.laptop<AppProjects | null>("GET", "/v1/app/projects");
    return { ...doc, projects: doc?.projects ?? [] };
  },
  // setDefaultBox changes one project's default box, re-reading the document
  // first so other fields and other projects stay as they are.
  async setDefaultBox(c: Client, id: string, box: string): Promise<AppProjects> {
    const doc = await appProjectsApi.get(c);
    const has = doc.projects.some((p) => p.id === id);
    const projects = has ? doc.projects.map((p) => (p.id === id ? { ...p, default_box: box } : p)) : [...doc.projects, { id, default_box: box }];
    const next = { ...doc, projects };
    await c.laptop("PUT", "/v1/app/projects", next);
    return next;
  },
};

// What a project is across boxes (grouping, merges, sections) is in
// lib/project-groups, built on projectKey and appProjectsApi above.
export * from "@/lib/project-groups";
