import type * as React from "react";
import { Menu as Base } from "@base-ui/react/menu";
import clsx from "clsx";

interface ContentProps {
  readonly className?: string;
  readonly align?: "start" | "center" | "end";
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly sideOffset?: number;
  readonly children: React.ReactNode;
}

function Content({ className, align, side, sideOffset, children }: ContentProps) {
  return (
    <Base.Portal>
      <Base.Positioner className="pd-floating" positionMethod="fixed" align={align} side={side} sideOffset={sideOffset}>
        <Base.Popup className={clsx("pd-menu", className)}>{children}</Base.Popup>
      </Base.Positioner>
    </Base.Portal>
  );
}

/** A menu next to what opened it leaves the page as it is: still scrollable, with its scrollbar, and clicks outside just close it. */
function Root<Payload>({ modal = false, ...rest }: React.ComponentProps<typeof Base.Root<Payload>>) {
  return <Base.Root modal={modal} {...rest} />;
}

function Item({ className, ...rest }: React.ComponentProps<typeof Base.Item>) {
  return <Base.Item className={clsx("pd-menu__item", className as string | undefined)} {...rest} />;
}

function LinkItem({ className, ...rest }: React.ComponentProps<typeof Base.LinkItem>) {
  return <Base.LinkItem className={clsx("pd-menu__item", className as string | undefined)} {...rest} />;
}

/**
 * Menus anywhere in the app. The behaviour is Base UI's and the look is the theme's own dropdown, in plain CSS, because
 * these show on a reader's first page, which should not have to load the form kit.
 */
export const Menu = { Root, Trigger: Base.Trigger, Content, Item, LinkItem, Separator: Base.Separator };
