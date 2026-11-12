import { expect as browserExpect, type Page } from "@playwright/test";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { docx } from "../../packages/server/test/office-files.js";
import { extractToMarkdown } from "../../packages/server/src/extract/convert.js";
import { createExtractProcessor } from "../../packages/server/src/extract/processor.js";
import {
  canReadClipboard,
  choose,
  engineName,
  enterForWord,
  pandocsDescribe,
  PEOPLE,
  selectWords,
  startPandocs,
  testPicture
} from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "e2e";

/** What the browser can only do itself: real mouse and keyboard, the built app, the page's real CSP. */
pandocsDescribe("Pandocs in a browser", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;

  const createPage = async (title: string, slug: string, markdown: string) =>
    (await app.api("editor", "POST", `spaces/${SPACE}/documents`, { title, slug, markdown })).data.document
      .id as string;
  const readPage = async (id: string) => (await app.api("reader", "GET", `documents/${id}`)).data;
  const clickButton = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).click();
  const editorReady = async (page: Page) =>
    browserExpect(page.locator(".ProseMirror")).toBeVisible({ timeout: 15_000 });
  /** The editor sits in the same place as the page, so its text proves nothing until it has gone. */
  const backToReading = async (page: Page) =>
    browserExpect(page.locator(".ProseMirror")).toHaveCount(0, { timeout: 15_000 });

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString(), {
      processors: [createExtractProcessor(extractToMarkdown)],
      llm: {
        complete: async () => "总结",
        assist: async ({ action, content }) =>
          action === "apply_discussion" ? content.replace("旧说法", "新说法") : "AI 的结果"
      }
    });
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "端到端", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, {
      subject: `user:${PEOPLE.commenter.id}`,
      role: "commenter"
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("comments on selected words, also on a page that writes its own title, and finds them again after a reload", async () => {
    await createPage("划词页", "select", "# 划词页\n\n第一段**重要**说明。\n\n第二段普通说明。\n");
    const page = await app.open("commenter", `/${SPACE}/select`);
    await browserExpect(page.getByText("第二段普通说明")).toBeVisible({ timeout: 15_000 });
    await selectWords(page, "第二段普通");
    await page
      .getByRole("toolbar", { name: "选中文字的操作" })
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await page.getByPlaceholder("写下评论，@ 提及同事").fill("这里要确认");
    await page.locator(".pd-panel").getByRole("button", { name: "发送", exact: true }).click();
    await browserExpect(page.locator(".pd-card").getByText("这里要确认")).toBeVisible();
    const highlighted = () =>
      page.evaluate(() =>
        ["pd-comment", "pd-comment-active"]
          .flatMap(name => [...((CSS as any).highlights.get(name) ?? [])])
          .map((range: Range) => range.toString())
          .join("|")
      );
    await expect.poll(highlighted).toBe("第二段普通");
    await page.reload();
    await expect.poll(highlighted, { timeout: 15_000 }).toBe("第二段普通");
  });

  it("hears about new versions and comments as they happen, without leaving the page", async () => {
    const id = await createPage("实时页", "live", "# 实时页\n\n第一段说明。\n");
    const page = await app.open("reader", `/${SPACE}/live`);
    await browserExpect(page.getByText("第一段说明")).toBeVisible({ timeout: 15_000 });
    const highlighted = () =>
      page.evaluate(() =>
        [...((CSS as any).highlights.get("pd-comment") ?? [])].map((range: Range) => range.toString()).join("|")
      );
    await expect.poll(highlighted).toBe("");

    // Nothing here moves focus or reloads, so these can only have come over the live connection.
    await app.api("commenter", "POST", `documents/${id}/threads`, {
      anchor: { kind: "quote", quote: "第一段" },
      body: "这里要确认"
    });
    await expect.poll(highlighted, { timeout: 5000 }).toBe("第一段");

    await app.api(
      "editor",
      "PUT",
      `documents/${id}/content`,
      { markdown: "# 实时页\n\n第一段说明。\n\n第二段。\n", expectedRevision: 1 },
      { "idempotency-key": "live-page-save" }
    );
    await browserExpect(page.getByText("文档已更新")).toBeVisible({ timeout: 5000 });
    await clickButton(page, "刷新");
    await browserExpect(page.getByText("第二段。")).toBeVisible();
    await browserExpect(page.getByText("文档已更新")).toHaveCount(0);

    // And it still listens after that reload, for the next one.
    await app.api(
      "editor",
      "PUT",
      `documents/${id}/content`,
      { markdown: "# 实时页\n\n第一段说明。\n\n第二段。\n\n第三段。\n", expectedRevision: 2 },
      { "idempotency-key": "live-page-save-2" }
    );
    await browserExpect(page.getByText("文档已更新")).toBeVisible({ timeout: 5000 });
    await page.close();
  });

  it("makes a page from a Word file, and keeps the file on it", async () => {
    const page = await app.open("editor", `/_/spaces/${SPACE}/imports`);
    await browserExpect(page.getByRole("heading", { name: /导入导出/u })).toBeVisible({ timeout: 15_000 });
    await page
      .getByLabel("上传要导入的文件")
      .setInputFiles({ name: "退货流程.docx", mimeType: "application/octet-stream", buffer: Buffer.from(docx()) });
    await app.settleImports();
    await page.reload();
    await browserExpect(page.getByText("退货流程.docx").first()).toBeVisible({ timeout: 15_000 });
    const { data: jobs } = await app.api("editor", "GET", `spaces/${SPACE}/imports`);
    const job = jobs.find((item: { filename: string }) => item.filename === "退货流程.docx");
    expect(job.status).toBe("succeeded");
    const published = await app.api("editor", "POST", `imports/${job.id}/publish`, { slug: "returns" });
    expect(published.status).toBe(200);

    const reader = await app.open("reader", `/${SPACE}/returns`);
    await browserExpect(reader.getByText("七天内可以")).toBeVisible({ timeout: 15_000 });
    await browserExpect(reader.locator("table")).toContainText("图书");
    const original = reader.locator(".pd-file");
    await browserExpect(original).toContainText("退货流程.docx");
    const download = reader.waitForEvent("download");
    await original.click();
    expect((await download).suggestedFilename()).toBe("退货流程.docx");
    await reader.close();
    await page.close();
  });

  it("types and saves with a real keyboard, and the version and page follow", async () => {
    const id = await createPage("编辑页", "edit", "原来的内容\n");
    const page = await app.open("editor", `/${SPACE}/edit?mode=edit`);
    await editorReady(page);
    await page.locator(".ProseMirror").click();
    await page.keyboard.press("End");
    await page.keyboard.type("和新打的字");
    await clickButton(page, "保存");
    await backToReading(page);
    await browserExpect(page.locator("main .rp-doc").getByText("原来的内容和新打的字")).toBeVisible();
    expect(await readPage(id)).toMatchObject({ revision: { no: 2 }, markdown: "原来的内容和新打的字\n" });
  });

  // A shared draft stays in any case, which live.spec.ts is about.
  it.skipIf(process.env.PANDOCS_E2E_LIVE === "1")(
    "keeps what was just typed when someone clicks away, and offers it back",
    async () => {
      await createPage("另一页", "other", "另一页内容\n");
      const id = await createPage("草稿页", "draft", "草稿页内容\n");
      const page = await app.open("editor", `/${SPACE}/draft?mode=edit`);
      await editorReady(page);
      await page.locator(".ProseMirror").click();
      await page.keyboard.press("End");
      await page.keyboard.type("刚打的字");
      await page.locator(".rp-sidebar-item", { hasText: "另一页" }).click();
      await browserExpect(page.getByText("另一页内容")).toBeVisible({ timeout: 15_000 });
      await page.goto(`${app.origin}/${SPACE}/draft?mode=edit`);
      await clickButton(page, "继续编辑草稿");
      await editorReady(page);
      await browserExpect(page.locator(".ProseMirror")).toContainText("刚打的字");
      expect((await readPage(id)).revision.no).toBe(1);
    }
  );

  it("moves a block by dragging its handle", async () => {
    const id = await createPage("拖动页", "drag", "第一块\n\n第二块\n\n第三块\n");
    const page = await app.open("editor", `/${SPACE}/drag?mode=edit`);
    await editorReady(page);
    const blocks = page.locator(".ProseMirror > p");
    const first = await blocks.nth(0).boundingBox();
    const third = await blocks.nth(2).boundingBox();
    await page.mouse.move(first!.x + 20, first!.y + first!.height / 2);
    const grip = page.getByRole("button", { name: "拖动这个块" });
    await browserExpect(grip).toBeVisible();
    const handle = await grip.boundingBox();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + 30, handle!.y + 20, { steps: 4 });
    await page.mouse.move(third!.x + 40, third!.y + third!.height + 2, { steps: 12 });
    await page.mouse.up();
    await browserExpect(blocks.nth(2)).toHaveText("第一块");
    await clickButton(page, "保存");
    await backToReading(page);
    expect((await readPage(id)).markdown).toBe("第二块\n\n第三块\n\n第一块\n");
  });

  it("offers each role what it may do, and a suggestion goes through someone with edit rights", async () => {
    const id = await createPage("权限页", "roles", "权限页内容\n");
    const asReader = await app.open("reader", `/${SPACE}/roles`);
    await browserExpect(asReader.getByText("权限页内容")).toBeVisible({ timeout: 15_000 });
    await browserExpect(asReader.getByRole("link", { name: "编辑", exact: true })).toHaveCount(0);
    await browserExpect(asReader.getByRole("link", { name: "建议修改" })).toHaveCount(0);
    await selectWords(asReader, "权限页");
    const toolbar = asReader.getByRole("toolbar", { name: "选中文字的操作" });
    await browserExpect(toolbar).toBeVisible();
    await browserExpect(toolbar.getByRole("button", { name: "评论", exact: true })).toHaveCount(0);

    const asCommenter = await app.open("commenter", `/${SPACE}/roles`);
    // Every way into the editor says what it is for them.
    await browserExpect(asCommenter.getByRole("link", { name: "建议修改" }).first()).toBeVisible({ timeout: 15_000 });
    await browserExpect(asCommenter.getByRole("link", { name: "编辑此页面" })).toHaveCount(0);
    await asCommenter.getByRole("link", { name: "建议修改" }).first().click();
    await editorReady(asCommenter);
    await browserExpect(asCommenter.getByLabel("标题")).toHaveCount(0);
    await asCommenter.locator(".ProseMirror").click();
    await asCommenter.keyboard.press("End");
    await asCommenter.keyboard.type("和建议");
    await clickButton(asCommenter, "提交建议");
    await asCommenter.getByLabel("修改说明（可选）").fill("补一句");
    await clickButton(asCommenter, "提交");
    await backToReading(asCommenter);
    expect((await readPage(id)).revision.no).toBe(1);

    const asEditor = await app.open("editor", `/${SPACE}/roles`);
    await asEditor.getByRole("button", { name: /评论/u }).first().click();
    await asEditor.getByRole("tab", { name: /修改建议/u }).click();
    await asEditor.locator(".pd-proposal-card").click();
    await clickButton(asEditor, "接受");
    await browserExpect(asEditor.locator("main .rp-doc").getByText("权限页内容和建议")).toBeVisible({
      timeout: 15_000
    });
    expect((await readPage(id)).revision.no).toBe(2);
  });

  it("turns a discussion into a suggestion, and accepting it resolves the discussion", async () => {
    const id = await createPage("讨论页", "discuss", "这里是旧说法。\n\n另一段不动。\n");
    const thread = (
      await app.api("commenter", "POST", `documents/${id}/threads`, {
        anchor: { kind: "quote", quote: "旧说法" },
        body: "应该改成新说法"
      })
    ).data.id as string;
    const page = await app.open("editor", `/${SPACE}/discuss?thread=${thread}`);
    await clickButton(page, "根据讨论生成修改建议");
    await browserExpect(page.getByRole("dialog").getByRole("textbox", { name: "改成" })).toHaveValue("这里是新说法。", {
      timeout: 15_000
    });
    await browserExpect(page.getByRole("dialog").locator(".pd-diff__row--added")).toContainText("这里是新说法。");
    await clickButton(page, "提交建议");
    await page.locator(".pd-proposal-card").click();
    await clickButton(page, "接受");
    await browserExpect(page.locator("main .rp-doc").getByText("这里是新说法。")).toBeVisible({ timeout: 15_000 });
    expect((await app.api("reader", "GET", `threads/${thread}`)).data.status).toBe("resolved");
    expect((await readPage(id)).markdown).toBe("这里是新说法。\n\n另一段不动。\n");
  });

  it("shows diagrams while editing, and edits the Markdown directly", async () => {
    const markdown = "开头\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n*   写法特别的列表\n\n结尾\n";
    const id = await createPage("源码页", "source", markdown);
    const page = await app.open("editor", `/${SPACE}/source?mode=edit`);
    await editorReady(page);
    await browserExpect(page.locator(".pd-code-view__preview svg")).toBeVisible({ timeout: 20_000 });
    await browserExpect(page.locator(".pd-code-view__source--closed")).toHaveCount(1);
    await page.locator(".pd-code-view__preview").click();
    await browserExpect(page.locator(".pd-code-view__source--closed")).toHaveCount(0);
    await browserExpect(page.locator(".pd-zoom")).toHaveCount(0);

    await page.getByRole("button", { name: "Markdown 源码" }).click();
    const box = page.getByRole("textbox", { name: "Markdown 源码" });
    await browserExpect(box).toHaveValue(markdown);
    await box.fill(markdown.replace("结尾", "源码里改的结尾"));
    await page.getByRole("button", { name: "Markdown 源码" }).click();
    await browserExpect(page.locator(".ProseMirror")).toContainText("源码里改的结尾");
    await clickButton(page, "保存");
    await backToReading(page);
    expect((await readPage(id)).markdown).toBe(markdown.replace("结尾", "源码里改的结尾"));
  });

  it("reads steps, tabs, cards, prompts, marked screenshots and comparisons the way they are meant to be used", async () => {
    const before = await app.upload("editor", SPACE, "old.png", testPicture(226, 232, 240));
    const after = await app.upload("editor", SPACE, "new.png", testPicture(14, 165, 233));
    await createPage("卡片指向的页面", "card-target", "卡片指向的正文\n");
    await createPage(
      "演示页",
      "demo",
      [
        ":::steps\n\n### 第一步\n\n先做这个\n\n### 第二步\n\n再做那个\n\n:::",
        "::::tabs\n\n:::tab[甲]\n\n甲标签的内容\n\n:::\n\n:::tab[乙]\n\n乙标签的内容\n\n:::\n\n::::",
        '::::cards\n\n:::card[去看看]{href="./card-target.md"}\n\n卡片的说明\n\n:::\n\n::::',
        '```prompt title="排查报错"\n读取日志，告诉我原因\n```',
        `\`\`\`hotspots src="${before}" alt="控制台"\n[{"x":20,"y":30,"title":"入口","text":"从这里开始"}]\n\`\`\``,
        `::compare[改版]{before="${before}" after="${after}"}`,
        `![图](${after} "图片的说明")`,
        "带脚注的话[^1]\n\n[^1]: 脚注的内容"
      ].join("\n\n")
    );
    const page = await app.open("commenter", `/${SPACE}/demo`);
    await browserExpect(page.locator(".rp-steps > h3")).toHaveCount(2, { timeout: 15_000 });

    await browserExpect(page.getByText("乙标签的内容")).toBeHidden();
    await page.locator(".rp-tabs__label__item", { hasText: "乙" }).click();
    await browserExpect(page.getByText("乙标签的内容")).toBeVisible();

    await selectWords(page, "乙标签");
    await page
      .getByRole("toolbar", { name: "选中文字的操作" })
      .getByRole("button", { name: "评论", exact: true })
      .click();
    await page.getByPlaceholder("写下评论，@ 提及同事").fill("这里要确认");
    await page.locator(".pd-panel").getByRole("button", { name: "发送", exact: true }).click();
    await browserExpect(page.locator(".pd-card").getByText("这里要确认")).toBeVisible();
    const highlighted = () =>
      page.evaluate(() =>
        ["pd-comment", "pd-comment-active"]
          .flatMap(name => [...((CSS as any).highlights.get(name) ?? [])])
          .map((range: Range) => range.toString())
          .join("|")
      );
    await expect.poll(highlighted).toBe("乙标签");
    await page.reload();
    await expect.poll(highlighted, { timeout: 15_000 }).toBe("乙标签");
    await browserExpect(page.getByText("乙标签的内容")).toBeHidden();
    await page.getByRole("button", { name: "评论 1", exact: true }).click();
    await page.locator(".pd-card").getByText("这里要确认").click();
    await browserExpect(page.getByText("乙标签的内容")).toBeVisible();

    await page.locator(".rp-prompt__action-copy").click();
    if (canReadClipboard)
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("读取日志，告诉我原因");

    await page.locator(".pd-hotspots__mark").click();
    await browserExpect(page.locator(".pd-hotspots__tip")).toContainText("从这里开始");
    await page.keyboard.press("Escape");

    const slider = page.getByRole("slider");
    const position = await slider.getAttribute("aria-valuenow");
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => slider.getAttribute("aria-valuenow")).not.toBe(position);

    const brokenImages = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLImageElement>(".pd-hotspots img, .pd-compare img, .pd-figure img")].filter(
            image => !image.complete || image.naturalWidth === 0
          ).length
      );
    await expect.poll(brokenImages).toBe(0);
    await browserExpect(page.locator(".pd-figure__caption")).toHaveText("图片的说明");
    await browserExpect(page.locator(".rp-toc-exclude")).toHaveText(/脚注/u);

    await page.locator(".pd-doc-card__title a").click();
    await browserExpect(page.getByText("卡片指向的正文")).toBeVisible({ timeout: 15_000 });
  });

  it("marks a screenshot by clicking on it, and edits captions, tabs and footnotes in place", async () => {
    const picture = await app.upload("editor", SPACE, "screen.png", testPicture(148, 163, 184));
    const id = await createPage(
      "编辑演示",
      "demo-edit",
      [
        "开头[^1]",
        `\`\`\`hotspots src="${picture}"\n[]\n\`\`\``,
        `![图](${picture})`,
        "::::tabs\n\n:::tab[甲]\n\n内容\n\n:::\n\n::::",
        "[^1]: 脚注的内容",
        ""
      ].join("\n\n")
    );
    const page = await app.open("editor", `/${SPACE}/demo-edit?mode=edit`);
    await editorReady(page);

    const stage = page.locator(".pd-hotspots-edit__stage");
    await browserExpect(stage.locator("img")).toBeVisible();
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByLabel("标注 1 的标题").fill("入口");
    await page.getByLabel("标注 1 的说明").fill("从这里开始");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 4, box.y + box.height / 4, { steps: 6 });
    await page.mouse.up();
    await browserExpect(stage.locator(".pd-hotspots__mark")).toHaveCount(1);

    await page.locator(".ProseMirror > img").click();
    await page.getByLabel("图片说明文字").fill('他说 "好"');
    await browserExpect(page.locator(".ProseMirror .pd-figure")).toHaveAttribute("data-caption", '他说 "好"');

    await page.getByRole("button", { name: "添加标签" }).click();
    // The caret goes into the new tab a frame later, and text meant for the footnote must not go with it.
    await browserExpect(page.locator(".ProseMirror")).toBeFocused();
    await page.getByLabel("脚注 1 的内容").fill("改过的脚注");

    await clickButton(page, "保存");
    await backToReading(page);
    const { markdown } = await readPage(id);
    const [, marks] = /```hotspots[^\n]*\n([\s\S]*?)\n```/u.exec(markdown)!;
    expect(JSON.parse(marks!)).toEqual([{ x: 25, y: 25, title: "入口", text: "从这里开始" }]);
    expect(markdown).toContain('"他说 \\"好\\""');
    expect(markdown).toContain(":::tab[新标签]");
    expect(markdown).toContain("开头[^1]");
    expect(markdown).toContain("[^1]: 改过的脚注");
    await browserExpect(page.locator(".pd-figure__caption")).toHaveText('他说 "好"');
  });

  it("fits a diagram's words inside their boxes, on the page and on a slide", async () => {
    await createPage(
      "流程图文字",
      "diagram-words",
      '## 第一节\n\n```mermaid\nflowchart TD\n  A["第一行<br/>第二行<br/>第三行"] --> B["项目<br/>一个团队的日常项目在这里写得比较长"]\n```\n'
    );
    const overflowing = (page: Page) =>
      page
        .locator("svg foreignObject")
        .evaluateAll(
          labels =>
            labels.filter(
              label =>
                label.firstElementChild!.getBoundingClientRect().height > label.getBoundingClientRect().height + 1
            ).length
        );
    const reading = await app.open("reader", `/${SPACE}/diagram-words`);
    await browserExpect(reading.locator("main svg foreignObject").first()).toBeVisible({ timeout: 20_000 });
    expect(await overflowing(reading)).toBe(0);
    const slides = await app.open("reader", `/${SPACE}/diagram-words?view=slides`);
    await browserExpect(slides.locator(".reveal .present h1")).toBeVisible({ timeout: 15_000 });
    await slides.keyboard.press("ArrowRight");
    await browserExpect(slides.locator(".reveal .present svg foreignObject").first()).toBeVisible({ timeout: 20_000 });
    expect(await overflowing(slides)).toBe(0);
  });

  it("enlarges a diagram on click, to zoom and move around, on the page and on a slide", async () => {
    await createPage(
      "放大流程图",
      "diagram-zoom",
      '## 第一节\n\n```mermaid\nflowchart LR\n  A["第一步"] --> B["第二步"] --> C["第三步"] --> D["第四步"] --> E["第五步"] --> F["第六步"] --> G["第七步"] --> H["第八步"]\n```\n'
    );
    const page = await app.open("reader", `/${SPACE}/diagram-zoom`);
    const diagram = page.locator("main .pd-diagram");
    await browserExpect(diagram.locator("svg")).toBeVisible({ timeout: 20_000 });
    const onThePage = (await diagram.locator("svg").boundingBox())!;

    await diagram.click();
    const enlarged = page.getByRole("dialog", { name: "流程图" }).locator(".pd-zoom__canvas svg");
    await browserExpect(enlarged).toBeVisible();
    const fitted = (await enlarged.boundingBox())!;
    expect(fitted.width).toBeGreaterThan(onThePage.width * 1.5);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(1440);

    await page.mouse.move(720, 450);
    await page.mouse.wheel(0, -400);
    await expect.poll(async () => (await enlarged.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.5);
    const zoomed = (await enlarged.boundingBox())!;
    await page.mouse.down();
    await page.mouse.move(620, 390, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await enlarged.boundingBox())!.x - zoomed.x)).toBe(-100);
    expect(Math.round((await enlarged.boundingBox())!.y - zoomed.y)).toBe(-60);

    await page.getByRole("button", { name: "适应窗口" }).click();
    await expect.poll(async () => Math.round((await enlarged.boundingBox())!.width)).toBe(Math.round(fitted.width));
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await expect.poll(async () => (await enlarged.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.2);

    await page.keyboard.press("Escape");
    await browserExpect(page.locator(".pd-zoom")).toHaveCount(0);
    await browserExpect(diagram).toBeFocused();
    await page.keyboard.press("Enter");
    await browserExpect(enlarged).toBeVisible();
    await page.keyboard.press("Escape");
    await browserExpect(page.locator(".pd-zoom")).toHaveCount(0);

    const slides = await app.open("reader", `/${SPACE}/diagram-zoom?view=slides`);
    await browserExpect(slides.locator(".reveal .present h1")).toBeVisible({ timeout: 15_000 });
    await slides.keyboard.press("ArrowRight");
    const onSlide = slides.locator(".reveal .present .pd-diagram");
    await browserExpect(onSlide.locator("svg")).toBeVisible({ timeout: 20_000 });
    await onSlide.click();
    await browserExpect(slides.locator(".pd-zoom__canvas svg")).toBeVisible();
    const slideNumber = () => slides.locator(".reveal .slide-number").textContent();
    const before = await slideNumber();
    await slides.keyboard.press("ArrowLeft");
    await slides.waitForTimeout(300);
    expect(await slideNumber()).toBe(before);
    await slides.keyboard.press("Escape");
    await browserExpect(slides.locator(".pd-zoom")).toHaveCount(0);
    await browserExpect(slides.locator(".pd-present")).toHaveCount(1);
    await slides.keyboard.press("Escape");
    await browserExpect(slides.locator(".pd-present")).toHaveCount(0);
  });

  it("zooms ordinary images, but not the ones a block has its own use for", async () => {
    const picture = await app.upload("editor", SPACE, "zoom.png", testPicture(148, 163, 184));
    const other = await app.upload("editor", SPACE, "zoom-other.png", testPicture(14, 165, 233));
    await createPage(
      "图片放大",
      "image-zoom",
      [
        `![普通图片](${picture})`,
        `\`\`\`hotspots src="${picture}"\n[{"x":20,"y":30,"title":"入口"}]\n\`\`\``,
        `::compare{before="${picture}" after="${other}"}`,
        ""
      ].join("\n\n")
    );
    const page = await app.open("reader", `/${SPACE}/image-zoom`);
    await browserExpect(page.locator(".pd-compare img").first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(400);
    const opened = page.locator(".medium-zoom-image--opened");

    await page.locator(".pd-hotspots__stage img").click({ position: { x: 300, y: 200 } });
    await page.waitForTimeout(300);
    await browserExpect(opened).toHaveCount(0);

    await page
      .locator(".pd-compare img")
      .first()
      .click({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(300);
    await browserExpect(opened).toHaveCount(0);

    await page.locator('img[alt="普通图片"]').click();
    await browserExpect(opened).toHaveCount(1);
  });

  it("changes a title in the editor", async () => {
    const id = await createPage("旧标题", "retitle", "内容\n");
    const page = await app.open("editor", `/${SPACE}/retitle?mode=edit`);
    await editorReady(page);
    await page.getByLabel("标题").fill("新标题");
    await clickButton(page, "保存");
    await browserExpect(page.locator(".rp-sidebar-item", { hasText: "新标题" })).toBeVisible({ timeout: 15_000 });
    expect((await readPage(id)).document.title).toBe("新标题");
  });

  it("tells someone who can only read why the editor did not open", async () => {
    await createPage("只能读", "read-only", "只能读这一页\n");
    const page = await app.open("reader", `/${SPACE}/read-only?mode=edit`);
    await browserExpect(page.getByText("只能读这一页")).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("status").filter({ hasText: "你只能阅读这一页，不能修改" })).toBeVisible();
    await browserExpect(page.locator(".ProseMirror")).toHaveCount(0);
  });

  it("switches between reading and editing in one go, never showing an empty page", async () => {
    await createPage("一步切换", "one-step", "第一段\n\n第二段\n");
    const page = await app.open("editor", `/${SPACE}/one-step`);
    await browserExpect(page.getByText("第一段")).toBeVisible({ timeout: 15_000 });
    // What each frame shows from here on: the page as read, the editor with the text, both, or nothing at all.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      const sample = () => {
        const reading = document.querySelector("[data-pandocs-body]")?.textContent?.includes("第一段");
        const editing = document.querySelector(".ProseMirror")?.textContent?.includes("第一段");
        const state = reading && editing ? "both" : reading ? "reading" : editing ? "editing" : "neither";
        if (seen.at(-1) !== state) seen.push(state);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.getByRole("link", { name: "编辑", exact: true }).first().click();
    await editorReady(page);
    await clickButton(page, "退出编辑");
    await backToReading(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([
      "reading",
      "editing",
      "reading"
    ]);
  });

  it("shows hostile titles and headings as text, and no script runs", async () => {
    const attack = '<img src=x onerror="window.__xss=1"/>';
    await createPage(`标题${attack}`, "xss", `## 小节${attack.replace("<", "&lt;").replace(">", "&gt;")}\n\n正文\n`);
    const page = await app.open("reader", `/${SPACE}/xss`);
    await browserExpect(page.locator("main h1")).toContainText(attack, { timeout: 15_000 });
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => ({
        ran: (window as any).__xss,
        images: document.querySelectorAll('img[src="x"]').length
      }))
    ).toEqual({ images: 0 });

    const map = await app.open("reader", `/${SPACE}/xss?view=mindmap`);
    await browserExpect(map.locator(".markmap-foreign").filter({ hasText: attack }).first()).toBeVisible({
      timeout: 15_000
    });
    await map.waitForTimeout(500);
    expect(
      await map.evaluate(() => ({
        ran: (window as any).__xss,
        images: document.querySelectorAll('img[src="x"]').length
      }))
    ).toEqual({ images: 0 });

    const slides = await app.open("reader", `/${SPACE}/xss?view=slides`);
    await browserExpect(slides.locator(".reveal .present h1")).toContainText(attack, { timeout: 15_000 });
    await slides.waitForTimeout(500);
    expect(
      await slides.evaluate(() => ({
        ran: (window as any).__xss,
        images: document.querySelectorAll('img[src="x"]').length
      }))
    ).toEqual({ images: 0 });
  });

  it("presents a page as slides and as a mind map, and comes back to reading", async () => {
    const picture = await app.upload("editor", SPACE, "deck.png", testPicture(148, 163, 184));
    await createPage(
      "讲给大家听",
      "deck",
      [
        "开场白",
        "## 第一节",
        "第一节的内容",
        "```mermaid\nflowchart LR\n  A --> B\n```",
        "---",
        "分隔线后面的内容[^1]",
        "## 第二节",
        "第二节的内容",
        "```mindmap\n# 中心\n\n- 第一个分支\n- 第二个分支\n```",
        `\`\`\`hotspots src="${picture}"\n[{"x":20,"y":30,"title":"入口","text":"从这里开始"}]\n\`\`\``,
        "[^1]: 脚注的内容",
        ""
      ].join("\n\n")
    );
    const page = await app.open("reader", `/${SPACE}/deck`);
    await browserExpect(page.locator(".pd-mindmap .markmap-foreign").filter({ hasText: "第二个分支" })).toBeVisible({
      timeout: 20_000
    });

    await page.getByRole("button", { name: "此页更多操作" }).click();
    await page.getByRole("menuitem", { name: "演示" }).click();
    const slide = page.locator(".reveal .slides > section.present");
    await browserExpect(slide.locator("h1")).toHaveText("讲给大家听", { timeout: 15_000 });
    await browserExpect(slide).toContainText("开场白");
    // Each section, the divider and the footnotes; the section footnotes come in does not count as a slide of its own.
    await browserExpect(page.locator(".reveal .slide-number")).toContainText("1 / 5");
    await page.keyboard.press("ArrowRight");
    await browserExpect(slide.locator("h2")).toHaveText(/第一节/u);
    await browserExpect(slide.locator("svg")).toBeVisible({ timeout: 20_000 });
    await page.keyboard.press("ArrowRight");
    await browserExpect(slide).toContainText("分隔线后面的内容");
    await page.keyboard.press("ArrowRight");
    await slide.locator(".pd-hotspots__mark").click();
    await browserExpect(page.locator(".pd-hotspots__tip")).toContainText("从这里开始");
    await page.keyboard.press("Escape");
    await browserExpect(page.locator(".pd-hotspots__tip")).toHaveCount(0);
    await browserExpect(page.locator(".pd-present")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await browserExpect(page.locator(".pd-present")).toHaveCount(0);
    await browserExpect(page.locator("main h1")).toHaveText(/讲给大家听/u);

    await page.getByRole("button", { name: "此页更多操作" }).click();
    await page.getByRole("menuitem", { name: "脑图" }).click();
    const branch = page.locator(".pd-present .markmap-foreign").filter({ hasText: "第二节" });
    await browserExpect(branch).toBeVisible({ timeout: 15_000 });
    await branch.click();
    await browserExpect(page.locator(".pd-present")).toHaveCount(0);
    expect(decodeURIComponent(new URL(page.url()).hash)).toBe("#第二节");
  });

  it("leaves comment highlights off paper", async () => {
    const id = await createPage("打印页", "print", "要打印的内容\n");
    await app.api("commenter", "POST", `documents/${id}/threads`, {
      anchor: { kind: "quote", quote: "打印" },
      body: "看这里"
    });
    const page = await app.open("reader", `/${SPACE}/print`);
    await expect
      .poll(() => page.evaluate(() => (CSS as any).highlights.get("pd-comment")?.size ?? 0), { timeout: 15_000 })
      .toBe(1);
    const shade = () => page.evaluate(() => getComputedStyle(document.body, "::highlight(pd-comment)").backgroundColor);
    expect(await shade()).not.toBe("rgba(0, 0, 0, 0)");
    await page.emulateMedia({ media: "print" });
    expect(await shade()).toBe("rgba(0, 0, 0, 0)");
  });

  it("uses AI on words being edited, and replaces them only when asked", async () => {
    const id = await createPage("编辑 AI 页", "editor-ai", "第一段要改的内容。\n\n第二段。\n");
    const page = await app.open("editor", `/${SPACE}/editor-ai?mode=edit`);
    await editorReady(page);
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("再加一句");
    await page.keyboard.press("Shift+Home");
    await page.getByRole("toolbar", { name: "选中文字的格式" }).getByRole("button", { name: "AI" }).click();
    await page.getByRole("menuitem", { name: "改写" }).click();
    await browserExpect(page.locator(".pd-assist__text")).toHaveText("AI 的结果", { timeout: 15_000 });
    await browserExpect(page.locator(".ProseMirror")).not.toContainText("AI 的结果");
    await clickButton(page, "替换选中文字");
    await browserExpect(page.locator(".ProseMirror p").first()).toHaveText("AI 的结果");
    await browserExpect(page.locator(".ProseMirror p")).toHaveCount(2);
    await clickButton(page, "保存");
    await backToReading(page);
    expect((await readPage(id)).markdown).toBe("AI 的结果\n\n第二段。\n");
  });

  it("brings back an exported zip, and imports several files at once", async () => {
    await app.api("admin", "POST", "spaces", { slug: "restored", name: "恢复到这里", defaultRole: "viewer" });
    await app.api("admin", "PUT", "spaces/restored/members", { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    const page = await app.open("editor", "/_/spaces/restored/imports");
    const archive = await page.evaluate(async space => {
      const response = await fetch(`/api/v1/spaces/${space}/export`);
      return [...new Uint8Array(await response.arrayBuffer())];
    }, SPACE);
    await page.getByLabel("上传要导入的文件").setInputFiles([
      { name: "backup.zip", mimeType: "application/zip", buffer: Buffer.from(archive) },
      { name: "第一个.md", mimeType: "text/markdown", buffer: Buffer.from("第一个文件\n") },
      { name: "第二个.md", mimeType: "text/markdown", buffer: Buffer.from("第二个文件\n") }
    ]);
    await browserExpect(page.getByLabel("压缩包导入结果")).toContainText(/压缩包导入完成：新建 \d+ 页/u, {
      timeout: 30_000
    });
    await browserExpect(page.locator(".pd-notice-row")).toHaveCount(2, { timeout: 30_000 });
    const restored = (await app.api("editor", "GET", "spaces/restored/tree")).data as { title: string }[];
    expect(restored.map(node => node.title)).toContain("旧标题".replace("旧", "新"));
    // Each waits to be looked at, and publishing one goes on to the next.
    await app.settleImports();
    await browserExpect(page.locator(".pd-notice-row", { hasText: "待发布" })).toHaveCount(2, { timeout: 30_000 });
    const details = page.getByLabel("导入详情");
    await browserExpect(details).toContainText("第一个.md");
    await details.getByRole("button", { name: "发布", exact: true }).click();
    await browserExpect(details).toContainText("第二个.md", { timeout: 15_000 });
    await browserExpect(page.locator(".pd-notice-row", { hasText: "待发布" })).toHaveCount(1, { timeout: 15_000 });
  });

  it("gives a new Chinese page a short address and offers it for old ones, and old links keep working", async () => {
    await app.api("admin", "POST", "spaces", { slug: "addresses", name: "地址", defaultRole: "viewer" });
    await app.api("admin", "PUT", "spaces/addresses/members", { subject: `user:${PEOPLE.editor.id}`, role: "editor" });
    await app.api("editor", "POST", "spaces/addresses/documents", {
      title: "旧页",
      slug: "旧地址",
      markdown: "旧页内容\n"
    });
    const page = await app.open("editor", "/_/spaces/addresses/pages");
    await clickButton(page, "新建页面");
    await page.getByRole("dialog").getByLabel("标题").fill("新的中文页面");
    await page.getByRole("dialog").getByRole("button", { name: "新建" }).click();
    // It opens in the editor, which has to finish before going anywhere else.
    await page.waitForURL(/\?mode=edit$/u);
    await expect
      .poll(
        async () =>
          ((await app.api("editor", "GET", "spaces/addresses/tree")).data as { title: string; path: string }[]).find(
            node => node.title === "新的中文页面"
          )?.path,
        { timeout: 15_000 }
      )
      .toMatch(/^[0-9a-f]{8}$/u);

    await page.goto(`${app.origin}/_/spaces/addresses/pages`);
    await clickButton(page, "换成短地址");
    // The page reloads once the addresses have changed, since its sidebar comes from when it loaded. The server knows
    // a little before the page does, so going elsewhere before that reload is over has the reload cut it short.
    const reloaded = page.waitForEvent("load");
    await page.getByRole("alertdialog").getByRole("button", { name: "更换" }).click();
    await reloaded;
    await expect
      .poll(
        async () =>
          ((await app.api("editor", "GET", "spaces/addresses/tree")).data as { title: string; path: string }[]).find(
            node => node.title === "旧页"
          )?.path,
        { timeout: 15_000 }
      )
      .toMatch(/^[0-9a-f]{8}$/u);
    await page.goto(`${app.origin}/addresses/${encodeURIComponent("旧地址")}`);
    await browserExpect(page.getByText("旧页内容")).toBeVisible({ timeout: 15_000 });
  });

  it("goes where it was sent when someone leaves a page that is still loading", async () => {
    await createPage("还在加载", "still-loading", "还在加载\n");
    const page = await app.open("editor", `/${SPACE}/still-loading`);
    // The editor's code comes after the page itself. Held back, it is certain to be loading still when the page is left.
    await page.route(/\/assets\/editor-page-[^/]+\.js$/u, async route => {
      await new Promise(done => setTimeout(done, 3000));
      await route.continue().catch(() => undefined);
    });
    const asked = page.waitForRequest(/\/assets\/editor-page-[^/]+\.js$/u);
    await page.goto(`${app.origin}/${SPACE}/still-loading?mode=edit`, { waitUntil: "domcontentloaded" });
    await asked;
    await page.goto(`${app.origin}/_/spaces/${SPACE}/pages`);
    await browserExpect(page.getByRole("button", { name: "新建页面" })).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toBe(`${app.origin}/_/spaces/${SPACE}/pages`);
  });

  // WebKit does not ask again for a chunk that has failed, even after a reload. A release renames what it changes, which this cannot imitate.
  it.skipIf(engineName === "webkit")(
    "reloads once to pick up a release that took away code an open page still needs",
    async () => {
      await createPage("新版本", "new-release", "新版本\n");
      const page = await app.open("editor", `/${SPACE}/new-release`);
      await page.route(/\/assets\/editor-page-[^/]+\.js$/u, route => route.fulfill({ status: 404 }), { times: 1 });
      const reloaded = page.waitForEvent("load");
      await page.getByRole("link", { name: "编辑", exact: true }).first().click();
      await reloaded;
      await editorReady(page);
    }
  );

  it("does not keep reloading when that code cannot be had", async () => {
    await createPage("还是缺", "still-missing", "还是缺\n");
    const page = await app.open("editor", `/${SPACE}/still-missing`);
    await page.route(/\/assets\/editor-page-[^/]+\.js$/u, route => route.fulfill({ status: 404 }));
    let loads = 0;
    page.on("load", () => {
      loads += 1;
    });
    await page.getByRole("link", { name: "编辑", exact: true }).first().click();
    await expect.poll(() => loads, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(3000);
    expect(loads).toBe(1);
  });

  it("leaves the Enter that picks a word to an input method", async () => {
    await createPage("输入法页", "input-method", "输入法页的内容\n");
    await createPage("输入法目标", "input-method-target", "只有这里写着落款\n");
    const page = await app.open("editor", `/${SPACE}/input-method`);
    await browserExpect(page.getByText("输入法页的内容")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "标签", exact: true }).click();
    const label = page.getByRole("combobox", { name: "新标签" });
    await label.fill("输入");
    await enterForWord(label);
    await browserExpect(page.locator(".pd-labels").getByRole("button", { name: "输入", exact: true })).toHaveCount(0);
    await label.press("Enter");
    await browserExpect(page.locator(".pd-labels").getByRole("button", { name: "输入", exact: true })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+k");
    const search = page.locator(".rp-search-panel__input");
    await search.fill("落款");
    await browserExpect(
      page.locator(".rp-suggest-item__title, .rp-suggest-item__header").filter({ hasText: "输入法目标" }).first()
    ).toBeVisible({ timeout: 15_000 });
    await enterForWord(search);
    await page.waitForTimeout(1000);
    expect(new URL(page.url()).pathname).toBe(`/${SPACE}/input-method`);
    await search.press("Enter");
    await page.waitForURL(`**/${SPACE}/input-method-target`);
  });

  it("opens the site with its logo, a way in, and what changed lately", async () => {
    await createPage("最近改过", "lately", "最近改过的内容\n");
    const page = await app.open("editor", "/");
    await browserExpect(page.locator(".rp-nav__title__logo-image").first()).toHaveAttribute("src", /\/logo\.svg$/u);
    await browserExpect(page.getByRole("link", { name: "开始阅读" })).toBeVisible({ timeout: 15_000 });
    await browserExpect(
      page.getByRole("region", { name: "最近更新" }).getByRole("link", { name: "最近改过" })
    ).toBeVisible();
  });

  it("says which space a search result came from", async () => {
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, {
      title: "搜索目标页",
      slug: "search-target",
      markdown: "搜索目标的正文\n"
    });
    const page = await app.open("reader", `/${SPACE}/select`);
    await browserExpect(page.getByText("第二段普通说明")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("ControlOrMeta+k");
    await page.locator(".rp-search-panel input, [class*=search-panel] input").first().fill("搜索目标");
    await browserExpect(
      page.locator(".rp-suggest-item__header, .rp-suggest-item__title").filter({ hasText: "端到端" }).first()
    ).toBeVisible({ timeout: 15_000 });
  });

  it("reminds people of a draft on the page and lists it, and fills terms from a table", async () => {
    const id = await createPage("提醒页", "reminded", "提醒页内容\n");
    await app.api("editor", "PUT", `documents/${id}/draft`, { markdown: "没写完的内容\n", baseRevision: 1 });
    const page = await app.open("editor", `/${SPACE}/reminded`);
    await browserExpect(page.getByText(/你有一份没有保存的草稿/u)).toBeVisible({ timeout: 15_000 });
    await page.goto(`${app.origin}/_/drafts`);
    await browserExpect(page.getByRole("link", { name: "提醒页" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "提醒页" }).click();
    await clickButton(page, "继续编辑草稿");
    await browserExpect(page.locator(".ProseMirror")).toContainText("没写完的内容");

    await createPage("术语来源", "terms-source", "| 术语 | 解释 |\n| --- | --- |\n| 书脊 | 书背朝外的部分 |\n");
    const admin = await app.open("admin", `/_/spaces/${SPACE}/glossary`);
    await choose(admin.getByLabel("从页面的表格导入"), "术语来源");
    await clickButton(admin, "导入");
    await browserExpect(admin.locator("input").and(admin.locator('[value="书脊"]'))).toHaveCount(1, {
      timeout: 15_000
    });
  });

  it("empties the trash", async () => {
    const id = await createPage("要删的页", "to-delete", "内容\n");
    await app.api("editor", "DELETE", `documents/${id}`);
    const page = await app.open("admin", `/_/spaces/${SPACE}/trash`);
    await clickButton(page, "清空回收站");
    await page.getByRole("alertdialog").getByRole("button", { name: "清空" }).click();
    await browserExpect(page.getByText("回收站是空的")).toBeVisible({ timeout: 15_000 });
  });

  it("deletes a translation from its page", async () => {
    await app.api("admin", "PATCH", "site", {
      defaultLang: "zh",
      locales: [
        { lang: "zh", label: "简体中文" },
        { lang: "en", label: "English" }
      ]
    });
    const id = await createPage("有译文的页", "translated", "原文内容\n");
    await app.api("editor", "PUT", `documents/${id}/translations/en`, {
      title: "Translated",
      markdown: "English body\n",
      sourceRevision: 1,
      machine: false
    });
    const page = await app.open("editor", `/en/${SPACE}/translated`);
    await browserExpect(page.getByText("English body")).toBeVisible({ timeout: 15_000 });
    // Pages under /en are read in English, whatever this browser asks for elsewhere.
    await clickButton(page, "Delete translation");
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await browserExpect(page.getByText(/no English version yet/u)).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByText("原文内容")).toBeVisible();
    await app.api("admin", "PATCH", "site", { defaultLang: "en", locales: [{ lang: "en", label: "English" }] });
  });

  it("answers a space that does not exist with the theme's own page", async () => {
    const page = await app.open("reader", "/no-such-space/");
    await browserExpect(page.locator(".rp-not-found__title")).toBeVisible({ timeout: 15_000 });
  });

  it("was never held back by the page's content security policy", async () => {
    expect(app.cspReports).toEqual([]);
  });
});
