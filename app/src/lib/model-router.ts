import type { AgentPreset } from "@/lib/api";

// Terminal's model router stays provider-neutral: it only picks from the
// agents and model names a box already reports. It never invents a model or
// sends a task to a provider the person has not connected.

export type RoutingMode = "save" | "balanced" | "quality";

export interface ModelRoutingPrefs {
  enabled: boolean;
  mode: RoutingMode;
  preferFree: boolean;
}

export interface ModelRoute {
  agent: string;
  model?: string;
  effort?: string;
  lane: "worker" | "lead";
  reason: string;
}

interface Candidate {
  preset: AgentPreset;
  model?: string;
  strength: number;
  freeFriendly: boolean;
}

const COMPLEX = /\b(architect|architecture|security|threat|migrat(?:e|es|ed|ing|ion|ions)?|concurren(?:cy|t)?|race condition|deadlock|investigat(?:e|es|ed|ing|ion)|diagnos(?:e|es|ed|ing|is|tic|tics)|debug|performance|optimi[sz](?:e|es|ed|ing|ation|ations)|refactor|review|distributed|database|schema|authentication|authorization|production|incident)\b/i;
const ROUTINE = /\b(rename|format|lint|prettier|copy|boilerplate|scaffold|typo|spelling|sort imports?|update snapshots?|bump (?:the )?version|run (?:the )?tests?|replace all|mechanical|repetitive|chore)\b/i;
const HIGH_RISK = /\b(auth|authentication|authorization|security|migrat(?:e|es|ed|ing|ion|ions)?|production|incident|data loss|rollback)\b/i;
const STRONG = /\b(opus|pro|max|ultra|large|reason|gpt-5|gpt-6|o[134](?:\b|-)|r1|sonnet)\b/i;
const FAST = /\b(haiku|flash|mini|nano|small|lite|fast|instant|8b|7b|3b|1b)\b/i;
const FREE_FRIENDLY = /\b(free|local|ollama|llama|qwen|mistral|gemma|deepseek|openrouter)\b/i;

function taskComplexity(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  let score = Math.min(3, Math.floor(words / 80));
  const complex = COMPLEX.test(text);
  if (complex) score += 3;
  if (/\b(across|end[- ]to[- ]end|multiple|entire|whole|system)\b/i.test(text)) score += 1;
  if (!complex && ROUTINE.test(text)) score -= 3;
  return score;
}

function modelStrength(model: string | undefined, agent: string): number {
  const name = `${agent} ${model ?? "default"}`;
  let score = 0;
  if (STRONG.test(name)) score += 4;
  if (FAST.test(name)) score -= 4;
  // When a CLI exposes no model list, keep its default in the middle.
  return score;
}

function candidates(presets: AgentPreset[]): Candidate[] {
  return presets.flatMap((preset) => {
    const models = preset.models?.length ? preset.models : [undefined];
    return models.map((model) => ({
      preset,
      model,
      strength: modelStrength(model, preset.id),
      freeFriendly: FREE_FRIENDLY.test(`${preset.id} ${model ?? ""}`),
    }));
  });
}

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function effortRank(effort: string): number {
  const rank = EFFORTS.indexOf(effort);
  return rank === -1 ? EFFORTS.indexOf("medium") : rank;
}

function effortFor(preset: AgentPreset, lane: ModelRoute["lane"]): string | undefined {
  const efforts = preset.efforts ?? [];
  if (!efforts.length) return undefined;
  const ranked = [...efforts].sort((a, b) => effortRank(a) - effortRank(b));
  return lane === "worker" ? ranked[0] : ranked[ranked.length - 1];
}

export function routeTask(text: string, presets: AgentPreset[], prefs: ModelRoutingPrefs): ModelRoute | undefined {
  if (!prefs.enabled || !text.trim() || !presets.length) return undefined;
  const complexity = taskComplexity(text);
  const leadThreshold = prefs.mode === "save" ? 4 : 3;
  const lane: ModelRoute["lane"] =
    prefs.mode === "quality" || HIGH_RISK.test(text) || complexity >= leadThreshold
      ? "lead"
      : "worker";
  const all = candidates(presets);
  all.sort((a, b) => {
    if (lane === "worker" && prefs.preferFree && a.freeFriendly !== b.freeFriendly) return a.freeFriendly ? -1 : 1;
    const byStrength = lane === "worker" ? a.strength - b.strength : b.strength - a.strength;
    if (byStrength) return byStrength;
    return presets.indexOf(a.preset) - presets.indexOf(b.preset);
  });
  const picked = all[0];
  if (!picked) return undefined;
  const routine = complexity < 3;
  return {
    agent: picked.preset.id,
    model: picked.model,
    effort: effortFor(picked.preset, lane),
    lane,
    reason:
      lane === "lead"
        ? "Complex work stays with the strongest available model"
        : prefs.preferFree && picked.freeFriendly
          ? "Routine work goes to a free or local-friendly model"
          : routine
            ? "Routine work goes to the fastest available model"
            : "Balanced routing keeps this task on the worker lane",
  };
}
