// After the window has been in the background for a while (another app in
// front, Terminal still on screen beside it), the app's endless decorative
// animations hold still: an agent's spinner, a live dot's ping, a working
// line's shimmer. They show the same state, unmoving, and start again the
// moment the window comes to the front or the pointer moves over it. At
// rest they were nearly all the app's CPU and GPU (perf/soak.mjs): a
// working agent's shimmer alone kept the main thread busy 4% of the time.
// A hidden window (minimised, covered) holds still at once.
//
// :root[data-berth-still] in index.css says which animations.

export const STILL_AFTER = 30_000;

export function watchStillness(): () => void {
  const root = document.documentElement;
  let timer = 0;
  const set = (still: boolean) => root.toggleAttribute("data-berth-still", still);
  const away = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => set(true), document.hidden ? 0 : STILL_AFTER);
  };
  const back = () => {
    window.clearTimeout(timer);
    set(false);
    if (!document.hasFocus()) away();
  };
  const onVisibility = () => (document.hidden ? (window.clearTimeout(timer), set(true)) : back());
  // The pointer over a window in the background: someone is looking.
  let moved = 0;
  const onMove = () => {
    if (!root.hasAttribute("data-berth-still") || Date.now() - moved < 1000) return;
    moved = Date.now();
    back();
  };
  window.addEventListener("blur", away);
  window.addEventListener("focus", back);
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("pointermove", onMove, { passive: true });
  if (document.hidden) set(true);
  else if (!document.hasFocus()) away();
  return () => {
    window.clearTimeout(timer);
    set(false);
    window.removeEventListener("blur", away);
    window.removeEventListener("focus", back);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("pointermove", onMove);
  };
}
