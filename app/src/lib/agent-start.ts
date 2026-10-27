import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/api";

// Starting the laptop agent from the "not running" screen. The Tauri shell
// finds the berth command (bundled in Terminal.app, or bin/berth in a dev
// build) and runs it; a plain browser cannot, so it gets the terminal
// instructions instead. ?mock=offline acts the whole thing out without an
// agent: the screen first, then the mock app once "started".

export interface AgentBinary {
  path: string;
  source: "bundled" | "repository" | "installed";
}

const mockOffline = () => new URLSearchParams(location.search).get("mock") === "offline";
const mockMissingBinary = () => mockOffline() && new URLSearchParams(location.search).get("binary") === "missing";
let mockStarted = false;

// mockAgentDown is true while ?mock=offline has not "started" its agent.
export const mockAgentDown = () => mockOffline() && !mockStarted;

// findAgentBinary is the berth command the app can start the agent with, or
// null when there is none to run.
export async function findAgentBinary(): Promise<AgentBinary | null> {
  if (isTauri()) return invoke<AgentBinary | null>("agent_binary");
  if (mockOffline()) return mockMissingBinary() ? null : { path: "/Applications/Terminal.app/Contents/MacOS/berth-cli", source: "bundled" };
  return null;
}

// startAgent starts the agent now; atLogin also installs it as a login
// service (berth agent install), which only happens when asked.
export async function startAgent(atLogin: boolean): Promise<string> {
  if (isTauri()) return invoke<string>("start_agent", { atLogin });
  if (mockOffline()) {
    await new Promise((r) => setTimeout(r, 900));
    mockStarted = true;
    return atLogin ? "Installed ~/Library/LaunchAgents/dev.berth.agent.plist" : "The berth agent is running.";
  }
  throw new Error("Only the Terminal app can start the agent. Run berth agent in a terminal instead.");
}

const RETRY = "berth:retry-connection";

// retryConnection makes the connection loop try again now, not after its
// back-off.
export function retryConnection() {
  window.dispatchEvent(new Event(RETRY));
}

// waitForRetry resolves after ms, or sooner when retryConnection is called.
export function waitForRetry(ms: number): Promise<"timeout" | "retry"> {
  return new Promise((resolve) => {
    const done = (why: "timeout" | "retry") => {
      window.clearTimeout(timer);
      window.removeEventListener(RETRY, onRetry);
      resolve(why);
    };
    const onRetry = () => done("retry");
    const timer = window.setTimeout(() => done("timeout"), ms);
    window.addEventListener(RETRY, onRetry);
  });
}
