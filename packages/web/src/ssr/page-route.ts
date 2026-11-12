import type { Route } from "@rspress/shared";
import { routes } from "../data/runtime-data";

/**
 * The theme copies the list of routes once, while it loads, and remembers which one it found for an address. In a browser
 * the list belongs to one person and stays put. On a server it is different for every page and person, so what the theme
 * copies here is a single route that becomes the page being rendered. This module has to load before the theme.
 */
export const pageRoute = {} as Route;
routes.push(pageRoute);
