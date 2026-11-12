import type { AfterSearch } from "@rspress/core/theme";
import { api } from "../api/client";
import { app } from "../data/runtime-data";
import { insideSite } from "../data/site-base";

/** A search runs on every keystroke. What counts is where someone stopped typing. */
const SETTLED_MS = 1500;

let waiting: ReturnType<typeof setTimeout> | undefined;

export const afterSearch: AfterSearch = (query, result) => {
  clearTimeout(waiting);
  const term = query.trim();
  if (!term) return;
  const results = result.reduce((sum, group) => sum + (Array.isArray(group.result) ? group.result.length : 1), 0);
  waiting = setTimeout(() => {
    const space = insideSite(location.pathname).split("/").filter(Boolean).find(segment => app.bootstrap.spaces.some(item => item.slug === segment));
    api.beacon("stats/searches", { term: term.slice(0, 200), results, ...(space ? { space } : {}) });
  }, SETTLED_MS);
};
