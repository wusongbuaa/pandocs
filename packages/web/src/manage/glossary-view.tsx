import * as React from "react";
import { parseDocument, visibleTextOf } from "@pandocs/markdown";
import { Button } from "@/components/ui/button";
import { Form, SearchSelectField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import type { DocumentView, Space, TreeEntry } from "../types";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { ManageHead, RowsEditor, pageChoices } from "./parts";
import { t } from "../i18n";

/** Every two-column-or-wider table on a page reads as term and explanation, with its header row left out. */
export function termsInMarkdown(markdown: string): readonly { term: string; definition: string }[] {
  const terms: { term: string; definition: string }[] = [];
  for (const node of parseDocument(markdown).tree.children) {
    if (node.type !== "table") continue;
    for (const row of node.children.slice(1)) {
      const [term, definition] = row.children.map(cell => visibleTextOf(cell).trim());
      if (term && definition) terms.push({ term, definition });
    }
  }
  return terms;
}

function ImportFromPage({ space, rows, onImported }: { space: Space; rows: readonly { term: string }[]; onImported: (terms: readonly { term: string; definition: string }[]) => void }) {
  const tree = useLoaded(() => api.get<TreeEntry[]>(`spaces/${space.slug}/tree`), [space.slug]);
  const [pageId, setPageId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const pull = async () => {
    setBusy(true);
    try {
      const { markdown = "" } = await api.get<DocumentView>(`documents/${pageId}`);
      const found = termsInMarkdown(markdown);
      const known = new Set(rows.map(row => row.term));
      const fresh = found.filter(item => !known.has(item.term));
      if (found.length === 0) toast(t("This page has no table. A table's first column holds the term and the second its meaning."));
      else toast(t("Found {0} {0|term|terms}, {1} new. Save to keep them.", found.length, fresh.length));
      onImported(fresh);
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pd-glossary-import">
      <SearchSelectField label={t("Import from a table on a page")} value={pageId} onChange={setPageId} choices={pageChoices((tree.status === "ready" ? tree.data : []).filter(entry => entry.hasContent), { value: "", label: t("Choose a page") })} />
      <Button variant="outline" disabled={!pageId || busy} onClick={() => void pull()}>{t("Import")}</Button>
    </div>
  );
}

export function GlossaryView({ space }: { space: Space }) {
  const [rows, setRows] = React.useState(() => space.glossary.map(entry => ({ term: entry.term, definition: entry.definition })));
  const [busy, setBusy] = React.useState(false);
  const save = async () => {
    await api.send("PATCH", `spaces/${space.slug}`, { body: { glossary: rows.filter(row => row.term.trim() && row.definition.trim()) } });
    // Pages are rendered with the terms they were loaded with.
    location.reload();
  };
  return (
    <>
      <ManageHead title={t("{0}: glossary", space.name)} description={t("These words get a dotted underline the first time they appear on a page, and hovering shows their meaning.")} />
      <ImportFromPage space={space} rows={rows} onImported={terms => setRows([...rows, ...terms])} />
      <Form className="pd-form pd-form--wide" onSubmit={save} onBusyChange={setBusy}>
        <RowsEditor rows={rows} columns={[{ key: "term", label: t("Term") }, { key: "definition", label: t("Meaning") }]} blank={{ term: "", definition: "" }} addLabel={t("Add a term")} onChange={setRows} />
        <div><Button type="submit" disabled={busy}>{t("Save")}</Button></div>
      </Form>
    </>
  );
}
