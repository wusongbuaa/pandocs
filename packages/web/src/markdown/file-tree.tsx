import * as React from "react";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { t } from "../i18n";

export interface FileTreeNode {
  readonly name: string;
  readonly comment: string;
  readonly folder: boolean;
  readonly children: readonly FileTreeNode[];
}

const LINE = /^([ \t│|]*)((?:├|└|\||`)(?:──|--)\s*|[-*+]\s+)?(.*)$/u;
const COMMENT = /\s+(?:#|\/\/)\s*(.*)$/u;

/** Reads what `tree` prints and plain indented lists alike: only how far in a line starts matters. */
export function parseFileTree(source: string): FileTreeNode[] {
  interface Draft {
    name: string;
    comment: string;
    explicitFolder: boolean;
    indent: number;
    children: Draft[];
  }
  const roots: Draft[] = [];
  const stack: Draft[] = [];
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const [, prefix = "", marker = "", rest = ""] = LINE.exec(line) ?? [];
    const indent = prefix.length + (marker ? 4 : 0);
    const comment = COMMENT.exec(rest)?.[1] ?? "";
    const name = rest.replace(COMMENT, "").trim();
    if (!name) continue;
    const draft: Draft = {
      name: name.replace(/\/$/u, ""),
      comment,
      explicitFolder: name.endsWith("/"),
      indent,
      children: []
    };
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    (stack.at(-1)?.children ?? roots).push(draft);
    stack.push(draft);
  }
  const finish = (draft: Draft): FileTreeNode => ({
    name: draft.name,
    comment: draft.comment,
    folder: draft.explicitFolder || draft.children.length > 0,
    children: draft.children.map(finish)
  });
  return roots.map(finish);
}

function TreeRow({ node }: { node: FileTreeNode }) {
  const [open, setOpen] = React.useState(true);
  const label = (
    <>
      <span className="pd-file-tree__name">{node.name}</span>
      {node.comment ? <span className="pd-file-tree__comment">{node.comment}</span> : null}
    </>
  );
  if (!node.folder)
    return (
      <li>
        <span className="pd-file-tree__row">
          <span className="pd-file-tree__chevron" />
          <File size={15} aria-hidden="true" />
          {label}
        </span>
      </li>
    );
  return (
    <li>
      <button type="button" className="pd-file-tree__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="pd-file-tree__chevron">
          {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        </span>
        <Folder size={15} aria-hidden="true" />
        {label}
      </button>
      {open && node.children.length > 0 ? (
        <ul>
          {node.children.map((child, index) => (
            <TreeRow key={`${child.name}-${index}`} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function FileTree({ source, title }: { source: string; title?: string | undefined }) {
  const nodes = React.useMemo(() => parseFileTree(source), [source]);
  return (
    <figure className="pd-file-tree rp-not-doc" data-pandocs-nontext="">
      {title ? <figcaption>{title}</figcaption> : null}
      <ul role="tree" aria-label={title ?? t("File tree")}>
        {nodes.map((node, index) => (
          <TreeRow key={`${node.name}-${index}`} node={node} />
        ))}
      </ul>
    </figure>
  );
}
