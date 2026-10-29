export type ForgeKind = "gitlab" | "github" | "git";

export interface Forge {
  kind: ForgeKind;
  label: string;
  host?: string;
}

// forgeOf recognizes both web and SSH remotes. GitLab installations are
// commonly self-hosted, so hosts containing "gitlab" get the same treatment
// as gitlab.com; every other remote still remains useful as plain Git.
export function forgeOf(remote: string | undefined): Forge {
  const value = remote?.trim();
  if (!value) return { kind: "git", label: "Git" };
  let host: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      host = new URL(value).hostname;
    } catch {
      host = undefined;
    }
  } else {
    host = /^(?:[^@]+@)?([^:/]+):/.exec(value)?.[1];
  }
  const clean = host?.toLowerCase();
  if (clean?.includes("gitlab")) return { kind: "gitlab", label: "GitLab", host };
  if (clean?.includes("github")) return { kind: "github", label: "GitHub", host };
  return { kind: "git", label: host || "Git", host };
}
