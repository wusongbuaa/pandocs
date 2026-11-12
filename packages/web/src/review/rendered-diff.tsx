import * as React from "react";
import { useMDXComponents } from "@mdx-js/react";
import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { sourceBlocks } from "@pandocs/markdown";
import { dialectComponents } from "../markdown/blocks";
import { renderMarkdown } from "../markdown/pipeline";
import { ReaderContextProvider, type ReaderContextValue } from "../markdown/reader-context";
import { collapseUnchanged, diffBlocks, markRanges, textOfHast, wordChanges, type CollapsedRow } from "./diff-blocks";
import { t } from "../i18n";

type RenderedRow =
  | { readonly kind: "collapsed"; readonly count: number }
  | { readonly kind: "same" | "added" | "removed"; readonly hast: Root }
  | { readonly kind: "changed"; readonly before: Root; readonly after: Root };

const render = async (text: string) => (await renderMarkdown(text, { title: "" })).hast;

async function renderRow(row: CollapsedRow): Promise<RenderedRow> {
  switch (row.kind) {
    case "collapsed":
      return row;
    case "changed": {
      const [before, after] = await Promise.all([render(row.before), render(row.after)]);
      const changes = wordChanges(textOfHast(before), textOfHast(after));
      if (changes) {
        markRanges(before, changes.removed, "pd-diff-del");
        markRanges(after, changes.added, "pd-diff-add");
      }
      return { kind: "changed", before, after };
    }
    default:
      return { kind: row.kind, hast: await render(row.text) };
  }
}

/** Two versions as readers see them, block by block, instead of a Markdown patch. */
export function RenderedDiff({ before, after, reader }: { before: string; after: string; reader: ReaderContextValue }) {
  const provided = useMDXComponents();
  const [rows, setRows] = React.useState<readonly RenderedRow[] | null>(null);
  React.useEffect(() => {
    let current = true;
    setRows(null);
    const collapsed = collapseUnchanged(diffBlocks(sourceBlocks(before), sourceBlocks(after)));
    void Promise.all(collapsed.map(renderRow)).then(result => { if (current) setRows(result); });
    return () => { current = false; };
  }, [before, after]);
  const components = React.useMemo(() => ({ ...provided, ...dialectComponents }) as never, [provided]);
  const show = (hast: Root) => toJsxRuntime(hast, { Fragment, jsx, jsxs, components, ignoreInvalidStyle: true, passKeys: true });
  if (!rows) return <p className="pd-muted">{t("Comparing…")}</p>;
  const changed = rows.some(row => row.kind !== "same" && row.kind !== "collapsed");
  return (
    <ReaderContextProvider value={reader}>
      <div className="pd-diff">
        {changed ? null : <p className="pd-muted">{t("These two versions are the same.")}</p>}
        {rows.map((row, index) => {
          switch (row.kind) {
            case "collapsed":
              return <p key={index} className="pd-diff__collapsed">{t("{0} unchanged {0|block|blocks}", row.count)}</p>;
            case "changed":
              return (
                <React.Fragment key={index}>
                  <div className="pd-diff__row pd-diff__row--removed">{show(row.before)}</div>
                  <div className="pd-diff__row pd-diff__row--added">{show(row.after)}</div>
                </React.Fragment>
              );
            case "same":
              return <div key={index} className="pd-diff__row">{show(row.hast)}</div>;
            default:
              return <div key={index} className={`pd-diff__row pd-diff__row--${row.kind}`}>{show(row.hast)}</div>;
          }
        })}
      </div>
    </ReaderContextProvider>
  );
}
