import * as React from "react";

export type ToastTone = "info" | "success" | "error";
export interface PendingToast { readonly message: string; readonly tone: ToastTone }

let waiting: PendingToast[] = [];
let deliver: ((item: PendingToast) => void) | null = null;
let asked = false;
const listeners = new Set<() => void>();

/** Called from anywhere, including outside any component. What shows them only loads with the first one. */
export function toast(message: string, tone: ToastTone = "info"): void {
  if (deliver) {
    deliver({ message, tone });
    return;
  }
  waiting.push({ message, tone });
  asked = true;
  listeners.forEach(listener => listener());
}

/** For the host, once it is there: what arrived before it did, and where the next ones go. */
export function receiveToasts(handler: (item: PendingToast) => void): () => void {
  deliver = handler;
  const earlier = waiting;
  waiting = [];
  earlier.forEach(handler);
  return () => { deliver = null; };
}

const ToastHost = React.lazy(() => import("./toast-host"));

export function Toaster() {
  const needed = React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => asked, () => false);
  return needed ? <React.Suspense fallback={null}><ToastHost /></React.Suspense> : null;
}
