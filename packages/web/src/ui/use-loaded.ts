import * as React from "react";
import { failureMessage } from "../api/client";
import { t } from "../i18n";

export type Loaded<T> = { readonly status: "loading" } | { readonly status: "failed"; readonly message: string } | { readonly status: "ready"; readonly data: T };

/** Reloading keeps showing what is there until the new data arrives, so lists do not flash empty after every action. */
export function useLoaded<T>(load: () => Promise<T>, deps: React.DependencyList): Loaded<T> & { reload(): void } {
  const [state, setState] = React.useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    let current = true;
    load().then(
      data => { if (current) setState({ status: "ready", data }); },
      error => { if (current) setState({ status: "failed", message: failureMessage(error, t("Could not load this. Try again later.")) }); }
    );
    return () => { current = false; };
    // The caller lists what `load` depends on, as with useEffect.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);
  const reload = React.useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, reload };
}
