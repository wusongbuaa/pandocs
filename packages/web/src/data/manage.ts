import { atLeast, type Bootstrap, type Role, type Space } from "../types";
import { MANAGE_PREFIX } from "./paths";
import { t } from "../i18n";

export type SpaceManageView =
  | "pages"
  | "change-sets"
  | "templates"
  | "insights"
  | "git-sync"
  | "webhooks"
  | "members"
  | "trash"
  | "imports"
  | "glossary"
  | "audit"
  | "settings";

export type ManageSpec =
  | {
      readonly view:
        | "inbox"
        | "drafts"
        | "account"
        | "api-reference"
        | "spaces"
        | "site"
        | "site-audit"
        | "site-insights"
        | "site-webhooks"
        | "users"
        | "embed-apps";
      readonly title: string;
    }
  | { readonly view: SpaceManageView; readonly title: string; readonly space: Space };

const allSpaceViews = (): readonly {
  readonly view: SpaceManageView;
  readonly title: string;
  readonly required: Role;
}[] => [
  { view: "pages", title: t("Pages"), required: "editor" },
  { view: "change-sets", title: t("Change sets"), required: "commenter" },
  { view: "templates", title: t("Templates"), required: "editor" },
  { view: "insights", title: t("Insights"), required: "editor" },
  { view: "imports", title: t("Import and export"), required: "editor" },
  { view: "trash", title: t("Trash"), required: "editor" },
  { view: "members", title: t("Members"), required: "admin" },
  { view: "git-sync", title: t("Git sync"), required: "admin" },
  { view: "webhooks", title: t("Webhooks"), required: "admin" },
  { view: "glossary", title: t("Glossary"), required: "admin" },
  { view: "audit", title: t("Audit log"), required: "admin" },
  { view: "settings", title: t("General"), required: "admin" }
];

/** Where Pandocs' own documents go when a site imports them to see what it can do. */
export const SAMPLE_SPACE = "pandocs-docs";

export const manageRoute = (page: string, prefix = "") => `${prefix}${MANAGE_PREFIX}/${page}`;
export const spaceManageRoute = (slug: string, view: SpaceManageView, prefix = "") =>
  manageRoute(`spaces/${slug}/${view}`, prefix);

/** What this person can open in a space, in the order they are listed. */
export const spaceViews = (space: Pick<Space, "role">) =>
  allSpaceViews().filter(item => atLeast(space.role, item.required));

export const manageableSpaces = ({ spaces }: Pick<Bootstrap, "spaces">) =>
  spaces.filter(space => spaceViews(space).length > 0);

/** Whether there is anything to manage, which decides if the account menu leads here. */
export const canManage = ({ me, spaces }: Bootstrap) =>
  me.isAdmin || spaces.some(space => atLeast(space.role, "commenter"));

export function managePages(
  bootstrap: Bootstrap,
  prefix: string
): readonly { readonly path: string; readonly spec: ManageSpec }[] {
  return [
    { path: manageRoute("inbox", prefix), spec: { view: "inbox", title: t("Notifications") } },
    { path: manageRoute("drafts", prefix), spec: { view: "drafts", title: t("My drafts") } },
    { path: manageRoute("account", prefix), spec: { view: "account", title: t("Account and tokens") } },
    { path: manageRoute("api", prefix), spec: { view: "api-reference", title: t("API reference") } },
    { path: manageRoute("spaces", prefix), spec: { view: "spaces", title: t("All spaces") } },
    ...bootstrap.spaces.flatMap(space =>
      spaceViews(space).map(({ view, title }) => ({
        path: spaceManageRoute(space.slug, view, prefix),
        spec: { view, title, space }
      }))
    ),
    ...(bootstrap.me.isAdmin
      ? [
          {
            path: manageRoute("insights", prefix),
            spec: { view: "site-insights" as const, title: t("Site insights") }
          },
          { path: manageRoute("webhooks", prefix), spec: { view: "site-webhooks" as const, title: t("Webhooks") } },
          { path: manageRoute("users", prefix), spec: { view: "users" as const, title: t("Users") } },
          { path: manageRoute("embed-apps", prefix), spec: { view: "embed-apps" as const, title: t("Embed apps") } },
          { path: manageRoute("site", prefix), spec: { view: "site" as const, title: t("Site settings") } },
          { path: manageRoute("audit", prefix), spec: { view: "site-audit" as const, title: t("Site audit log") } }
        ]
      : [])
  ];
}

/** The theme's list for these pages. A space's own pages are above it, in `SpaceNav`, as they depend on the address. */
export function manageSidebar(bootstrap: Bootstrap, prefix: string) {
  return [
    { sectionHeaderText: t("You") },
    { text: t("Notifications"), link: manageRoute("inbox", prefix) },
    { text: t("My drafts"), link: manageRoute("drafts", prefix) },
    { text: t("Account and tokens"), link: manageRoute("account", prefix) },
    { text: t("API reference"), link: manageRoute("api", prefix) },
    { text: t("All spaces"), link: manageRoute("spaces", prefix) },
    ...(bootstrap.me.isAdmin
      ? [
          { sectionHeaderText: t("Site") },
          { text: t("Insights"), link: manageRoute("insights", prefix) },
          { text: t("Webhooks"), link: manageRoute("webhooks", prefix) },
          { text: t("Users"), link: manageRoute("users", prefix) },
          { text: t("Embed apps"), link: manageRoute("embed-apps", prefix) },
          { text: t("Site settings"), link: manageRoute("site", prefix) },
          { text: t("Site audit log"), link: manageRoute("audit", prefix) }
        ]
      : [])
  ];
}
