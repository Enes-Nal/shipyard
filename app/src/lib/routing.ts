import type { AgentPreset } from "@/lib/api";
import type { AgentPick } from "@/lib/composer";

export type RouteTier = "economy" | "balanced" | "frontier";
export type RoutingObjective = "usage" | "balanced" | "quality";
export type RoutingProvider = "codex-subscription" | "claude-subscription" | "gemini" | "openrouter" | "local";

export interface RoutingPolicy {
  automatic: boolean;
  objective: RoutingObjective;
  providers: Record<RoutingProvider, boolean>;
  excludedModels: string[];
  rememberDecisions: boolean;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  automatic: true,
  objective: "balanced",
  providers: {
    "codex-subscription": true,
    "claude-subscription": true,
    gemini: true,
    openrouter: true,
    local: true,
  },
  excludedModels: [],
  rememberDecisions: true,
};

export function normalizeRoutingPolicy(policy?: Partial<RoutingPolicy>): RoutingPolicy {
  return {
    ...DEFAULT_ROUTING_POLICY,
    ...policy,
    providers: { ...DEFAULT_ROUTING_POLICY.providers, ...policy?.providers },
    excludedModels: Array.isArray(policy?.excludedModels) ? policy.excludedModels : [],
  };
}

export interface RouteDecision {
  pick: AgentPick;
  provider: RoutingProvider;
  tier: RouteTier;
  confidence: "low" | "medium" | "high";
  headline: string;
  reason: string;
  signals: string[];
}

export function providerForAgent(agent: string): RoutingProvider {
  if (agent === "codex") return "codex-subscription";
  if (agent === "claude") return "claude-subscription";
  if (agent === "gemini") return "gemini";
  if (agent === "openrouter") return "openrouter";
  return "local";
}

export const providerLabel = (provider: RoutingProvider) =>
  ({
    "codex-subscription": "ChatGPT subscription",
    "claude-subscription": "Claude subscription",
    gemini: "Gemini",
    openrouter: "OpenRouter",
    local: "Other local agents",
  })[provider];

const SIMPLE = [
  /\b(copy|rename|typo|format|lint|comment|docs?|readme)\b/i,
  /\b(one|single|small|quick|simple|minor)\s+(file|change|fix|edit)\b/i,
  /\b(find|search|locate|explain|summari[sz]e)\b/i,
];

const FRONTIER = [
  /\b(architect|architecture|migration|redesign|rewrite|system design)\b/i,
  /\b(security|authentication|authorization|cryptograph|vulnerab|permission)\b/i,
  /\b(race condition|deadlock|distributed|concurren|data loss|production incident)\b/i,
  /\b(across|entire|whole)\s+(app|codebase|repository|system)\b/i,
  /\b(ambiguous|investigate deeply|root cause|do not stop)\b/i,
];

const MODEL_HINTS: Record<RouteTier, RegExp[]> = {
  economy: [/luna/i, /haiku/i, /mini/i, /flash/i, /small/i, /lite/i],
  balanced: [/sol(?!o)/i, /sonnet/i, /flash/i, /codex/i, /pro/i],
  frontier: [/astra/i, /opus/i, /fable/i, /argon/i, /max/i, /pro/i],
};

