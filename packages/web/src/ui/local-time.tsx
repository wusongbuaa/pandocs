import * as React from "react";
import { formatTime } from "./time";

const unchanging = () => () => undefined;
/** A server does not know where its reader is. React shows this until the page is live, and then the local time. */
const utc = (at: string) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function LocalTime({ at }: { readonly at: string }) {
  const text = React.useSyncExternalStore(unchanging, () => formatTime(at), () => utc(at));
  return <time dateTime={at}>{text}</time>;
}
