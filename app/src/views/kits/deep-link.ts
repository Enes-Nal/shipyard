import { useEffect } from "react";

import { isTauri } from "@/lib/api";
import { kitSrcFromLink } from "@/lib/kits";
import { useStore } from "@/lib/store";
import { openKitLink } from "@/views/kits/kits-store";

// A kit link someone shares, berth://kit?src=…, opens Terminal on the kit's
// review. In the browser build, ?kit=<src> in the app's URL does the same,
// for trying it out.

function open(url: string) {
  if (!/^berth:\/\/kit\b/i.test(url)) return;
  const src = kitSrcFromLink(url);
  if (!src) return;
  useStore.getState().setView({ kind: "kits" });
  openKitLink(src);
}

export function useKitDeepLinks() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const kit = params.get("kit");
    if (kit) {
      params.delete("kit");
      const rest = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`);
      open(kit.startsWith("berth://") ? kit : `berth://kit?src=${encodeURIComponent(kit)}`);
    }
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const dl = await import("@tauri-apps/plugin-deep-link");
        // The link that launched the app, then any that arrive while it runs.
        for (const u of (await dl.getCurrent()) ?? []) open(u);
        const unlisten = await dl.onOpenUrl((urls) => urls.forEach(open));
        if (cancelled) unlisten();
        else stop = unlisten;
      } catch (err) {
        console.warn("kit links are not available", err);
      }
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
