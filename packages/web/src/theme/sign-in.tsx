import * as React from "react";
import { app } from "../data/runtime-data";
import { embedded } from "../embed/session";
import { insideSite, sitePath } from "../data/site-base";

/** What signing in is for, and where to go once it is done. */
export interface SignInRequest {
  /** One sentence on what signing in lets them do here. */
  readonly reason?: string | undefined;
  /** A path on this site. Left out, they stay on the page they are on. */
  readonly next?: string | undefined;
}

/** Someone reading a public space with no login, on the site itself rather than inside another system or through a share link. */
export const isVisitor = (): boolean => app.bootstrap.me.anonymous === true && !embedded;

/** `next` is where the browser goes afterwards, which the server takes below the site's path. */
export const loginPageFor = (next: string) => sitePath(`/login?${new URLSearchParams({ next: insideSite(next) })}`);

let current: SignInRequest | null = null;
const listeners = new Set<() => void>();

function setRequest(request: SignInRequest | null): void {
  current = request;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Signing in over the page rather than on another one, so what they were reading stays where it was. */
export function askToSignIn(request: SignInRequest = {}): void {
  setRequest(request);
}

const SignInDialog = React.lazy(() => import("./sign-in-dialog"));

/** Visitors only: everyone else is signed in, or has their identity from another system or a share link. */
export function SignInHost() {
  const request = React.useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  );
  if (!request || !isVisitor()) return null;
  return (
    <React.Suspense fallback={null}>
      <SignInDialog request={request} onClose={() => setRequest(null)} />
    </React.Suspense>
  );
}
