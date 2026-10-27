import { ApiError } from "@/lib/api";
import type { Editor, SSHPlan } from "@/lib/editors";

// Mock editors and SSH setup: Cursor and Zed installed, and SSH for
// editors not set up until the Settings card writes it.

const editors: Editor[] = [
  { id: "cursor", name: "Cursor", installed: true, cli: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor", lines: true },
  { id: "vscode", name: "VS Code", installed: false, lines: false },
  { id: "windsurf", name: "Windsurf", installed: false, lines: false },
  { id: "zed", name: "Zed", installed: true, cli: "/Applications/Zed.app/Contents/MacOS/cli", lines: false },
];

let written = false;

const conf = (box: string, addr: string, net?: string) =>
  `# Written by berth ssh-config for the box ${box}; berth rewrites it.\nHost berth-${box}\n  HostName ${addr}\n  User me\n` +
  (net ? `  ProxyCommand /Applications/Terminal.app/Contents/MacOS/berth network proxy ${net} %h %p\n` : "");

const plus = (s: string) =>
  s
    .trimEnd()
    .split("\n")
    .map((l) => `+ ${l}`)
    .join("\n") + "\n";

function plan(): SSHPlan {
  const hosts = [
    { box: "devl", host: "berth-devl", user: "me", network: "personal", ready: written },
    { box: "gpu", host: "berth-gpu", user: "me", ready: written },
  ];
  if (written) return { dir: "/Users/you/.ssh", hosts, changes: [] };
  return {
    dir: "/Users/you/.ssh",
    hosts,
    changes: [
      { path: "/Users/you/.ssh/berth/devl.conf", action: "create", diff: plus(conf("devl", "100.64.0.11", "personal")) },
      { path: "/Users/you/.ssh/berth/gpu.conf", action: "create", diff: plus(conf("gpu", "100.64.0.12")) },
      {
        path: "/Users/you/.ssh/config",
        action: "update",
        diff: plus("# Added by berth: an SSH host per paired box, named berth-<box>.\n# It only works above any Host block.\nInclude berth/*.conf") + "  (then the rest of the file, unchanged)\n",
      },
    ],
  };
}

export function editorsCall(method: string, path: string, body: unknown, delay: <T>(v: T) => Promise<T>): Promise<unknown> | undefined {
  if (method === "GET" && path === "/v1/editors") return delay(editors);
  if (method === "GET" && path === "/v1/ssh-config") return delay(plan());
  if (method === "POST" && path === "/v1/ssh-config") {
    written = true;
    return delay(plan());
  }
  if (method === "POST" && path === "/v1/editors/open") {
    const r = body as { editor: string; box: string; path?: string; file?: string; line?: number };
    if (!written && r.box !== "mac") return Promise.reject(new ApiError("set up SSH for editors first", 409));
    const target = r.file ? `${r.file}${r.line ? `:${r.line}` : ""}` : r.path;
    console.info(`mock: open ${target} on ${r.box} in ${r.editor}`);
    return delay({ command: [r.editor, "--remote", `ssh-remote+berth-${r.box}`, target ?? ""] });
  }
  return undefined;
}
