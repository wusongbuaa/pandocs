import * as React from "react";

export interface ConfirmRequest {
  readonly title: string;
  readonly description?: string | undefined;
  readonly action: string;
  readonly danger?: boolean | undefined;
  resolve(result: boolean): void;
}

let request: ConfirmRequest | null = null;
const listeners = new Set<() => void>();
const publish = (next: ConfirmRequest | null) => {
  request = next;
  listeners.forEach(listener => listener());
};

/** A confirmation in the app's own look; resolves false when dismissed. */
export function confirm(options: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise(resolve => publish({ ...options, resolve }));
}

// A page can be read without anyone ever being asked anything.
const ConfirmDialog = React.lazy(() => import("./confirm-dialog"));

export function ConfirmHost() {
  const current = React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => request, () => null);
  if (!current) return null;
  const finish = (result: boolean) => {
    current.resolve(result);
    publish(null);
  };
  return <React.Suspense fallback={null}><ConfirmDialog request={current} onFinish={finish} /></React.Suspense>;
}
