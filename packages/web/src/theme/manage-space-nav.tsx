import * as React from "react";
import { useLocation, usePage } from "@rspress/core/runtime";
import { localePrefix, MANAGE_PREFIX } from "../data/paths";
import { app } from "../data/runtime-data";

const SpaceNav = React.lazy(() => import("../manage/space-nav"));

/** The management pages share the theme's sidebar with what readers see, and only they need this. */
export function ManageSpaceNav() {
  const { pathname } = useLocation();
  const { page } = usePage();
  if (!pathname.startsWith(`${localePrefix(page.lang, app.bootstrap.site.defaultLang)}${MANAGE_PREFIX}/`)) return null;
  return (
    <React.Suspense fallback={null}>
      <SpaceNav />
    </React.Suspense>
  );
}
