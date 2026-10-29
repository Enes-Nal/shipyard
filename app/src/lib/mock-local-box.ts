import type { Status } from "@/lib/api";
import type { LocalBoxStatus } from "@/lib/local-box";
import { IS_WINDOWS } from "@/lib/platform";

// Use this Mac in mock mode (?mock=1): this Mac can be a box until it is
// one; setting it up plays the agent's steps and pairs a box marked local,
// whose folders are a Mac's. ?thismac=nosession fails the way a Mac without
// a login session does; ?thismac=none is an agent with no berthd to install;
// ?thismac=nowsl is a Windows PC without WSL.

type Deps = {
  status: Status;
  addBox(name: string, address: string, network?: string): void;
  delay<T>(v: T): Promise<T>;
};

let deps: Deps | undefined;
const mode = new URLSearchParams(location.search).get("thismac");
const NAME = "my-mac";
// On Windows the box is WSL's: an Ubuntu home, and the PC's drives in /mnt.
const HOME = IS_WINDOWS ? "/home/me" : "/Users/me";
const ADDRESS = "127.0.0.1:7445";

const local: LocalBoxStatus = { supported: true, available: mode !== "none", installed: false, owned: false, running: false, name: NAME };
if (mode === "none") local.reason = "this copy of Terminal carries no berthd for this computer";
if (mode === "nowsl") Object.assign(local, { supported: false, available: false, reason: "WSL isn't installed. In PowerShell as administrator run: wsl --install -d Ubuntu, restart Windows, then run bash scripts/setup-wsl.sh inside Ubuntu" });

export function initMockLocalBox(d: Deps) {
  deps = d;
}

// A Mac's folders, for browsing this Mac's box; WSL's on Windows.
const wslFolders: Record<string, { git?: boolean; slug?: string }> = {
  "/": {},
  "/home": {},
  [HOME]: {},
  [`${HOME}/code`]: {},
  [`${HOME}/code/notes`]: { git: true, slug: "me/notes" },
  "/mnt": {},
  "/mnt/c": {},
  "/mnt/c/Users": {},
  "/mnt/e": {},
  "/mnt/e/Code": {},
  "/mnt/e/Code/shop": { git: true, slug: "acme/shop" },
  "/mnt/e/Code/site": { git: true, slug: "me/site" },
  "/mnt/wsl": {},
  "/mnt/wslg": {},
};
const folders: Record<string, { git?: boolean; slug?: string }> = IS_WINDOWS ? wslFolders : {
  [HOME]: {},
  [`${HOME}/Developer`]: {},
  [`${HOME}/Developer/shop`]: { git: true, slug: "acme/shop" },
  [`${HOME}/Developer/notes`]: { git: true, slug: "me/notes" },
  [`${HOME}/Developer/site`]: { git: true, slug: "me/site" },
  [`${HOME}/Documents`]: {},
  [`${HOME}/Downloads`]: {},
};

const expand = (p: string) => (p === "~" ? HOME : p.startsWith("~/") ? `${HOME}${p.slice(1)}` : p.replace(/\/+$/, "") || "/");

function isLocal(box: string) {
  return !!deps?.status.boxes.find((b) => b.name === box)?.local;
}

// localBoxCall answers the laptop's GET /v1/boxes/local.
export function localBoxCall(method: string, path: string): Promise<unknown> | undefined {
  if (!deps) return undefined;
  if (method === "GET" && path === "/v1/boxes/local") return deps.delay({ ...local });
  return undefined;
}

// localBoxFolders lists this Mac's folders for its own box.
export function localBoxFolders(box: string, method: string, path: string): Promise<unknown> | undefined {
  if (!deps || !isLocal(box) || method !== "GET") return undefined;
  const [route, query = ""] = path.split("?");
  if (route !== "fs") return undefined;
  const dir = expand(new URLSearchParams(query).get("path") ?? "~");
  if (!(dir in folders)) return Promise.reject(new Error(`${dir}: no such folder`));
  const entries = Object.keys(folders)
    .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"))
    .sort()
    .map((p) => ({ name: p.split("/").pop()!, path: p, ...folders[p] }));
  return deps.delay({ path: dir, parent: dir === "/" ? undefined : dir.split("/").slice(0, -1).join("/") || "/", home: HOME, entries });
}

// localBoxStream plays setting up and removing; false for anything else.
export async function localBoxStream(method: string, path: string, body: unknown, onValue: (v: unknown) => void, signal?: AbortSignal): Promise<boolean> {
  if (!deps || method !== "POST" || (path !== "/v1/boxes/local" && path !== "/v1/boxes/local/uninstall")) return false;
  const d = deps;
  const wait = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("aborted", "AbortError"))));
    });
  const say = async (line: string, ms = 450) => {
    await wait(ms);
    onValue({ line });
  };

  if (path === "/v1/boxes/local/uninstall") {
    const removeData = !!(body as { remove_data?: boolean } | undefined)?.remove_data;
    const box = d.status.boxes.find((b) => b.local);
    if (box) {
      await say(`Forgetting ${box.name} on this laptop…`, 200);
      d.status.boxes = d.status.boxes.filter((b) => b !== box);
    }
    await say("Stopping berthd and removing its service…", 400);
    await say(`  Removed ${HOME}/Library/LaunchAgents/dev.berth.berthd.plist`, 500);
    await say(`Removed ${HOME}/Library/Application Support/berth/bin/berthd.`, 200);
    await say(removeData ? `Deleting ${HOME}/Library/Application Support/berth/box…` : `Kept its data in ${HOME}/Library/Application Support/berth/box; setting this computer up again uses it.`, 300);
    Object.assign(local, { installed: false, owned: false, running: false, box: undefined, listen: undefined });
    onValue({ done: true });
    return true;
  }

  if (!local.available) {
    await wait(300);
    onValue({ done: true, error: local.reason });
    return true;
  }
  if (local.box) {
    await say("berthd is installed and running.", 300);
    await say(`Already paired as ${local.box}; reconnecting.`, 300);
    onValue({ done: true, box: local.box });
    return true;
  }
  await say(`Copying berthd to ${HOME}/Library/Application Support/berth/bin/berthd…`, 300);
  await say(`Installing the berthd service, listening on ${ADDRESS}: this computer only…`, 500);
  if (mode === "nosession") {
    await wait(900);
    onValue({
      done: true,
      error: "launchd has no login session for you on this Mac (Could not find domain for port identifier), so berthd cannot run as your launch agent. Log in at the Mac once (screen sharing counts) and try again",
    });
    return true;
  }
  await say(`  Installed ${HOME}/Library/LaunchAgents/dev.berth.berthd.plist; berthd is serving on ${ADDRESS}.`, 1200);
  await say("  Agent integrations (hooks for needs-you, working and done; Terminal's skills):", 300);
  await say(`    Claude Code: hooks and 7 skills in ~/.claude`, 300);
  await say("Pairing this laptop with it…", 500);
  d.addBox(NAME, ADDRESS);
  const added = d.status.boxes.find((b) => b.name === NAME);
  if (added) added.local = true;
  Object.assign(local, { installed: true, owned: true, running: true, box: NAME, listen: ADDRESS, program: `${HOME}/Library/Application Support/berth/bin/berthd` });
  await say(`Paired as ${NAME}.`, 600);
  onValue({ done: true, box: NAME });
  return true;
}
