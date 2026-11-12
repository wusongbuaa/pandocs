import * as React from "react";
import { useSearchParams } from "@rspress/core/runtime";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { TreeEntry } from "../types";
import { ChoiceSelect, type Choice } from "../ui/form";
import type { Loaded } from "../ui/use-loaded";
import { t } from "../i18n";

/** The pages of a space for choosing among, indented the way they nest, after a first choice like "top level". */
export function pageChoices(
  tree: readonly TreeEntry[],
  first: Choice,
  valueOf: (entry: TreeEntry) => string = entry => entry.id
): readonly Choice[] {
  return [
    first,
    ...tree.map(entry => ({ value: valueOf(entry), label: entry.title, depth: entry.path.split("/").length - 1 }))
  ];
}

/** A link saying `?new=1` arrives with the dialog open: starting on an empty list should not take two clicks. */
export function useOpenFromLink(open: () => void, param = "new") {
  const [params, setParams] = useSearchParams();
  const asked = params.has(param);
  React.useEffect(() => {
    if (!asked) return;
    open();
    setParams(
      current => {
        current.delete(param);
        return current;
      },
      { replace: true }
    );
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- it only happens on the way in
  }, [asked]);
}

export function ManageHead({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="pd-manage__head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {children ? <div className="pd-manage__head-actions">{children}</div> : null}
    </header>
  );
}

/** Loading and failure look the same on every page. */
export function LoadedContent<T>({ loaded, children }: { loaded: Loaded<T>; children: (data: T) => React.ReactNode }) {
  if (loaded.status === "loading")
    return (
      <p className="pd-manage__loading">
        <Spinner aria-label={t("Loading…")} />
        {t("Loading…")}
      </p>
    );
  if (loaded.status === "failed") return <p className="pd-manage__error">{loaded.message}</p>;
  return <>{children(loaded.data)}</>;
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <Empty className="pd-manage__empty">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}

interface Column<Row> {
  readonly key: keyof Row & string;
  readonly label: string;
  readonly placeholder?: string;
  /** Known values to choose among, instead of typing one. */
  readonly options?: readonly string[];
}

/** A small table of repeated settings: every row edits in place, and saving sends the whole list. */
export function RowsEditor<Row extends Record<string, string | undefined>>({
  rows,
  columns,
  blank,
  onChange,
  addLabel
}: {
  rows: readonly Row[];
  columns: readonly Column<Row>[];
  blank: Row;
  onChange: (rows: Row[]) => void;
  addLabel: string;
}) {
  const update = (at: number, key: string, value: string) =>
    onChange(rows.map((row, index) => (index === at ? { ...row, [key]: value } : row)));
  return (
    <div className="pd-rows">
      {rows.map((row, at) => (
        <div className="pd-rows__row" key={at}>
          {columns.map(column =>
            column.options ? (
              <ChoiceSelect
                key={column.key}
                label={column.label}
                placeholder={column.placeholder ?? column.label}
                value={row[column.key] ?? ""}
                choices={[...new Set([...(row[column.key] ? [row[column.key]!] : []), ...column.options])].map(
                  value => ({ value, label: value })
                )}
                onChange={value => update(at, column.key, value)}
              />
            ) : (
              <Input
                key={column.key}
                aria-label={column.label}
                placeholder={column.placeholder ?? column.label}
                value={row[column.key] ?? ""}
                onChange={event => update(at, column.key, event.target.value)}
              />
            )
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("Delete this row")}
            onClick={() => onChange(rows.filter((_, index) => index !== at))}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" onClick={() => onChange([...rows, blank])}>
        <Plus aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}
