import * as React from "react";
import { useLocation, useNavigate, usePage } from "@rspress/core/runtime";
import { Link, SidebarList } from "@rspress/core/theme";
import { Button } from "@/components/ui/button";
import { manageableSpaces, manageRoute, spaceManageRoute, spaceViews } from "../data/manage";
import { localePrefix, MANAGE_PREFIX } from "../data/paths";
import { app } from "../data/runtime-data";
import type { Space } from "../types";
import { SearchSelect } from "../ui/form";
import { t } from "../i18n";

const LAST_SPACE = "pandocs-manage-space";

const remembered = () => {
  try {
    return localStorage.getItem(LAST_SPACE);
  } catch {
    return null;
  }
};

const nothingToListenTo = () => () => undefined;

const remember = (slug: string) => {
  try {
    localStorage.setItem(LAST_SPACE, slug);
  } catch {
    // A browser refusing storage only loses which space to open next time.
  }
};

const noop = () => undefined;

/**
 * One space at a time, instead of the same twelve entries for each. On a page with no space of its own, such as
 * notifications, it stays on the last one, so going back is one click.
 */
export default function SpaceNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { page } = usePage();
  const prefix = localePrefix(page.lang, app.bootstrap.site.defaultLang);
  const spaces = manageableSpaces(app.bootstrap);
  const inAddress = new RegExp(`^${prefix}${MANAGE_PREFIX}/spaces/([^/]+)/([^/]+)`, "u").exec(decodeURI(pathname));
  // A server has no idea which one it was, and its first render has to match the browser's.
  const last = React.useSyncExternalStore(nothingToListenTo, remembered, () => null);
  const current =
    spaces.find(space => space.slug === inAddress?.[1]) ?? spaces.find(space => space.slug === last) ?? spaces[0];
  React.useEffect(() => {
    if (current && inAddress) remember(current.slug);
  }, [current, inAddress]);
  if (!current) return null;
  const choose = (slug: string) => {
    const next = spaces.find(space => space.slug === slug) as Space;
    const views = spaceViews(next);
    // The same kind of page in the other space, when this person can see it there.
    const view = views.find(item => item.view === inAddress?.[2]) ?? views[0]!;
    remember(slug);
    navigate(spaceManageRoute(slug, view.view, prefix));
  };
  return (
    <>
      <div className="pd-space-nav rp-not-doc">
        <SearchSelect
          label={t("Space")}
          value={current.slug}
          onChange={choose}
          choices={spaces.map(space => ({ value: space.slug, label: space.name }))}
        >
          <div className="border-t border-border p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start font-normal"
              nativeButton={false}
              render={<Link href={manageRoute("spaces", prefix)} />}
            >
              {t("All spaces")}
            </Button>
          </div>
        </SearchSelect>
      </div>
      <SidebarList
        setSidebarData={noop}
        sidebarData={
          spaceViews(current).map(({ view, title }) => ({
            text: title,
            link: spaceManageRoute(current.slug, view, prefix)
          })) as never
        }
      />
    </>
  );
}
