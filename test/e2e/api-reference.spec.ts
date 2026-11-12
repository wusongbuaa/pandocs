import { expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, PEOPLE, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "apis";
const SPEC = `openapi: 3.1.0
info: { title: Parcel service, version: "2.0" }
paths:
  /parcels:
    get:
      summary: List the parcels
      tags: [Parcels]
      responses: { "200": { description: Every parcel } }
    post:
      summary: Send a parcel
      tags: [Parcels]
      responses: { "201": { description: On its way } }
`;

pandocsDescribe("API references", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  const outside: string[] = [];

  /** Whatever it offers, it should not be talking to anyone but this site. */
  const watched = (page: Page) => {
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.origin !== app.origin && url.protocol.startsWith("http")) outside.push(request.url());
    });
    return page;
  };

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "接口", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
  }, 120_000);

  afterAll(async () => {
    expect(outside).toEqual([]);
    expect(app.cspReports).toEqual([]);
    await app?.close();
  });

  it("gives a page that is only a reference the whole width, with its own navigation", async () => {
    const src = await app.upload("editor", SPACE, "parcels.yaml", Buffer.from(SPEC));
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "Parcel API", slug: "parcels", markdown: `::openapi{src="${src}"}\n` });
    const page = watched(await app.open("reader", `/${SPACE}/parcels`));
    const reference = page.locator(".pd-api-reference");
    await browserExpect(reference.getByText("Send a parcel").first()).toBeVisible({ timeout: 30_000 });
    await browserExpect(reference.getByText("List the parcels").first()).toBeVisible();
    await browserExpect(page.locator(".rp-doc-layout__sidebar")).toHaveCount(0);
    await browserExpect(page.locator(".rp-doc-layout__outline")).toHaveCount(0);
    const { width, x } = (await reference.boundingBox())!;
    expect(width).toBeGreaterThan(1000);
    await browserExpect(reference.getByRole("button", { name: /Test Request/u })).toHaveCount(0);
    // Its panel lines up with the page's title, and its list stays in view as the page goes down.
    expect(Math.round(x)).toBe(Math.round(await page.locator("h1.rp-toc-include").evaluate(title => title.getBoundingClientRect().left)));
    await page.evaluate(() => window.scrollBy(0, 600));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    const listTop = await reference.evaluate(element => {
      const list = [...element.querySelectorAll("*")].find(item => getComputedStyle(item).position === "sticky" && item.getBoundingClientRect().height > 200);
      return list?.getBoundingClientRect().top ?? Number.NaN;
    });
    expect(listTop).toBeGreaterThanOrEqual(56);
    expect(listTop).toBeLessThan(120);
    // Someone who can label the page has a row of labels above the panel, and the panel keeps its distance from it.
    const asEditor = watched(await app.open("editor", `/${SPACE}/parcels`));
    await browserExpect(asEditor.locator(".pd-api-reference").getByText("Send a parcel").first()).toBeVisible({ timeout: 30_000 });
    const gap = await asEditor.evaluate(() => document.querySelector(".pd-api-reference")!.getBoundingClientRect().top - document.querySelector(".pd-labels")!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(16);
  }, 90_000);

  it("keeps to the width of the text when it is one part of a page", async () => {
    const src = await app.upload("editor", SPACE, "parcels.yaml", Buffer.from(SPEC));
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "With words", slug: "words", markdown: `Before the reference.\n\n::openapi{src="${src}"}\n\nAfter the reference.\n` });
    const page = watched(await app.open("reader", `/${SPACE}/words`));
    const reference = page.locator(".pd-api-reference");
    await browserExpect(reference.getByText("Send a parcel").first()).toBeVisible({ timeout: 30_000 });
    await browserExpect(page.getByText("After the reference")).toBeVisible();
    await browserExpect(page.locator(".rp-doc-layout__sidebar")).toBeVisible();
    expect((await reference.boundingBox())!.width).toBeLessThan(800);
  }, 90_000);

  it("offers the document itself to whoever reads a page without running it", async () => {
    const page = await app.open("reader", `/${SPACE}/parcels`);
    await browserExpect(page.locator(".pd-api-reference").getByText("Send a parcel").first()).toBeVisible({ timeout: 30_000 });
    const served = await page.request.get(`${app.origin}/${SPACE}/parcels`, { headers: { accept: "text/html" } });
    expect(await served.text()).toContain("OpenAPI");
  }, 60_000);

  it("leaves the rest of the site looking as it did, after moving on from one", async () => {
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "Plain page", slug: "plain", markdown: "## A heading\n\nSome words with a [link](https://example.com).\n" });
    const measure = async (target: Page) => {
      await browserExpect(target.getByRole("heading", { name: "A heading" })).toBeVisible({ timeout: 15_000 });
      return target.evaluate(() => {
        const look = (selector: string, ...names: string[]) => {
          const style = getComputedStyle(document.querySelector(selector)!);
          return names.map(name => style.getPropertyValue(name)).join(" ");
        };
        return [look("body", "font-family", "font-size", "line-height", "color", "background-color"), look("main .rp-doc h2", "font-size", "font-weight", "margin-top"), look("main .rp-doc a", "color"), look("main .rp-doc p", "font-size", "line-height", "margin-bottom")];
      });
    };
    const fresh = await app.open("reader", `/${SPACE}/plain`);
    const before = await measure(fresh);
    const page = await app.open("reader", `/${SPACE}/parcels`);
    await browserExpect(page.locator(".pd-api-reference").getByText("Send a parcel").first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(path => {
      history.pushState(null, "", path);
      dispatchEvent(new PopStateEvent("popstate"));
    }, `/${SPACE}/plain`);
    expect(await measure(page)).toEqual(before);
  }, 90_000);

  it("shows this site's own API on a page of its own, where requests can be tried", async () => {
    const page = watched(await app.open("reader", "/_/api"));
    const reference = page.locator(".pd-api-reference");
    await browserExpect(reference.getByText("Pandocs API").first()).toBeVisible({ timeout: 30_000 });
    await browserExpect(reference.getByRole("button", { name: /Test Request/u }).first()).toBeVisible();
  }, 90_000);

  it("offers to add one in the editor, by uploading the document", async () => {
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title: "Being edited", slug: "edited", markdown: "Words.\n" });
    const page = await app.open("editor", `/${SPACE}/edited?mode=edit`);
    const editor = page.locator(".ProseMirror");
    await browserExpect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    // Asking for the file chooser reaches a busy page by another way than the keys do, so it comes well before them.
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.type("/openapi");
    // The menu follows the typing a moment later, and Enter before that only starts a new line.
    await browserExpect(page.locator(".pd-slash__item")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await (await chooser).setFiles({ name: "parcels.yaml", mimeType: "application/yaml", buffer: Buffer.from(SPEC) });
    await browserExpect(editor.locator('[data-pandocs-block="openapi"]')).toBeVisible();
    await browserExpect(editor.locator('[data-pandocs-block="openapi"]').getByText(/assets\//u)).toBeVisible();
  }, 60_000);
});
