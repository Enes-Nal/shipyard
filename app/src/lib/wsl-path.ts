// On Windows, this computer's box runs in WSL (internal/agent/localbox_wsl.go),
// which sees the PC's drives under /mnt: E:\Code is /mnt/e/Code there. The
// app shows and accepts the Windows form, and talks to the box in its own.

// WSL_DRIVES is where WSL keeps the PC's drives: "This PC".
export const WSL_DRIVES = "/mnt";

// toWslPath turns E:\Code\shop (or E:/Code/shop) into /mnt/e/Code/shop.
// Anything else is left as it is.
export function toWslPath(path: string): string {
  const m = /^([A-Za-z]):(?:[\\/](.*))?$/.exec(path.trim());
  if (!m) return path;
  const rest = (m[2] ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return `${WSL_DRIVES}/${m[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
}

// fromWslPath turns /mnt/e/Code/shop into E:\Code\shop. Anything else (the
// Linux side, ~/code) is left as it is.
export function fromWslPath(path: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(path);
  if (!m) return path;
  return `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\//g, "\\")}`;
}

// isWslDrive is whether a folder in /mnt is one of the PC's drives, not
// WSL's own (/mnt/wsl, /mnt/wslg).
export const isWslDrive = (name: string) => /^[a-z]$/.test(name);
