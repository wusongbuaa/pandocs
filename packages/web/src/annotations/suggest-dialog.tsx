import * as React from "react";
import { api } from "../api/client";
import type { PandocsPage } from "../data/pages";
import { FormDialog } from "../ui/dialog";
import { FieldShell, TextareaField } from "../ui/form";
import { toast } from "../ui/toast";
import type { Target } from "./suggestion-target";
import { t } from "../i18n";

export default function SuggestDialog({
  page,
  target,
  draft,
  onClose,
  onSubmitted
}: {
  page: PandocsPage;
  target: Target;
  draft?: string | undefined;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  // A rewrite of the selected words can stand in for them, but not for the whole blocks around them.
  const [content, setContent] = React.useState(draft && target.exact ? draft : target.source);
  const reference = draft && !target.exact ? draft : null;
  const [rationale, setRationale] = React.useState("");
  const submit = async () => {
    await api.send("POST", `documents/${page.entry.id}/proposals`, {
      body: { baseRevision: page.view.revision.no, ops: target.ops(content), rationale }
    });
    toast(t("Suggestion sent. Someone with edit access will review it."), "success");
    onSubmitted?.();
    onClose();
  };
  return (
    <FormDialog
      title={t("Suggest changes")}
      description={t("Someone with edit access reviews it. The page does not change until then.")}
      action={t("Send suggestion")}
      disabled={content === target.source}
      onClose={onClose}
      onSubmit={submit}
    >
      {reference ? (
        <FieldShell label={t("Rewritten by AI, for reference")}>
          <p className="pd-assist__reference">{reference}</p>
        </FieldShell>
      ) : null}
      <TextareaField
        label={t("Change to")}
        mono
        autoFocus
        rows={Math.min(12, Math.max(3, target.source.split("\n").length + 1))}
        value={content}
        onChange={event => setContent(event.target.value)}
      />
      <TextareaField
        label={t("Note (optional)")}
        rows={2}
        value={rationale}
        placeholder={t("Why this change")}
        onChange={event => setRationale(event.target.value)}
      />
    </FormDialog>
  );
}
