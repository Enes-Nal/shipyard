import { locationName, repoName } from "@/lib/projects";
import { basename, dirname, hasTrailingPathSeparator, isPathRoot, isWindowsPath, join, pathSeparator, trimTrailingPathSeparators } from "@/lib/box-path";

export { basename, dirname, hasTrailingPathSeparator, isPathRoot, isWindowsPath, join, pathSeparator, trimTrailingPathSeparators };

// What someone typed into Add a project, before the box has looked:
//
//   ~/work/app, /srv/app      a path on the box: add it, or create it
//   git@…, https://…/o/r      a repository: clone it
//   github.com/o/r/pull/12    the same, from a pull request or issue link,
//                             which then opens as a worktree
//   acme/shop                 owner/repo on GitHub: clone it
//   new-thing                 a name: an existing project or folder by that
//                             name, or a new repository
//
// The box then says what is actually there (use-plan.ts).

export interface Link {
  kind: "pr" | "issue";
  n: number;
  url: string;
}

export type Intent =
  | { kind: "empty" }
  | { kind: "path"; text: string }
  | { kind: "repo"; url: string; display: string; slug?: string; folder: string; link?: Link }
  | { kind: "name"; name: string };

const OWNER_REPO = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const SCP = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/;
const HOSTED = /^(?:(https?|ssh|git):\/\/)?(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+(?::\d+)?)\/(.+)$/i;

export function classify(raw: string): Intent {
  const t = raw.trim();
  if (!t) return { kind: "empty" };
  if (t === "~" || /^(?:~[\\/]|[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/])/.test(t)) return { kind: "path", text: t };

  const scp = SCP.exec(t);
  if (scp) return repo(t, scp[1], scp[2]);

  const hosted = HOSTED.exec(t);
  if (hosted && (hosted[1] || /\.[a-z]{2,}(:\d+)?$/i.test(hosted[2]))) {
    const host = hosted[2];
    const rest = hosted[3].replace(/\/+$/, "");
    // GitLab puts "/-/" between the repository and everything else; GitHub
    // and most others have owner/name first.
    const twoParts = /(^|\.)github\.com$/i.test(host) || /\/(pull|pulls|issues|tree|blob|commit)\//.test(rest);
    const cut = rest.includes("/-/") ? rest.split("/-/")[0] : twoParts ? rest.split("/").slice(0, 2).join("/") : rest;
    const path = cut.replace(/\.git$/, "");
    if (path.split("/").length < 2) return { kind: "name", name: t };
    const link = linkIn(t);
    // Keep the URL as typed when it is already a clone URL; a web link
    // becomes the repository's https URL.
    const url = link || rest !== cut ? `https://${host}/${path}` : hosted[1] ? t : `https://${host}/${path}`;
    return repo(url, host, path, link);
  }

  const or = OWNER_REPO.exec(t);
  if (or) return repo(`https://github.com/${or[1]}/${or[2]}.git`, "github.com", `${or[1]}/${or[2]}`);

  return { kind: "name", name: t };
}

function repo(url: string, host: string, path: string, link?: Link): Intent {
  const parts = path.replace(/\.git$/, "").split("/").filter(Boolean);
  const slug = parts.length >= 2 ? parts.slice(-2).join("/") : undefined;
  return { kind: "repo", url, display: `${host.replace(/:\d+$/, "")}/${parts.join("/")}`, slug, folder: locationName(repoName(path)) || "repo", link };
}

function linkIn(url: string): Link | undefined {
  const pr = /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url);
  if (pr) return { kind: "pr", n: Number(pr[1]), url };
  const issue = /\/issues\/(\d+)/.exec(url);
  if (issue) return { kind: "issue", n: Number(issue[1]), url };
  return undefined;
}

// A folder name the box accepts for clone and create.
export const validFolder = (s: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s);
