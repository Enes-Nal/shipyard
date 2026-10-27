import type { BoxLink, BoxPath } from "@/lib/api";

// How well the laptop reaches a box, in words (the agent's status, link):
// a slow link stays connected, so these stay understated. No alarms: a slow
// box is online, and requests to it still go through.

// relayNote says a box is reached through one of Tailscale's relay servers
// rather than directly, or nothing when it isn't (or nobody can tell).
export function relayNote(path: BoxPath | undefined): string | undefined {
  if (!path) return undefined;
  if (path.via === "relay") {
    const where = path.relay_name || path.relay?.toUpperCase() || "a";
    const nearest = path.nearest && path.nearest !== path.relay_name ? ` (this computer's nearest is ${path.nearest})` : "";
    return `Relayed through Tailscale's ${where} server: no direct connection${nearest}`;
  }
  if (path.via === "peer-relay") return "Relayed through a Tailscale peer relay: no direct connection";
  return undefined;
}

// slowNote is why a slow box is slow, and that it is still connected.
export function slowNote(link: BoxLink | undefined): string | undefined {
  if (!link?.slow) return undefined;
  const why = link.reason ? `Slow: ${link.reason}. ` : "Slow. ";
  return `${why}Shipkit stays connected, and requests still go through.`;
}

const ms = (n: number) => `${n.toLocaleString("en-US")} ms`;

// latencyText is a box's latency, with how high it went lately when that
// is well above it: "80 ms", "80 ms · up to 1,900 ms".
export function latencyText(latency: number | undefined, link: BoxLink | undefined): string | undefined {
  if (latency === undefined) return undefined;
  const max = link?.max_ms;
  if (max && max >= Math.max(latency * 2, latency + 300)) return `${ms(latency)} · up to ${ms(max)}`;
  return ms(latency);
}

// The docs' section on a relayed link: why, and what fixes it.
export const RELAYED_DOCS = "/concepts/laptop-agent#a-relayed-link";
