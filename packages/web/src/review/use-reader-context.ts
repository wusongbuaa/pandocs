import * as React from "react";
import { usePage } from "@rspress/core/runtime";
import type { PandocsPage } from "../data/pages";
import { localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import type { ReaderContextValue } from "../markdown/reader-context";

/** What blocks need to render outside the normal reading view: links and images resolve the same way. */
export function useReaderContextValue(page: PandocsPage): ReaderContextValue {
  const { page: themePage } = usePage();
  return React.useMemo(() => ({
    space: page.space,
    currentPath: page.entry.path,
    routePrefix: localePrefix(themePage.lang, app.bootstrap.site.defaultLang),
    children: app.bootstrap.spaces.find(space => space.slug === page.space.slug)?.tree.filter(entry => entry.parentId === page.entry.id) ?? []
  }), [page, themePage.lang]);
}
