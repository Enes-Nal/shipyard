// Folder paths come from the selected box, so they may use POSIX or Windows
// separators regardless of the computer that runs Terminal.
export const isWindowsPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
export const pathSeparator = (path: string) => (isWindowsPath(path) || path.includes("\\") ? "\\" : "/");
export const hasTrailingPathSeparator = (path: string) => /[\\/]$/.test(path);

const windowsRoot = (path: string): string => {
  const sep = pathSeparator(path);
  const drive = /^([A-Za-z]:)[\\/]/.exec(path);
  if (drive) return `${drive[1]}${sep}`;
  const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)/.exec(path);
  return unc?.[1] ?? sep;
};

export const trimTrailingPathSeparators = (path: string): string => {
  if (!path) return path;
  if (!isWindowsPath(path)) return path.replace(/\/+$/, "") || "/";
  const root = windowsRoot(path);
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.length < root.length ? root : trimmed;
};

export const isPathRoot = (path: string): boolean => {
  const trimmed = trimTrailingPathSeparators(path);
  return isWindowsPath(trimmed) ? trimmed === windowsRoot(trimmed) : trimmed === "/";
};

export const dirname = (path: string): string => {
  const trimmed = trimTrailingPathSeparators(path);
  if (trimmed === "~" || trimmed === "") return trimmed === "~" ? "~" : "/";
  if (isWindowsPath(trimmed)) {
    const root = windowsRoot(trimmed);
    if (trimmed === root || trimmed === root.replace(/[\\/]$/, "")) return root;
    const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    return at < root.length ? root : trimmed.slice(0, at);
  }
  const at = trimmed.lastIndexOf("/");
  return at <= 0 ? (trimmed.startsWith("/") ? "/" : "~") : trimmed.slice(0, at);
};

export const basename = (path: string) => trimTrailingPathSeparators(path).split(/[\\/]/).filter(Boolean).pop() ?? "";

export const join = (dir: string, name: string): string => {
  const base = trimTrailingPathSeparators(dir);
  const sep = pathSeparator(base);
  return `${base}${base.endsWith(sep) ? "" : sep}${name}`;
};
