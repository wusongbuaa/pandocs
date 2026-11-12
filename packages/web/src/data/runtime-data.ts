import type { PageData, Route, SiteData } from "@rspress/shared";
import type { Bootstrap } from "../types";

/**
 * What Rspress's build would generate, filled in from the API before the theme's modules load. The theme
 * captures these objects when it is evaluated, so they are filled in place and never replaced.
 */
export const siteData = {} as SiteData;
export const pageData = { pages: [] } as unknown as PageData;
export const searchIndexHash: Record<string, string> = {};
export const routes: Route[] = [];
export const socialIcons: Record<string, string> = {};

/** The data the app itself reads; the theme only sees the objects above. */
export const app: {
  bootstrap: Bootstrap;
  /** Where the site is, which on a page from the server is what the server calls it. */
  origin: string;
  /** The address the server rendered this page for: what it found out there need not be asked again. */
  renderedPath: string | null;
} = { bootstrap: undefined as unknown as Bootstrap, origin: "", renderedPath: null };
