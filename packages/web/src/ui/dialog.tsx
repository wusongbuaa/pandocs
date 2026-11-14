import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog as Root,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { t } from "../i18n";
import { useCoveredPage } from "./covered-page";
import { Form, type FormProps } from "./form";
import "../styles/kit.css";

interface DialogProps {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly onClose: () => void;
  readonly wide?: boolean | undefined;
}

/** Last in the order, so that opening a dialog starts on what it asks for rather than on leaving it. */
function CloseButton() {
  return (
    <DialogClose
      render={<Button variant="ghost" size="icon-sm" className="absolute top-2 right-2" aria-label={t("Close")} />}
    >
      <X aria-hidden="true" />
    </DialogClose>
  );
}

export function Dialog({ title, description, children, footer, onClose, wide }: DialogProps) {
  useCoveredPage();
  return (
    <Root
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className={wide ? "sm:max-w-[960px]" : "sm:max-w-[480px]"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? (
          <div className="rp-scrollbar -mx-4 flex max-h-[calc(100vh-200px)] flex-col gap-4 overflow-y-auto px-4 py-1">
            {children}
          </div>
        ) : null}
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
        <CloseButton />
      </DialogContent>
    </Root>
  );
}

/** A dialog that asks for something: Enter submits it, and it says what is wrong next to the field. */
export function FormDialog({
  action,
  danger,
  disabled,
  onSubmit,
  fieldFor,
  extra,
  cancelLabel,
  ...dialog
}: DialogProps &
  Pick<FormProps, "onSubmit" | "fieldFor"> & {
    readonly action: string;
    readonly danger?: boolean;
    readonly disabled?: boolean | undefined;
    readonly extra?: React.ReactNode;
    readonly cancelLabel?: string;
  }) {
  const [busy, setBusy] = React.useState(false);
  const { title, description, children, onClose, wide } = dialog;
  useCoveredPage();
  return (
    <Root
      open
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogContent showCloseButton={false} className={wide ? "sm:max-w-[960px]" : "sm:max-w-[480px]"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <Form className="contents" onSubmit={onSubmit} onBusyChange={setBusy} {...(fieldFor ? { fieldFor } : {})}>
          <div className="rp-scrollbar -mx-4 flex max-h-[calc(100vh-200px)] flex-col gap-4 overflow-y-auto px-4 py-1">
            {children}
          </div>
          <DialogFooter>
            {extra}
            <Button type="button" variant="outline" onClick={onClose}>
              {cancelLabel ?? t("Cancel")}
            </Button>
            <Button type="submit" variant={danger ? "destructive" : "default"} disabled={busy || (disabled ?? false)}>
              {action}
            </Button>
          </DialogFooter>
        </Form>
        <CloseButton />
      </DialogContent>
    </Root>
  );
}
