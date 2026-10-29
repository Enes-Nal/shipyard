import { useEffect } from "react";
import { create } from "zustand";

import { isMock } from "@/hooks/use-berth-connection";
import { overlayOpen } from "@/lib/overlays";
import { firstRun, setPrefs, usePrefs } from "@/lib/prefs";
import { useStore } from "@/lib/store";
import { decide, latestRelease, type Release } from "@/lib/whats-new-model";
import { RELEASES } from "@/lib/whats-new-releases";

// The What's new card (components/whats-new): once after Terminal updates,
// with the release's highlights, and again from Settings › About or ⌘K.
// A new install doesn't get it: it has nothing to catch up on. Prefs keep
// the newest version seen (whatsNewSeen); lib/whats-new-model.ts decides.

export type WhatsNewFrom = "update" | "about" | "palette";

interface State {
  open: boolean;
  // The note at the foot of the sidebar that opens the card.
  nudge?: boolean;
  release?: Release;
  from?: WhatsNewFrom;
}

export const useWhatsNew = create<State>(() => ({ open: false }));

// appVersion is the running app's version: package.json's, which the Mac
// app's is too. Mock mode takes ?version= to play an update.
export function appVersion(): string {
  if (isMock()) {
    const v = new URLSearchParams(location.search).get("version");
    if (v) return v;
  }
  return __BERTH_VERSION__;
}

export function openWhatsNew(from: WhatsNewFrom, release = latestRelease(RELEASES)) {
  if (!release) return;
  markSeen();
  useWhatsNew.setState({ open: true, release, from, nudge: false });
}

// dismissNudge puts the sidebar's note away for good: its × is a "no
// thanks", and Settings › About or ⌘K still open the card.
export function dismissNudge() {
  markSeen();
  useWhatsNew.setState({ nudge: false });
}

export function closeWhatsNew() {
  useWhatsNew.setState({ open: false });
}

export const hasWhatsNew = () => !!latestRelease(RELEASES);

// Decided once, as the app starts. A release to show is kept as unseen
// until the person opens the card or dismisses its note, so a note that
// went unnoticed is there again next time.
const decision = decide({ firstRun, seen: usePrefs.getState().whatsNewSeen, current: appVersion(), releases: RELEASES });
if (!decision.show && decision.seen !== usePrefs.getState().whatsNewSeen) setPrefs({ whatsNewSeen: decision.seen });

function markSeen() {
  if (usePrefs.getState().whatsNewSeen !== decision.seen) setPrefs({ whatsNewSeen: decision.seen });
}

// useWhatsNewAfterUpdate tells of an update once the app is connected (so
// Show me has somewhere to go): a quiet note at the foot of the sidebar
// that opens the card. With no sidebar to hold it (folded to the rail, or
// zen) the card opens instead, a moment after the app settles and not over
// a dialog already open.
export function useWhatsNewAfterUpdate(ready: boolean) {
  const connected = useStore((s) => !!s.client) && ready;
  useEffect(() => {
    const release = decision.show;
    if (!connected || !release || usePrefs.getState().whatsNewSeen === decision.seen) return;
    const p = usePrefs.getState();
    if (!p.sidebarCollapsed && !(p.labs && p.zen)) {
      useWhatsNew.setState({ nudge: true, release });
      return;
    }
    let tries = 0;
    let t = 0;
    const attempt = () => {
      // Another dialog first (a question, a trust prompt): wait for it.
      if (overlayOpen() && tries++ < 60) {
        t = window.setTimeout(attempt, 1000);
        return;
      }
      openWhatsNew("update", release);
    };
    t = window.setTimeout(attempt, 800);
    return () => window.clearTimeout(t);
  }, [connected]);
}
