import * as React from "react";
import { X } from "lucide-react";
import { Toast, ToastClose, ToastContent, ToastPortal, ToastProvider, ToastTitle, ToastViewport, createToastManager, useToastManager } from "@/components/ui/toast";
import { CircleCheck, CircleX, Info } from "lucide-react";
import { t } from "../i18n";
import { receiveToasts, type ToastTone } from "./toast";
import "../styles/kit.css";

const manager = createToastManager();
const TIMEOUT: Record<ToastTone, number> = { info: 3000, success: 3000, error: 6000 };

function ToneIcon({ tone }: { readonly tone: string | undefined }) {
  if (tone === "success") return <CircleCheck className="size-4 shrink-0 text-(--rp-c-brand)" aria-hidden="true" />;
  if (tone === "error") return <CircleX className="size-4 shrink-0 text-destructive" aria-hidden="true" />;
  return <Info className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function Toasts() {
  const { toasts } = useToastManager();
  return toasts.map(item => (
    <Toast key={item.id} toast={item}>
      <ToastContent>
        <ToneIcon tone={item.type} />
        <div className="flex min-w-0 flex-1 flex-col gap-1"><ToastTitle /></div>
        <ToastClose aria-label={t("Close")}><X aria-hidden="true" /></ToastClose>
      </ToastContent>
    </Toast>
  ));
}

export default function ToastHost() {
  React.useEffect(() => receiveToasts(({ message, tone }) => { manager.add({ title: message, type: tone, timeout: TIMEOUT[tone] }); }), []);
  return (
    <ToastProvider toastManager={manager}>
      <ToastPortal>
        <ToastViewport>
          <Toasts />
        </ToastViewport>
      </ToastPortal>
    </ToastProvider>
  );
}
