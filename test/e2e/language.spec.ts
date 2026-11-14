import { expect as browserExpect, type Page } from "@playwright/test";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { pandocsDescribe, PEOPLE, selectWords, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "guide";
const ENGLISH = "en-US";
const CHINESE = "zh-CN";

pandocsDescribe("the language of the interface", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  let pageId = "";

  /**
   * Everything a person can read on the page, or hear from a screen reader. The people in these tests have Chinese names,
   * and an avatar is their first letter. Languages are listed by their own names, and whether a browser counts the options
   * of a closed menu as text depends on the system.
   */
  const chineseOn = (page: Page) =>
    page.evaluate(
      names => {
        const attributes = [...document.querySelectorAll("[aria-label],[title],[placeholder],[alt]")].flatMap(element =>
          ["aria-label", "title", "placeholder", "alt"].map(name => element.getAttribute(name) ?? "")
        );
        const text = [document.body.innerText, document.title, ...attributes].join("\n");
        return (
          [...names.flatMap(name => [name, name[0]!]), "简体中文", "日本語"]
            .reduce((all, name) => all.replaceAll(name, ""), text)
            .match(/[\u3400-\u9fff]+/gu) ?? []
        );
      },
      Object.values(PEOPLE).map(person => person.displayName)
    );

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString());
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "Guide", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, {
      subject: `user:${PEOPLE.commenter.id}`,
      role: "commenter"
    });
    const { data } = await app.api("admin", "POST", `spaces/${SPACE}/documents`, {
      title: "Returns",
      slug: "returns",
      markdown:
        "# Returns\n\nWithin seven days.\n\n:::tip\n\nKeep the receipt.\n\n:::\n\nA note[^1] here.\n\n[^1]: The note.\n\n## Refunds\n\nOn the original card.\n"
    });
    pageId = data.document.id as string;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ["a space's front page", `/${SPACE}/`, "Start reading"],
    ["a document", `/${SPACE}/returns`, "Comments"],
    ["version history", `/${SPACE}/returns?view=history`, "Version history"],
    ["the source", `/${SPACE}/returns?view=source`, "Markdown source, version 1"],
    ["the editor", `/${SPACE}/returns?mode=edit`, "Stop editing"],
    ["notifications", "/_/inbox", "Notifications"],
    ["drafts", "/_/drafts", "My drafts"],
    ["the account", "/_/account", "Account and tokens"],
    ["the API reference", "/_/api", "Pandocs API"],
    ["all spaces", "/_/spaces", "All spaces"],
    ["the page tree", `/_/spaces/${SPACE}/pages`, "Guide: pages"],
    ["a space's templates", `/_/spaces/${SPACE}/templates`, "Built in"],
    ["a space's insights", `/_/spaces/${SPACE}/insights`, "Guide: insights"],
    ["a space's webhooks", `/_/spaces/${SPACE}/webhooks`, "No webhooks yet"],
    ["a space's Git sync", `/_/spaces/${SPACE}/git-sync`, "This server cannot run Git"],
    ["the site's insights", "/_/insights", "Site insights"],
    ["imports", `/_/spaces/${SPACE}/imports`, "Guide: import and export"],
    ["the trash", `/_/spaces/${SPACE}/trash`, "Guide: trash"],
    ["members", `/_/spaces/${SPACE}/members`, "Guide: members"],
    ["the glossary", `/_/spaces/${SPACE}/glossary`, "Guide: glossary"],
    ["a space's log", `/_/spaces/${SPACE}/audit`, "Guide: audit log"],
    ["a space's settings", `/_/spaces/${SPACE}/settings`, "Guide: general"],
    ["users", "/_/users", "Users"],
    ["embed apps", "/_/embed-apps", "Embed apps"],
    ["site settings", "/_/site", "Site settings"],
    ["the site's log", "/_/audit", "Site audit log"]
  ])(
    "is English on %s in an English browser",
    async (_what, path, heading) => {
      const page = await app.open("admin", path, ENGLISH);
      await browserExpect(page.getByText(heading, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
      expect(await chineseOn(page)).toEqual([]);
      await page.context().close();
    },
    60_000
  );

  it("stays English through the things that only appear once you use them", async () => {
    const page = await app.open("commenter", `/${SPACE}/returns`, ENGLISH);
    await browserExpect(page.getByText("Within seven days")).toBeVisible({ timeout: 15_000 });
    await selectWords(page, "seven days");
    const toolbar = page.getByRole("toolbar", { name: "Actions on the selected text" });
    await browserExpect(toolbar).toBeVisible();
    expect(await chineseOn(page)).toEqual([]);
    await toolbar.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByPlaceholder("Write a comment, @ to mention someone").fill("Is this calendar days?");
    expect(await chineseOn(page)).toEqual([]);
    await page.locator(".pd-panel").getByRole("button", { name: "Send", exact: true }).click();
    await browserExpect(page.locator(".pd-card").getByText("Is this calendar days?")).toBeVisible();
    expect(await chineseOn(page)).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("is Chinese in a Chinese browser, on a site whose content is English, down to the theme's own text", async () => {
    const page = await app.open("reader", `/${SPACE}/returns`, CHINESE);
    await browserExpect(page.getByText("Within seven days")).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.locator(".rp-outline").getByText("目录", { exact: true })).toBeVisible();
    await browserExpect(page.getByRole("link", { name: "历史" })).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("can be picked on the account page, stays picked, and can go back to following the browser", async () => {
    const page = await app.open("reader", "/_/account", ENGLISH);
    const language = page.getByRole("combobox", { name: /language on this computer/u });
    await browserExpect(language).toBeVisible({ timeout: 15_000 });
    await language.click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("option", { name: "简体中文" }).click()]);
    await browserExpect(page.getByRole("heading", { name: "账号与令牌" })).toBeVisible({ timeout: 15_000 });
    await page.goto(`${app.origin}/${SPACE}/returns`);
    await browserExpect(page.getByRole("link", { name: "历史" })).toBeVisible({ timeout: 15_000 });
    await page.goto(`${app.origin}/_/account`);
    const chosen = page.getByRole("combobox", { name: /界面语言/u });
    await browserExpect(chosen).toContainText("简体中文", { timeout: 15_000 });
    await chosen.click();
    await Promise.all([page.waitForEvent("load"), page.getByRole("option", { name: "跟随浏览器" }).click()]);
    await browserExpect(page.getByRole("heading", { name: "Account and tokens" })).toBeVisible({ timeout: 15_000 });
    await page.context().close();
  }, 60_000);

  it("follows the pages' language on a site with several, moving between them included", async () => {
    await app.api("admin", "PATCH", "site", {
      defaultLang: "en",
      locales: [
        { lang: "en", label: "English" },
        { lang: "zh", label: "简体中文" }
      ]
    });
    await app.api("admin", "PUT", `documents/${pageId}/translations/zh`, {
      title: "退货",
      markdown: "七天之内。\n",
      sourceRevision: 1,
      machine: false
    });
    const page = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    await browserExpect(page.getByRole("link", { name: "History" })).toBeVisible({ timeout: 15_000 });
    // The way the theme's language menu goes there: no new page load of its own.
    await Promise.all([
      page.waitForEvent("load"),
      page.evaluate(path => {
        history.pushState(null, "", path);
        dispatchEvent(new PopStateEvent("popstate"));
      }, `/zh/${SPACE}/returns`)
    ]);
    await browserExpect(page.getByText("七天之内")).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("button", { name: "复制 Markdown" })).toBeVisible();
    await page.goto(`${app.origin}/${SPACE}/returns`);
    await browserExpect(page.getByRole("link", { name: "History" })).toBeVisible({ timeout: 15_000 });
    await page.context().close();
    await app.api("admin", "PATCH", "site", { defaultLang: "en", locales: [{ lang: "en", label: "English" }] });
  }, 60_000);
});
