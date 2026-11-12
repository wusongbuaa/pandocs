import * as React from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, GripVertical, Lock, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Menu } from "../ui/menu";
import { api, failureMessage } from "../api/client";
import { documentRoute, pageUrl } from "../data/paths";
import { atLeast, type Space, type TreeEntry } from "../types";
import { confirm } from "../ui/confirm";
import { relativeTime } from "../ui/time";
import { randomId } from "../ui/random-id";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead, useOpenFromLink } from "./parts";
import { MoveDialog, NewPageDialog, PermissionDialog, RenameDialog } from "./tree-dialogs";
import { t } from "../i18n";

export type DropPlace = "before" | "inside" | "after";

interface Row {
  readonly entry: TreeEntry;
  readonly depth: number;
  readonly hasChildren: boolean;
}

function rowsOf(tree: readonly TreeEntry[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const entry of tree.filter(item => item.parentId === parentId)) {
      const hasChildren = tree.some(item => item.parentId === entry.id);
      rows.push({ entry, depth, hasChildren });
      if (hasChildren && !collapsed.has(entry.id)) walk(entry.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** What to send for dropping one page at a place next to another; null when the page cannot go there. */
export function dropTarget(tree: readonly TreeEntry[], dragged: TreeEntry, target: TreeEntry, place: DropPlace): { parentId: string | null; beforeId: string | null } | null {
  if (target.id === dragged.id || target.path.startsWith(`${dragged.path}/`)) return null;
  if (place === "inside") return { parentId: target.id, beforeId: null };
  if (place === "before") return { parentId: target.parentId, beforeId: target.id };
  const siblings = tree.filter(entry => entry.parentId === target.parentId && entry.id !== dragged.id);
  return { parentId: target.parentId, beforeId: siblings[siblings.findIndex(entry => entry.id === target.id) + 1]?.id ?? null };
}

const placeAt = (event: React.DragEvent) => {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const y = event.clientY - box.top;
  return y < box.height * 0.25 ? "before" : y > box.height * 0.75 ? "after" : "inside";
};

type Dialogs =
  | { readonly kind: "new"; readonly parent: TreeEntry | null }
  | { readonly kind: "rename" | "move" | "permission"; readonly entry: TreeEntry }
  | null;

export function PagesView({ space }: { space: Space }) {
  const tree = useLoaded(() => api.get<TreeEntry[]>(`spaces/${space.slug}/tree`), [space.slug]);
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [dragged, setDragged] = React.useState<TreeEntry | null>(null);
  const [drop, setDrop] = React.useState<{ id: string; place: DropPlace } | null>(null);
  const [dialog, setDialog] = React.useState<Dialogs>(null);
  const reload = tree.reload;
  const entries = tree.status === "ready" ? tree.data : [];

  const unreadable = entries.filter(entry => /[^\x21-\x7e]/u.test(entry.slug));
  const shortenAddresses = async () => {
    const ok = await confirm({
      title: t("Replace {0} long {0|address|addresses} with short ones?", unreadable.length),
      description: t("Copied links stop being long runs of %E4%B8%80. Old links keep redirecting, and relative links in pages are rewritten, which adds a version to any page that changes."),
      action: t("Replace")
    });
    if (!ok) return;
    try {
      for (const entry of unreadable) await api.send("POST", `documents/${entry.id}/move`, { body: { slug: randomId().slice(0, 8) } });
      // The addresses in the sidebar come from when the app loaded.
      location.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
      reload();
    }
  };

  const send = async (entry: TreeEntry, body: { parentId?: string | null; beforeId?: string | null }) => {
    try {
      await api.send("POST", `documents/${entry.id}/move`, { body });
      reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const nudge = (entry: TreeEntry, step: -1 | 1) => {
    const siblings = entries.filter(item => item.parentId === entry.parentId);
    const at = siblings.findIndex(item => item.id === entry.id);
    const next = siblings[at + step];
    if (!next) return;
    // Moving down means going before whatever comes after the next one.
    void send(entry, { beforeId: step === -1 ? next.id : siblings[at + 2]?.id ?? null });
  };
  const remove = async (entry: TreeEntry) => {
    const below = entries.filter(item => item.path.startsWith(`${entry.path}/`)).length;
    const ok = await confirm({
      title: t("Delete \"{0}\"?", entry.title),
      description: below > 0 ? t("The {0} {0|subpage|subpages} below go to the trash with it. You can restore them from there.", below) : t("The page goes to the trash, and can be restored."),
      action: t("Move to trash"),
      danger: true
    });
    if (!ok) return;
    try {
      await api.send("DELETE", `documents/${entry.id}?recursive=true`);
      toast(t("Moved to trash"), "success");
      reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const finishDialog = () => {
    setDialog(null);
    reload();
  };
  useOpenFromLink(() => setDialog({ kind: "new", parent: null }));
  return (
    <>
      <ManageHead title={t("{0}: pages", space.name)} description={t("Drag pages to reorder them, or onto the middle of another page to put them under it. Old links redirect to the new address.")}>
        {unreadable.length > 0 ? <Button variant="outline" onClick={() => void shortenAddresses()}>{t("Use short addresses")}</Button> : null}
        <Button onClick={() => setDialog({ kind: "new", parent: null })}>{t("New page")}</Button>
      </ManageHead>
      <LoadedContent loaded={tree}>
        {data => data.length === 0 ? <EmptyState>{t("No pages yet.")}</EmptyState> : (
          <ul className="pd-tree" aria-label={t("Pages")}>
            {rowsOf(data, collapsed).map(({ entry, depth, hasChildren }) => {
              const target = dragged ? dropTarget(data, dragged, entry, "inside") : null;
              return (
                <li key={entry.id}
                  className={clsx("pd-tree__row", dragged?.id === entry.id && "pd-tree__row--dragging", drop?.id === entry.id && `pd-tree__row--${drop.place}`)}
                  style={{ paddingLeft: depth * 24 + 4 }}
                  draggable
                  onDragStart={event => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", entry.title); setDragged(entry); }}
                  onDragEnd={() => { setDragged(null); setDrop(null); }}
                  onDragOver={event => {
                    if (!target) return;
                    event.preventDefault();
                    setDrop({ id: entry.id, place: placeAt(event) });
                  }}
                  onDrop={event => {
                    event.preventDefault();
                    const goal = dragged ? dropTarget(data, dragged, entry, placeAt(event)) : null;
                    if (dragged && goal) void send(dragged, goal);
                    setDragged(null);
                    setDrop(null);
                  }}>
                  <GripVertical className="pd-tree__grip" size={14} aria-hidden="true" />
                  {hasChildren ? (
                    <button type="button" className="pd-icon-button pd-icon-button--small" aria-label={collapsed.has(entry.id) ? t("Expand") : t("Collapse")} aria-expanded={!collapsed.has(entry.id)}
                      onClick={() => { const next = new Set(collapsed); if (!next.delete(entry.id)) next.add(entry.id); setCollapsed(next); }}>
                      {collapsed.has(entry.id) ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                    </button>
                  ) : <span className="pd-tree__spacer" />}
                  <a className="pd-tree__title" href={pageUrl(documentRoute(space.slug, entry.path))}>{entry.title}</a>
                  {entry.restricted ? <Lock size={13} className="pd-tree__lock" aria-label={t("Restricted page")} /> : null}
                  <span className="pd-tree__path">{entry.path}</span>
                  <time className="pd-tree__time">{relativeTime(entry.updatedAt)}</time>
                  <Menu.Root>
                    <Menu.Trigger className="pd-icon-button pd-icon-button--small" aria-label={t("Actions for {0}", entry.title)}><MoreHorizontal size={16} aria-hidden="true" /></Menu.Trigger>
                    <Menu.Content align="end" sideOffset={4}>
                      <Menu.LinkItem href={`${pageUrl(documentRoute(space.slug, entry.path))}?mode=edit`}>{t("Edit content")}</Menu.LinkItem>
                      <Menu.Item onClick={() => setDialog({ kind: "new", parent: entry })}>{t("New subpage")}</Menu.Item>
                      <Menu.Item onClick={() => setDialog({ kind: "rename", entry })}>{t("Rename")}</Menu.Item>
                      <Menu.Item onClick={() => setDialog({ kind: "move", entry })}>{t("Move to…")}</Menu.Item>
                      <Menu.Item onClick={() => nudge(entry, -1)}>{t("Move up")}</Menu.Item>
                      <Menu.Item onClick={() => nudge(entry, 1)}>{t("Move down")}</Menu.Item>
                      {atLeast(space.role, "admin") ? <Menu.Item onClick={() => setDialog({ kind: "permission", entry })}>{t("Page permissions")}</Menu.Item> : null}
                      <Menu.Item className="pd-menu__item--danger" onClick={() => void remove(entry)}>{t("Delete")}</Menu.Item>
                    </Menu.Content>
                  </Menu.Root>
                </li>
              );
            })}
          </ul>
        )}
      </LoadedContent>
      {/* A whole new load: the routes the app has were built before this page existed. */}
      {dialog?.kind === "new" ? <NewPageDialog space={space} tree={entries} parent={dialog.parent} onClose={() => setDialog(null)} onCreated={path => location.assign(`${pageUrl(documentRoute(space.slug, path))}?mode=edit`)} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog entry={dialog.entry} onClose={() => setDialog(null)} onDone={finishDialog} /> : null}
      {dialog?.kind === "move" ? <MoveDialog tree={entries} entry={dialog.entry} onClose={() => setDialog(null)} onDone={finishDialog} /> : null}
      {dialog?.kind === "permission" ? <PermissionDialog entry={dialog.entry} onClose={() => setDialog(null)} onChanged={reload} /> : null}
    </>
  );
}
