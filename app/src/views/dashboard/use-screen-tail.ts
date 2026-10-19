import { useEffect, useState } from "react";

import { boxApi, type Session } from "@/lib/api";
import { useEventLog } from "@/lib/events";
import { askIn, type Choice, meaningfulTail } from "@/lib/screen";
import { useStore } from "@/lib/store";

export { type Choice, meaningfulTail };

// useScreenTail is the last few meaningful lines of a session's screen. It
// refetches when the session's state changes or an event about it arrives
// (debounced), and every 20s while the agent works, since output changes
// between events; it never polls harder than that.
export function useScreenTail(box: string, session: Session, count = 3, working = false, enabled = true): { tail?: string[]; choices: Choice[] } {
  const client = useStore((s) => s.client);
  const [tail, setTail] = useState<string[]>();
  const [choices, setChoices] = useState<Choice[]>([]);
  const latest = useEventLog((s) => {
    const e = s.events.find((x) => x.box === box && (x.data?.path === session.dir || x.data?.name === session.name || x.data?.session === session.name));
    return e?.time;
  });

  useEffect(() => {
    if (!client || !enabled) return;
    let cancelled = false;
    const fetchTail = () =>
      boxApi
        .screen(client, box, session.name)
        .then((r) => {
          if (cancelled) return;
          setTail(meaningfulTail(r.screen ?? "", count));
          // Options its own menu shows, never a list in its last message.
          setChoices(askIn(r.screen ?? "").choices);
        })
        .catch(() => {});
    const t = window.setTimeout(fetchTail, 250);
    const every = working ? window.setInterval(fetchTail, 20_000) : 0;
    return () => {
      cancelled = true;
      window.clearTimeout(t);
      window.clearInterval(every);
    };
  }, [client, box, session.name, session.agent_state, session.state_since, latest, count, working, enabled]);

  return { tail, choices };
}
