import type * as React from "react";
import { Tooltip as Base } from "@base-ui/react/tooltip";

const DELAY_MS = 300;

/** What an icon button does, in the app's own look and without the wait of the browser's `title`. */
export function Tip({ label, side, children }: { readonly label: string | undefined; readonly side?: "top" | "bottom" | "left" | "right"; readonly children: React.ReactElement<Record<string, unknown>> }) {
  if (!label) return children;
  return (
    <Base.Root>
      <Base.Trigger delay={DELAY_MS} render={children} />
      <Base.Portal>
        <Base.Positioner className="pd-floating" positionMethod="fixed" side={side ?? "top"} sideOffset={6}>
          <Base.Popup className="pd-tip">{label}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
