import * as React from "react";

let shown = false;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Set by the editor in the frame its text appears, which is when the page should stop being the one read. */
export function setEditorShown(value: boolean): void {
  if (shown === value) return;
  shown = value;
  for (const listener of listeners) listener();
}

/**
 * Opening the editor takes a moment: its code, any draft left behind, the shared draft. Until it can take the page's
 * place, the page stays as it was read, so that switching is one change on screen rather than the page going blank.
 */
export const useEditorShown = (): boolean => React.useSyncExternalStore(subscribe, () => shown, () => false);
