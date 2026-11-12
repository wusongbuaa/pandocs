import * as React from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal, Plus } from "lucide-react";
import { Menu } from "../ui/menu";
import { usePage } from "@rspress/core/runtime";
import { api, failureMessage } from "../api/client";
import { spaceManageRoute } from "../data/manage";
import { documentRoute, HOME_DOCUMENT_PATH, localePrefix, pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast, type SpaceWithTree, type TreeEntry } from "../types";
import { confirm } from "../ui/confirm";
import { toast } from "../ui/toast";
import { t } from "../i18n";

// Reading a page should not load what it takes to rearrange them.
const NewPageDialog = React.lazy(() => import("../manage/tree-dialogs").then(module => ({ default: module.NewPageDialog })));
const RenameDialog = React.lazy(() => import("../manage/tree-dialogs").then(module => ({ default: module.RenameDialog })));
const MoveDialog = React.lazy(() => import("../manage/tree-dialogs").then(module => ({ default: module.MoveDialog })));

const SIDEBAR = ".rp-doc-layout__sidebar";
const ITEM = ".rp-sidebar-item, .rp-sidebar-section-header";

interface Hovered {
  readonly entry: TreeEntry;
  readonly top: number;
  readonly left: number;
}

/** The theme's sidebar items know nothing about pages, so a page is found through the item's link or, without one, its text. */
export function entryOfItem(item: Element, space: SpaceWithTree, prefix: string): TreeEntry | undefined {
  const href = (item.closest("a[href]") ?? item.querySelector("a[href]"))?.getAttribute("href");
  if (href) {
    const base = pageUrl(`${prefix}/${space.slug}/`);
    const pathname = decodeURIComponent(new URL(href, location.href).pathname);
    if (!pathname.startsWith(base)) return undefined;
    const path = pathname.slice(base.length).replace(/\/$/u, "") || HOME_DOCUMENT_PATH;
    return space.tree.find(entry => entry.path === path);
  }
  const text = item.textContent?.trim();
  return space.tree.find(entry => !entry.hasContent && (entry.title === text || Object.values(entry.titles ?? {}).includes(text ?? "")));
}

type Dialogs = { readonly kind: "new"; readonly parent: TreeEntry | null } | { readonly kind: "rename" | "move"; readonly entry: TreeEntry } | null;

/**
 * Sits over the theme's sidebar without changing it: hovering a page offers the same operations as the document
 * tree page. The routes are built when the app loads, so every change ends in a full page load.
 */
export function SidebarActions() {
  const page = useAppPage();
  const { page: themePage } = usePage();
  const [hovered, setHovered] = React.useState<Hovered | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [dialog, setDialog] = React.useState<Dialogs>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const space = page?.kind === "document" ? app.bootstrap.spaces.find(item => item.slug === page.space.slug) : undefined;
  const prefix = localePrefix(themePage.lang, app.bootstrap.site.defaultLang);
  const editable = Boolean(space && atLeast(space.role, "editor"));

  React.useEffect(() => {
    const sidebar = document.querySelector(SIDEBAR);
    if (!sidebar || !space || !editable) return undefined;
    const onOver = (event: Event) => {
      const item = (event.target as Element).closest(ITEM);
      const entry = item && entryOfItem(item, space, prefix);
      if (!item || !entry) {
        if (!menuOpen) setHovered(null);
        return;
      }
      const box = item.getBoundingClientRect();
      // A collapsible group keeps its arrow at the far right, so the button stops short of it.
      const hasArrow = Boolean(item.querySelector(".rp-sidebar-item__right svg, .rp-sidebar-section-header__right svg"));
      setHovered({ entry, top: box.top + box.height / 2 - 12, left: box.right - (hasArrow ? 56 : 28) });
    };
    const onLeave = (event: Event) => {
      if (!menuOpen && (event as MouseEvent).relatedTarget !== button.current && !button.current?.contains((event as MouseEvent).relatedTarget as Node | null)) setHovered(null);
    };
    const onScroll = () => { if (!menuOpen) setHovered(null); };
    sidebar.addEventListener("mouseover", onOver);
    sidebar.addEventListener("mouseleave", onLeave);
    sidebar.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      sidebar.removeEventListener("mouseover", onOver);
      sidebar.removeEventListener("mouseleave", onLeave);
      sidebar.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [editable, menuOpen, prefix, space]);

  if (!space || !editable) return null;
  const goTo = (path: string, query = "") => location.assign(`${pageUrl(documentRoute(space.slug, path, prefix))}${query}`);
  const remove = async (entry: TreeEntry) => {
    const below = space.tree.filter(item => item.path.startsWith(`${entry.path}/`)).length;
    const ok = await confirm({
      title: t("Delete \"{0}\"?", entry.title),
      description: below > 0 ? t("The {0} {0|subpage|subpages} below go to the trash with it. You can restore them from there.", below) : t("The page goes to the trash, and can be restored."),
      action: t("Move to trash"),
      danger: true
    });
    if (!ok) return;
    try {
      await api.send("DELETE", `documents/${entry.id}?recursive=true`);
      const current = page?.kind === "document" ? page.entry : null;
      if (current && (current.id === entry.id || current.path.startsWith(`${entry.path}/`))) location.assign(pageUrl(`${prefix}/${space.slug}/`));
      else location.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <div className="pd-sidebar-foot">
        <button type="button" className="pd-sidebar-foot__item" onClick={() => setDialog({ kind: "new", parent: null })}><Plus size={14} aria-hidden="true" />{t("New page")}</button>
        <a className="pd-sidebar-foot__item" href={pageUrl(spaceManageRoute(space.slug, "pages", prefix))}>{t("Manage pages")}</a>
      </div>
      {hovered ? createPortal(
        <div className="pd-sidebar-more" style={{ top: hovered.top, left: hovered.left }} onMouseLeave={() => { if (!menuOpen) setHovered(null); }}>
          <Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
            <Menu.Trigger ref={button} className="pd-icon-button pd-icon-button--small" aria-label={t("Actions for {0}", hovered.entry.title)}><MoreHorizontal size={15} aria-hidden="true" /></Menu.Trigger>
            <Menu.Content align="start" sideOffset={4}>
              <Menu.Item onClick={() => setDialog({ kind: "new", parent: hovered.entry })}>{t("New subpage")}</Menu.Item>
              <Menu.Item onClick={() => setDialog({ kind: "rename", entry: hovered.entry })}>{t("Rename")}</Menu.Item>
              <Menu.Item onClick={() => setDialog({ kind: "move", entry: hovered.entry })}>{t("Move to…")}</Menu.Item>
              <Menu.Item className="pd-menu__item--danger" onClick={() => void remove(hovered.entry)}>{t("Delete")}</Menu.Item>
            </Menu.Content>
          </Menu.Root>
        </div>,
        document.body
      ) : null}
      {dialog ? <React.Suspense fallback={null}>{dialog.kind === "new" ? <NewPageDialog space={space} tree={space.tree} parent={dialog.parent} onClose={() => setDialog(null)} onCreated={path => goTo(path, "?mode=edit")} /> : null}
      {dialog.kind === "rename" ? <RenameDialog entry={dialog.entry} onClose={() => setDialog(null)} onDone={() => location.reload()} /> : null}
      {dialog.kind === "move" ? <MoveDialog tree={space.tree} entry={dialog.entry} onClose={() => setDialog(null)} onDone={() => location.reload()} /> : null}</React.Suspense> : null}
    </>
  );
}
