import type { Prefs } from "./prefs.ts";

// How prefs saved by an older Shipyard (berth.prefs) are brought up to
// date, kept apart from lib/prefs.ts so it can be tested on its own
// (prefs-migrate.test.ts).

// PREFS_VERSION counts changes of default that saved prefs are moved to
// once. 2: closing an agent's tab stops it ("keep" was the default before).
// 3: Labs on. 4: structured agents on, out of Labs.
export const PREFS_VERSION = 4;

export type Saved = Partial<Prefs> & { version?: number };

// migrate brings prefs saved by an older Shipyard up to date. Prefs are saved
// whole, so a "keep" saved before version 2 is only the old default unless
// the person chose it, which closeAgentsChosen records from now on.
export function migratePrefs(saved: Saved): Saved {
  const out = { ...saved };
  if ((saved.version ?? 1) < 2 && Object.keys(saved).length) {
    if ((saved.closeAgents ?? "keep") === "keep" && !saved.closeAgentsChosen) {
      out.closeAgents = "stop";
      out.agentCloseTips = 0;
    }
  }
  // Version 3 turns Labs on: off was only the old default.
  if ((saved.version ?? 1) < 3 && !saved.labsChosen) out.labs = true;
  // Version 4 runs agents structured: off was the Labs default, so everyone
  // starts on once, and what they choose after sticks.
  if ((saved.version ?? 1) < 4) out.structuredClaude = true;
  out.version = PREFS_VERSION;
  return out;
}