const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function taskTier(prompt: string, objective: RoutingObjective): { tier: RouteTier; signals: string[] } {
  const text = prompt.trim();
  const frontier = FRONTIER.filter((pattern) => pattern.test(text)).length;
  const simple = SIMPLE.filter((pattern) => pattern.test(text)).length;
  const long = text.length > 900 || text.split("\n").length > 14;
  const codeBlocks = (text.match(/```/g)?.length ?? 0) >= 2;

  let tier: RouteTier;
  let signals: string[];
  if (frontier > 0 || (long && codeBlocks)) {
    tier = "frontier";
    signals = [frontier > 0 ? "high-risk or system-wide language" : "large, code-heavy brief", long && "large prompt", codeBlocks && "embedded code"].filter(Boolean) as string[];
  } else if (text && simple > 0 && text.length < 520) {
    tier = "economy";
    signals = ["narrow, well-specified task"];
  } else {
    tier = "balanced";
    signals = text ? ["normal implementation scope"] : ["waiting for task details"];
  }

  // The task's risk is the baseline. The person's objective nudges one tier,
  // but explicit high-risk work never drops below balanced.
  if (objective === "quality" && tier !== "frontier") {
    tier = tier === "economy" ? "balanced" : "frontier";
    signals.push("quality-first preference");
  }
  if (objective === "usage" && tier !== "economy") {
    tier = tier === "frontier" ? "balanced" : "economy";
    signals.push("usage-first preference");
  }
  return { tier, signals };
}

function chooseAgent(tier: RouteTier, presets: AgentPreset[]): AgentPreset | undefined {
  const preference = tier === "frontier" ? ["claude", "codex"] : ["codex", "claude"];
  for (const id of preference) {
    const found = presets.find((preset) => preset.id === id);
    if (found) return found;
  }
  return presets[0];
}

function chooseModel(tier: RouteTier, agent: string, models: string[] = [], excluded: string[] = []): string {
  const allowed = models.filter((model) => !excluded.includes(`${agent}:${model}`));
  for (const hint of MODEL_HINTS[tier]) {
    const match = allowed.find((model) => hint.test(model));
    if (match) return match;
  }
  // If the CLI gave us a catalog, its default might resolve to a model the
  // person excluded. Pick an explicitly allowed model instead.
  return allowed[0] ?? "";
}

function chooseEffort(tier: RouteTier, efforts: string[] = []): string {
  const target = tier === "economy" ? "low" : tier === "balanced" ? "medium" : "high";
  if (efforts.includes(target)) return target;
  if (!efforts.length) return "";
  const targetIndex = EFFORT_ORDER.indexOf(target);
  return [...efforts].sort((a, b) => Math.abs(EFFORT_ORDER.indexOf(a) - targetIndex) - Math.abs(EFFORT_ORDER.indexOf(b) - targetIndex))[0] ?? "";
}

const nice = (value: string) => (value ? value.replace(/(^|[-_])([a-z])/g, (_, space: string, letter: string) => `${space ? " " : ""}${letter.toUpperCase()}`) : "Default model");

export function recommendRoute(prompt: string, presets: AgentPreset[], rawPolicy?: Partial<RoutingPolicy>): RouteDecision | undefined {
  const policy = normalizeRoutingPolicy(rawPolicy);
  const { tier, signals } = taskTier(prompt, policy.objective);
  const eligible = presets.filter(
    (preset) => policy.providers[providerForAgent(preset.id)] && (!preset.models?.length || preset.models.some((model) => !policy.excludedModels.includes(`${preset.id}:${model}`))),
  );
  const agent = chooseAgent(tier, eligible);
  if (!agent) return undefined;
  const provider = providerForAgent(agent.id);
  const model = chooseModel(tier, agent.id, agent.models, policy.excludedModels);
  const effort = chooseEffort(tier, agent.efforts);
  const level = tier === "economy" ? "a focused, economical route" : tier === "frontier" ? "the strongest available route" : "the best balance of quality and usage";
  const detail = [model ? nice(model) : "its subscription default", effort && `${nice(effort)} effort`].filter(Boolean).join(" with ");
  return {
    pick: { agent: agent.id, model, effort },
    provider,
    tier,
    confidence: prompt.trim().length < 24 ? "low" : signals.length > 1 ? "high" : "medium",
    headline: [agent.name, model && nice(model), effort && nice(effort)].filter(Boolean).join(" · "),
    reason: `Shipkit sees ${signals[0]} and chose ${level}. It will use ${detail} through ${providerLabel(provider)}.`,
    signals,
  };
}

