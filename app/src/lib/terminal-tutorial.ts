export const TERMINAL_TUTORIAL_EVENT = "terminal:tutorial-open";

export function openTerminalTutorial() {
  window.dispatchEvent(new Event(TERMINAL_TUTORIAL_EVENT));
}
