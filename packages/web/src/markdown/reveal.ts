import * as React from "react";
import { useLocation } from "@rspress/core/runtime";

/** Sent with the element a link leads to, for whatever hides it to show it: tabs listen for it. */
export const REVEAL_EVENT = "pandocs:reveal";

const HIDDEN = "details:not([open]), .rp-tabs__content__item--hidden";

function targetOf(hash: string): HTMLElement | null {
  if (hash.length < 2) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return document.getElementById(hash.slice(1));
  }
}

/** Opens the folded blocks around an element and the tab it is in, so it can be seen. */
export function revealTarget(target: Element): void {
  for (let at = target.parentElement; at; at = at.parentElement) {
    if (at instanceof HTMLDetailsElement) at.open = true;
  }
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: target }));
}

/**
 * A link to a part of the page that sits in a folded block or a tab not chosen leads to nothing to see, and the theme
 * scrolls nowhere. Opening a page at such an address the browser handles for folded blocks only, and moving within the
 * app not at all, so both open what is around it and scroll there again.
 */
export function useRevealLinkTarget(): void {
  const { hash } = useLocation();
  React.useEffect(() => {
    const reveal = () => {
      const target = targetOf(location.hash);
      if (!target?.closest(HIDDEN)) return;
      revealTarget(target);
      target.scrollIntoView({ block: "start" });
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [hash]);
}

/**
 * What is folded away is printed, and folded again afterwards. Tabs print every pane through the stylesheet. A second
 * print starting before the first has ended adds to what is folded again, rather than forgetting it.
 */
export function usePrintsWhatIsFolded(): void {
  React.useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      for (const details of document.querySelectorAll<HTMLDetailsElement>(".rp-doc details:not([open])")) {
        details.open = true;
        opened.push(details);
      }
    };
    const after = () => {
      for (const details of opened) details.open = false;
      opened = [];
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
}
