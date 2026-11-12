import * as React from "react";
import { Link2 } from "lucide-react";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

const ShareDialog = React.lazy(() => import("./share-dialog"));

export function ShareButton({ documentId }: { documentId: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Tip label={t("Share")}>
        <button
          type="button"
          className="rp-llms-button pd-action pd-action--icon"
          aria-label={t("Share")}
          onClick={() => setOpen(true)}
        >
          <Link2 size={16} aria-hidden="true" />
        </button>
      </Tip>
      {open ? (
        <React.Suspense fallback={null}>
          <ShareDialog documentId={documentId} onClose={() => setOpen(false)} />
        </React.Suspense>
      ) : null}
    </>
  );
}
