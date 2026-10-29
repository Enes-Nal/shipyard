import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// On Windows the app's backend is the desk, bin/berth-desk.exe
// (cmd/berth-desk), which the Tauri shell starts beside it (src-tauri/src/
// desk.rs). `pnpm tauri dev` is the normal Windows entry point, so build it
// here before Vite opens the window.
if (process.platform === "win32") {
  const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const repo = path.dirname(app);
  const bin = path.join(repo, "bin");
  const go = process.env.GO || (existsSync(path.join(repo, ".tools", "go", "bin", "go.exe")) ? path.join(repo, ".tools", "go", "bin", "go.exe") : "go");
  const ldflags = "-s -w -X github.com/cosscom/shipyard/internal/version.Version=dev";

  mkdirSync(bin, { recursive: true });
  build(go, repo, ["build", "-trimpath", `-ldflags=${ldflags}`, "-o", path.join(bin, "berth-desk.exe"), "./cmd/berth-desk"]);
}

function build(go, cwd, args, env = process.env) {
  const result = spawnSync(go, args, { cwd, env, stdio: "inherit", shell: false });
  if (result.error?.code === "ENOENT") {
    console.error("Shipyard's Windows development app needs Go to build its backend. Install Go from https://go.dev/dl/ and run pnpm tauri dev again.");
    process.exit(1);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
