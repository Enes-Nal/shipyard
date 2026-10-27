// What's new: the card the app shows once after it updates, with the
// release's highlights (lib/whats-new-releases.ts). Pure, so it is tested on
// its own (whats-new.test.ts); lib/whats-new.ts runs it against prefs.

// The places a "Show me" goes (components/whats-new/show.ts runs them).
export type ShowId = "artifacts" | "visual-diff" | "devtools" | "rename" | "settings-boxes";

// The small picture beside each item, drawn from the app's own pieces
// (components/whats-new/art.tsx).
export type ArtId = "artifacts" | "visual-diff" | "devtools" | "rename" | "agent-messages" | "speed";

export interface WhatsNewItem {
  id: string;
  title: string;
  // One or two short sentences: what changed, for you.
  body: string;
  art: ArtId;
  // Where "Show me" goes, when it can go somewhere real.
  show?: ShowId;
  // The keys that do it, as the shortcuts sheet writes them.
  keys?: string;
  // Where it waits when there's no shortcut ("In a worktree's menu").
  where?: string;
  // A page of the docs, for what has no place in the app to show.
  docs?: string;
}

export interface Release {
  // The version it ships in, as app/package.json has it.
  version: string;
  items: WhatsNewItem[];
  // Smaller things, one line each, under the highlights.
  also: { text: string; show?: ShowId }[];
}

// compareVersions orders "0.3.10" after "0.3.9". Anything that isn't
// numbers ("dev") sorts first.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : [-1]);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// latestRelease is the newest release this app has notes for: what ⌘K and
// Settings › About open.
export function latestRelease(releases: Release[]): Release | undefined {
  return [...releases].sort((a, b) => compareVersions(b.version, a.version))[0];
}

export interface Decision {
  // The release to show now, if any.
  show?: Release;
  // What to keep as seen.
  seen: string;
}

// decide is what happens as the app starts. A first install (no prefs saved
// before) shows nothing and counts as having seen this version. After an
// update, the newest release the running app includes, newer than the last
// one seen, shows once. Prefs from a Terminal older than the card (no
// version seen) count as an update.
export function decide({ firstRun, seen, current, releases }: { firstRun: boolean; seen: string | null | undefined; current: string; releases: Release[] }): Decision {
  if (firstRun) return { seen: current };
  const fits = releases.filter((r) => compareVersions(r.version, current) <= 0 && (!seen || compareVersions(r.version, seen) > 0));
  const show = latestRelease(fits);
  // Never move seen backwards (a dev build older than the last release).
  const next = seen && compareVersions(seen, current) > 0 ? seen : current;
  return { show, seen: next };
}
