import * as React from "react";

/**
 * While a dialog covers the page, which stops it scrolling, the room kept for the scrollbar shows the page's own
 * background. This marks the page for as long as one is open, so that CSS can cover that too. Selecting with `:has()`
 * needs no code, but Firefox keeps that style after the dialog has gone.
 */
export function useCoveredPage(): void {
  React.useEffect(() => {
    const html = document.documentElement;
    html.dataset.pdCovered = String(Number(html.dataset.pdCovered ?? 0) + 1);
    return () => {
      const left = Number(html.dataset.pdCovered ?? 1) - 1;
      if (left > 0) html.dataset.pdCovered = String(left);
      else delete html.dataset.pdCovered;
    };
  }, []);
}
