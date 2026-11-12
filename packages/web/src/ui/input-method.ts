import * as React from "react";

/**
 * Whether a key belongs to an input method, such as the Enter that picks a word in Chinese or Japanese. Safari ends
 * the composition before it sends that Enter, so there only the key code says so.
 */
export function fromInputMethod(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return native.isComposing || native.keyCode === 229;
}

/** The theme's search would take that Enter as choosing a result. It listens on the document, so this goes first. */
export function useSearchIgnoresInputMethod(): void {
  React.useEffect(() => {
    const ignore = (event: KeyboardEvent) => {
      if (event.code === "Enter" && fromInputMethod(event) && event.target instanceof Element && event.target.closest(".rp-search-panel__modal")) event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", ignore, true);
    return () => window.removeEventListener("keydown", ignore, true);
  }, []);
}
