import type { Route } from "@rspress/shared";
import { describe, expect, it } from "vitest";
import { notFoundPage } from "../src/data/pages";
import { routes } from "../src/data/runtime-data";

describe("a page that went after its address was found", () => {
  it("is shown as the theme's page for nothing there, not a page that fails", async () => {
    // The theme copies the routes when it loads and remembers what it found for an address, so the route stays found.
    routes.push({
      path: "/guide/gone",
      filePath: "guide/gone.doc",
      element: null,
      lang: "",
      version: "",
      preload: async () => notFoundPage()
    } as unknown as Route);
    const { initPageData } = await import("../vendor/rspress/runtime/initPageData");
    await expect(initPageData("/guide/gone")).resolves.toMatchObject({ pageType: "404", title: "404" });
  });
});
