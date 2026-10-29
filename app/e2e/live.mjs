// pnpm smoke:live runs the smoke suite (e2e/) against this laptop's own
// Terminal agent instead of the mock fixtures, for a check before a release.
// It is read only: the tests only GET from the agent (anything else is
// refused in e2e/fixtures.ts), never attach a terminal, and skip what needs
// a fixture or would write.
//
//   VITE_BERTH_TOKEN=$(berth ui-token | jq -r .token) pnpm smoke:live
//
// VITE_BERTH_URL picks another agent (default http://127.0.0.1:1378);
// BERTH_E2E_WORKTREE=box/name the worktree with an agent to open (default:
// the first the sidebar lists with one). Extra arguments go to Playwright.
import { spawnSync } from "node:child_process";
import process from "node:process";

const token = process.env.VITE_BERTH_TOKEN;
if (!token) {
  console.error("smoke:live needs the agent's token in VITE_BERTH_TOKEN; `berth ui-token` prints it.");
  process.exit(2);
}
// The token goes to the page in its address, never into the build.
const env = { ...process.env };
delete env.VITE_BERTH_TOKEN;
delete env.VITE_BERTH_URL;

const run = (cmd, args, extra = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...env, ...extra } });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run("pnpm", ["-s", "build"]);
run("pnpm", ["exec", "playwright", "test", ...process.argv.slice(2)], {
  BERTH_E2E_LIVE: "1",
  BERTH_E2E_TOKEN: token,
  BERTH_E2E_AGENT: process.env.VITE_BERTH_URL ?? "http://127.0.0.1:1378",
});
