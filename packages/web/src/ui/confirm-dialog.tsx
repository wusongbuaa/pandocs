import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { t } from "../i18n";
import type { ConfirmRequest } from "./confirm";
import { useCoveredPage } from "./covered-page";
import "../styles/kit.css";

export default function ConfirmDialog({ request, onFinish }: { readonly request: ConfirmRequest; readonly onFinish: (result: boolean) => void }) {
  useCoveredPage();
  return (
    <AlertDialog open onOpenChange={open => { if (!open) onFinish(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request.title}</AlertDialogTitle>
          {request.description ? <AlertDialogDescription>{request.description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("Cancel")}</AlertDialogCancel>
          <Button autoFocus variant={request.danger ? "destructive" : "default"} onClick={() => onFinish(true)}>{request.action}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
