import * as React from "react";
import copy from "copy-to-clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, failureMessage } from "../api/client";
import { app } from "../data/runtime-data";
import { FormDialog } from "../ui/dialog";
import { SelectField, SwitchField } from "../ui/form";
import { formatTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { t } from "../i18n";
import { sitePath } from "../data/site-base";

interface ShareLink {
  readonly id: string;
  readonly path: string;
  readonly includeChildren: boolean;
  readonly createdName: string;
  readonly expiresAt: string | null;
}

const NEVER = "never";

export default function ShareDialog({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const links = useLoaded(() => api.get<ShareLink[]>(`documents/${documentId}/share-links`), [documentId]);
  const [days, setDays] = React.useState("7");
  const [includeChildren, setIncludeChildren] = React.useState(false);
  const addressOf = (link: ShareLink) => `${app.origin}${sitePath(link.path)}`;
  const copied = (link: ShareLink) => {
    copy(addressOf(link));
    toast(t("Link copied"), "success");
  };
  const create = async () => {
    const link = await api.send<ShareLink>("POST", `documents/${documentId}/share-links`, {
      body: { includeChildren, expiresInDays: days === NEVER ? null : Number(days) }
    });
    copied(link);
    links.reload();
  };
  const revoke = async (link: ShareLink) => {
    try {
      await api.send("DELETE", `share-links/${link.id}`);
      links.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <FormDialog
      title={t("Share by link")}
      description={t(
        "Anyone with a link can read this page without signing in, until it expires or you revoke it. They cannot comment or see anything else."
      )}
      action={t("Create a link")}
      cancelLabel={t("Close")}
      onClose={onClose}
      onSubmit={create}
    >
      {links.status === "ready" && links.data.length > 0 ? (
        <ul className="pd-share-links">
          {links.data.map(link => (
            <li key={link.id}>
              <Input readOnly aria-label={t("Link")} value={addressOf(link)} onFocus={event => event.target.select()} />
              <span className="pd-share-links__actions">
                <Button type="button" variant="outline" onClick={() => copied(link)}>
                  {t("Copy")}
                </Button>
                <Button type="button" variant="outline" onClick={() => void revoke(link)}>
                  {t("Revoke")}
                </Button>
              </span>
              <small>
                {[
                  link.expiresAt ? t("Expires {0}", formatTime(link.expiresAt)) : t("Never expires"),
                  ...(link.includeChildren ? [t("With subpages")] : []),
                  t("By {0}", link.createdName)
                ].join(" · ")}
              </small>
            </li>
          ))}
        </ul>
      ) : null}
      {links.status === "failed" ? <p className="pd-muted">{links.message}</p> : null}
      <SelectField
        label={t("Expires")}
        value={days}
        onChange={setDays}
        choices={[
          { value: "1", label: t("In a day") },
          { value: "7", label: t("In 7 days") },
          { value: "30", label: t("In 30 days") },
          { value: "365", label: t("In a year") },
          { value: NEVER, label: t("Never") }
        ]}
      />
      <SwitchField
        label={t("Include its subpages, now and later, except those only some people can read")}
        checked={includeChildren}
        onChange={setIncludeChildren}
      />
    </FormDialog>
  );
}
