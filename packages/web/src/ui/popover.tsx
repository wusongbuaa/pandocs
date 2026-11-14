import type * as React from "react";
import { Popover as Base } from "@base-ui/react/popover";

interface ContentProps {
  readonly className?: string;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly sideOffset?: number;
  readonly collisionPadding?: number;
  readonly children: React.ReactNode;
}

function Content({ className, align, side, sideOffset, collisionPadding, children }: ContentProps) {
  return (
    <Base.Portal>
      <Base.Positioner
        className="pd-floating"
        positionMethod="fixed"
        align={align}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
      >
        <Base.Popup className={className}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

/** Floating panels on the page itself. Like `Menu`, plain CSS on Base UI's behaviour, for a reader's first load. */
export const Popover = { Root: Base.Root, Trigger: Base.Trigger, Content };
