// The agent's browser and Chromium's sandbox. Ubuntu 24.04 (and others)
// stop Chromium from starting its own sandbox, so the agent's browser on such
// a box can't start. The box says so cheaply (GET /v1/browser/health), and
// the app offers the two ways out: the owner allows it with sudo, in a
// terminal on the box where Terminal has typed the command and the person
// presses Enter (Terminal never asks for, types or keeps a password), or the
// box runs Chromium without its sandbox. Kept free of the app's imports, so
// node can test it as it is.

// BrowserHealth is the box's answer (internal/box/browsersandbox.go).
export interface BrowserHealth {
  // ok; sandbox: Chromium's sandbox can't start; error: another failure.
  state: "ok" | "sandbox" | "error";
  // A sandbox state judged from the box's settings before any start.
  likely?: boolean;
  // Ubuntu's setting: "1" restricts, "0" allows; absent elsewhere.
  userns?: string;
  no_sandbox: boolean;
  // What turned the sandbox off: BERTH_BROWSER_NO_SANDBOX (which wins) or
  // the box's setting.
  no_sandbox_from?: "env" | "setting";
  env?: string;
  setting: { no_sandbox: boolean };
  error?: string;
  at?: string;
  // The command that allows it, when that is the fix.
  fix?: string;
  text: string;
}

// The command a person runs on the box: now, and after a restart.
export const SANDBOX_FIX = "sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 && echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-chromium.conf";

// What the person has done from this card: nothing yet, opened the
// terminal with the fix typed, or checked after it.
export type SandboxPhase = "idle" | "fixing" | "checked";

// What the card shows.
export type SandboxCardState = "hidden" | "blocked" | "fixing" | "still-blocked" | "fixed" | "no-sandbox";

// sandboxCardState is the card for the box's health, what the person did,
// and whether this card has seen it blocked (so "fixed" is news, not noise).
// full: Settings, which shows the no-sandbox setting while it is on; the
// agent's view shows it only right after it was turned on there.
export function sandboxCardState(h: BrowserHealth | undefined, phase: SandboxPhase, sawBlocked: boolean, full = false): SandboxCardState {
  if (!h) return "hidden";
  if (h.state === "sandbox") {
    if (phase === "fixing") return "fixing";
    if (phase === "checked") return "still-blocked";
    return "blocked";
  }
  if (h.no_sandbox && (full || sawBlocked)) return "no-sandbox";
  if (h.state === "ok" && sawBlocked) return "fixed";
  return "hidden";
}

// canFixWithSudo is whether the sysctl is what stops it, so typing the fix
// would help.
export const canFixWithSudo = (h: BrowserHealth | undefined) => !!h && h.state === "sandbox" && h.userns === "1";

export interface SandboxCopy {
  title: string;
  body: string;
}

export const TRADE_OFF = "Without its sandbox, a page that broke into Chromium would run as you on the box. Terminal's proxy still confines it to the worktree's own pages.";

// sandboxCopy is what the card says, in plain words.
export function sandboxCopy(state: SandboxCardState, box: string, h: BrowserHealth | undefined): SandboxCopy {
  const sysctl = canFixWithSudo(h);
  switch (state) {
    case "blocked":
      return {
        title: h?.likely ? `The agent's browser won't start on ${box}` : `The agent's browser can't start on ${box}`,
        body: sysctl
          ? `Ubuntu's sandbox setting stops Chromium from starting its own sandbox. Allowing it takes one command with your password on ${box}; Terminal types it in a terminal for you and never sees the password.`
          : `Chromium couldn't start its own sandbox on ${box}. You can run it without its sandbox instead.`,
      };
    case "fixing":
      return {
        title: `Press Enter in the terminal on ${box}`,
        body: "The command is typed there. sudo asks for your password in that terminal; this card clears once the setting changes.",
      };
    case "still-blocked":
      return {
        title: "Still blocked",
        body: `${box} still stops Chromium's sandbox. If sudo was cancelled or your password was refused, nothing changed. Try the command again, or run without the sandbox.`,
      };
    case "fixed":
      return {
        title: `Fixed: the agent's browser starts on ${box}`,
        body: "Chromium's sandbox is allowed now, and stays allowed after a restart.",
      };
    case "no-sandbox":
      return {
        title: `The agent's browser runs without Chromium's sandbox on ${box}`,
        body: h?.no_sandbox_from === "env" ? "BERTH_BROWSER_NO_SANDBOX=1 is set where berthd runs, and wins over this setting. Terminal's proxy still confines it to the worktree's own pages." : TRADE_OFF,
      };
    default:
      return { title: "", body: "" };
  }
}
