import * as React from "react";
import { Plus, X } from "lucide-react";
import { Popover } from "../ui/popover";
import { Link } from "@rspress/core/theme";
import { api, failureMessage } from "../api/client";
import { documentRoute } from "../data/paths";
import { shared } from "../embed/session";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast, type SearchHit } from "../types";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { t } from "../i18n";

const NewLabel = React.lazy(() => import("./new-label"));

/** Asked for when someone opens it: which pages have a label is up to date only on the server. */
function PagesWithLabel({ label, space, here }: { label: string; space: string; here: string }) {
  const pages = useLoaded(
    () => api.get<SearchHit[]>(`search?label=${encodeURIComponent(label)}&space=${encodeURIComponent(space)}`),
    [label, space]
  );
  if (pages.status !== "ready")
    return <p className="pd-label-pages__note">{pages.status === "failed" ? pages.message : t("Loading…")}</p>;
  const others = pages.data.filter(page => page.id !== here);
  if (others.length === 0) return <p className="pd-label-pages__note">{t("No other page has this label.")}</p>;
  return (
    <ul className="pd-label-pages__list">
      {others.map(page => (
        <li key={page.id}>
          <Link href={documentRoute(page.spaceSlug, page.path)}>{page.title}</Link>
        </li>
      ))}
    </ul>
  );
}

function LabelsOf({
  documentId,
  space,
  initial,
  canEdit
}: {
  documentId: string;
  space: string;
  initial: readonly string[];
  canEdit: boolean;
}) {
  const [labels, setLabels] = React.useState(initial);
  const [adding, setAdding] = React.useState(false);
  const save = async (next: readonly string[]) => {
    try {
      setLabels(
        (await api.send<{ labels: string[] }>("PUT", `documents/${documentId}/labels`, { body: { labels: next } }))
          .labels
      );
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  if (labels.length === 0 && !canEdit) return null;
  return (
    <div className="pd-labels" role="group" aria-label={t("Labels")} data-pandocs-nontext="">
      {labels.map(label => (
        <span className="pd-label" key={label}>
          <Popover.Root>
            <Popover.Trigger className="pd-label__name">{label}</Popover.Trigger>
            <Popover.Content className="pd-label-pages" align="start" sideOffset={6}>
              <strong>{t('Pages labelled "{0}"', label)}</strong>
              <PagesWithLabel label={label} space={space} here={documentId} />
            </Popover.Content>
          </Popover.Root>
          {canEdit ? (
            <button
              type="button"
              className="pd-label__remove"
              aria-label={t('Remove the label "{0}"', label)}
              onClick={() => void save(labels.filter(item => item !== label))}
            >
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      ))}
      {canEdit && adding ? (
        <React.Suspense fallback={null}>
          <NewLabel
            space={space}
            taken={labels}
            onCancel={() => setAdding(false)}
            onAdd={label => {
              setAdding(false);
              void save([...labels, label]);
            }}
          />
        </React.Suspense>
      ) : null}
      {canEdit && !adding ? (
        <button type="button" className="pd-label pd-label--add" onClick={() => setAdding(true)}>
          <Plus size={12} aria-hidden="true" />
          {t("Label")}
        </button>
      ) : null}
    </div>
  );
}

/** Under the page's title, for what kind of page this is and what else is like it. */
export function PageLabels() {
  const page = useAppPage();
  // Going from a label to other pages is no use to someone who can only read one.
  if (page?.kind !== "document" || shared) return null;
  return (
    <LabelsOf
      key={page.entry.id}
      documentId={page.entry.id}
      space={page.space.slug}
      initial={page.view.labels}
      canEdit={!app.bootstrap.me.anonymous && !page.translation?.exists && atLeast(page.view.role, "editor")}
    />
  );
}
