import { create } from "zustand";

import type { RouteDecision } from "@/lib/routing";
import { load, save } from "@/lib/storage";

const KEY = "berth.routing.history.v1";
const LIMIT = 30;

export interface RoutingHistoryEntry {
  id: string;
  at: string;
  box: string;
  location: string;
  prompt: string;
  tier: RouteDecision["tier"];
  confidence: RouteDecision["confidence"];
  provider: RouteDecision["provider"];
  pick: RouteDecision["pick"];
  signals: string[];
}

interface RoutingHistoryState {
  entries: RoutingHistoryEntry[];
}

const initial = load<RoutingHistoryEntry[]>(KEY, []);

export const useRoutingHistory = create<RoutingHistoryState>()(() => ({ entries: Array.isArray(initial) ? initial.slice(0, LIMIT) : [] }));

useRoutingHistory.subscribe((state) => save(KEY, state.entries));

export function recordRoutingDecision(route: RouteDecision, context: { box: string; location: string; prompt: string }) {
  const entry: RoutingHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    box: context.box,
    location: context.location,
    // The history is useful without becoming a second transcript.
    prompt: context.prompt.trim().replace(/\s+/g, " ").slice(0, 160),
    tier: route.tier,
    confidence: route.confidence,
    provider: route.provider,
    pick: route.pick,
    signals: route.signals,
  };
  useRoutingHistory.setState((state) => ({ entries: [entry, ...state.entries].slice(0, LIMIT) }));
}

export function clearRoutingHistory() {
  useRoutingHistory.setState({ entries: [] });
}
