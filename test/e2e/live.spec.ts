import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect as browserExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { usePostgresFixture } from "../../packages/core/test/postgres.js";
import { hashPassword } from "../../packages/server/src/auth/passwords.js";
import { createChangeListener } from "../../packages/server/src/change-listener.js";
import { listen } from "../../packages/server/src/listen.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "../../packages/server/test/support.js";
import { engineName, launchBrowser, pandocsDescribe } from "./fixture.js";

const postgres = usePostgresFixture();
const ROOT = resolve(import.meta.dirname, "../..");
const PASSWORD = "correct horse battery";
const BASE = "# Guide\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

interface Replica {
  readonly server: TestServer;
  http: ReturnType<typeof listen>;
  origin: string;
}

/** Real servers, two of them on one database, and people in separate browsers reaching different ones. */
pandocsDescribe("editing a page together", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pandocs-live-"));
  const env = { PANDOCS_WEB_DIR: join(ROOT, "packages/web/dist"), PANDOCS_DATA_DIR: dataDir, PANDOCS_LIVE_RECHECK_SECONDS: "1" };
  let one: Replica;
  let other: Replica;
  let admin: Client;
  let bob: Client;
  let browser: Browser;
  let listener: ReturnType<typeof createChangeListener>;
  let pageNo = 0;
  let id = "";
  let slug = "";
  let problems: string[] = [];
  const contexts: BrowserContext[] = [];

  const serve = async (server: TestServer, port = 0): Promise<Replica> => {
    const replica = { server } as Replica;
    await new Promise<void>(done => {
      replica.http = listen(server.app, { hostname: "127.0.0.1", port }, info => {
        replica.origin = `http://127.0.0.1:${info.port}`;
        done();
      });
    });
    replica.http.on("upgrade", server.runtime.live.handleUpgrade);
    return replica;
  };

  const person = async (displayName: string, role: string) => {
    const email = `${displayName}-${crypto.randomUUID()}@example.test`.toLowerCase();
    const user = await one.server.runtime.users.create({ email, displayName, passwordHash: await hashPassword(PASSWORD) });
    const client = one.server.client();
    await client.form("/login", { email, password: PASSWORD, next: "/" });
    await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${user.id}`, role });
    return { client, user };
  };

  const open = async (at: Replica, as: Client, path = `/shop/${slug}?mode=edit`): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    contexts.push(context);
    await context.addCookies([...as.cookies].map(([name, value]) => ({ name, value, url: at.origin })));
    const page = await context.newPage();
    // WebKit reports sizes that had to wait a frame to be passed on, which loses nothing.
    page.on("pageerror", error => { if (!error.message.startsWith("ResizeObserver loop")) problems.push(error.message); });
    page.on("console", message => {
      const text = message.text();
      if (message.type() === "error" && !text.includes("favicon") && !/ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|ERR_INCOMPLETE_CHUNKED_ENCODING|WebSocket connection|ResizeObserver loop/u.test(text)) problems.push(text);
    });
    await page.goto(`${at.origin}${path}`);
    return page;
  };

  const ready = async (page: Page) => {
    await browserExpect(page.locator(".ProseMirror")).toBeVisible({ timeout: 20_000 });
    await browserExpect(page.locator(".ProseMirror")).toContainText("First paragraph.", { timeout: 20_000 });
    await browserExpect(page.getByText("Synced", { exact: true })).toBeVisible({ timeout: 10_000 });
  };
  /** Puts the caret at the end of a paragraph, and types. */
  const typeAtEnd = async (page: Page, paragraph: string, text: string) => {
    await page.locator(".ProseMirror p", { hasText: paragraph }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(text);
  };
  const shows = (page: Page, text: string) => browserExpect(page.locator(".ProseMirror")).toContainText(text, { timeout: 10_000 });
  const lacks = (page: Page, text: string) => browserExpect(page.locator(".ProseMirror")).not.toContainText(text, { timeout: 10_000 });
  const published = async () => (await admin.json("GET", `/api/v1/documents/${id}`)).data as { markdown: string; revision: { no: number } };
  const saveThroughApi = async (markdown: string) => {
    const { revision } = await published();
    const saved = await admin.json("PUT", `/api/v1/documents/${id}/content`, { markdown, expectedRevision: revision.no }, { "idempotency-key": crypto.randomUUID() });
    expect(saved.error).toBeUndefined();
  };

  beforeAll(async () => {
    execFileSync("pnpm", ["--filter", "@pandocs/web", "build"], { cwd: ROOT, stdio: "ignore" });
    const first = await startServer(postgres.getConnectionString(), env);
    const second = await startServer(postgres.getConnectionString(), env);
    admin = await signInFirstAdmin(first);
    one = await serve(first);
    other = await serve(second);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    bob = (await person("Bob", "editor")).client;
    listener = createChangeListener(postgres.getConnectionString(), () => {
      one.server.runtime.live.wake();
      other.server.runtime.live.wake();
    });
    browser = await launchBrowser();
  }, 300_000);

  afterAll(async () => {
    listener.stop();
    await browser?.close();
    for (const replica of [one, other]) {
      await replica.server.runtime.live.stop();
      replica.http.closeAllConnections();
      await new Promise(done => { replica.http.close(done); });
      await replica.server.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    pageNo += 1;
    slug = `guide-${pageNo}`;
    problems = [];
    const made = await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "Guide", slug, markdown: BASE });
    expect(made.error).toBeUndefined();
    id = made.data.document.id;
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.close()));
    expect(problems).toEqual([]);
  });

  it("shows two people on different servers what the other types, and who and where they are", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await typeAtEnd(alice, "First paragraph.", " Typed by the first.");
    await shows(bobs, "First paragraph. Typed by the first.");
    await typeAtEnd(bobs, "Third paragraph.", " Typed by the other.");
    await shows(alice, "Third paragraph. Typed by the other.");
    await browserExpect(alice.locator(".pd-editor__people .pd-avatar")).toHaveCount(1, { timeout: 10_000 });
    await browserExpect(alice.locator(".pd-editor__people")).toHaveAttribute("title", "Bob");
    await browserExpect(alice.locator(".collaboration-carets__label", { hasText: "Bob" })).toBeVisible({ timeout: 10_000 });
    await browserExpect(bobs.locator(".collaboration-carets__label").first()).toBeVisible({ timeout: 10_000 });
    // Nothing is published by typing.
    expect((await published()).revision.no).toBe(1);
    const reader = await open(one, admin, `/shop/${slug}`);
    await browserExpect(reader.getByText("Third paragraph.")).toBeVisible();
    await browserExpect(reader.getByText("Typed by the first.")).toHaveCount(0);
  }, 120_000);

  // An input method shows letters until a word is chosen. Only Chromium lets a test drive one.
  it.skipIf(engineName !== "chromium")("keeps a word typed with an input method whole while someone else edits the same paragraph", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    const inputMethod = await alice.context().newCDPSession(alice);
    await alice.locator(".ProseMirror p", { hasText: "First paragraph." }).click();
    await alice.keyboard.press("End");
    for (const letters of ["n", "ni", "nih", "niha", "nihao"]) {
      await inputMethod.send("Input.imeSetComposition", { text: letters, selectionStart: letters.length, selectionEnd: letters.length });
    }
    await bobs.locator(".ProseMirror p", { hasText: "First paragraph." }).click();
    await bobs.keyboard.press("Home");
    await bobs.keyboard.type("Before. ");
    await typeAtEnd(bobs, "Third paragraph.", " Meanwhile.");
    // Their typing reaches this page while the word is still being chosen.
    await alice.waitForTimeout(2000);
    await inputMethod.send("Input.insertText", { text: "你好" });
    for (const page of [alice, bobs]) {
      await shows(page, "Before. First paragraph.你好");
      await shows(page, "Third paragraph. Meanwhile.");
      const text = await page.locator(".ProseMirror").innerText();
      expect(text.split("你好")).toHaveLength(2);
      expect(text).not.toMatch(/n(?:i|ih|iha|ihao)?你好|nihao/u);
    }
  }, 120_000);

  it("brings in what an agent or a tool saves while people are typing", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await typeAtEnd(alice, "First paragraph.", " Typing.");
    await shows(bobs, "First paragraph. Typing.");
    await saveThroughApi(BASE.replace("Second paragraph.", "Second paragraph, from the API."));
    await shows(alice, "Second paragraph, from the API.");
    await shows(bobs, "Second paragraph, from the API.");
    await shows(alice, "First paragraph. Typing.");
    await browserExpect(alice.getByText(/saved a new version/u)).toBeVisible({ timeout: 10_000 });
    // Saving now keeps both.
    await browserExpect(alice.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 10_000 });
    await alice.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(alice.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    const { markdown } = await published();
    expect(markdown).toBe("# Guide\n\nFirst paragraph. Typing.\n\nSecond paragraph, from the API.\n\nThird paragraph.\n");
  }, 120_000);

  it("says so when an outside change hits the same place, keeps what is in the draft, and loses nothing", async () => {
    const alice = await open(one, admin);
    await ready(alice);
    await typeAtEnd(alice, "Second paragraph.", " Mine.");
    // It has to have reached the database for it to count as changed there.
    await browserExpect(alice.getByText("Synced", { exact: true })).toBeVisible();
    await saveThroughApi(BASE.replace("Second paragraph.", "Second paragraph, theirs."));
    await browserExpect(alice.getByText(/saved a change to the same place/u)).toBeVisible({ timeout: 15_000 });
    await shows(alice, "Second paragraph. Mine.");
    await lacks(alice, "theirs");
    await alice.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(alice.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    expect((await published()).markdown).toContain("Second paragraph. Mine.");
    expect((await admin.json("GET", `/api/v1/documents/${id}/revisions/2`)).data.markdown).toContain("theirs");
  }, 120_000);

  it("saves what everyone wrote, says who, and lets the others carry on", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await typeAtEnd(bobs, "First paragraph.", " From Bob.");
    await shows(alice, "First paragraph. From Bob.");
    await browserExpect(alice.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 5000 });
    // It takes a moment to be on record as his.
    await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved?.contributors, { timeout: 15_000 }).toEqual(["Bob"]);
    await alice.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(alice.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    await browserExpect(alice.getByText("From Bob.")).toBeVisible();
    const { data: revisions } = await admin.json("GET", `/api/v1/documents/${id}/revisions`);
    expect(revisions[0].message).toContain("Bob");
    await browserExpect(bobs.getByText(/saved a new version/u)).toBeVisible({ timeout: 10_000 });
    // It is all in the draft already, so there is no talk of merging later.
    await browserExpect(bobs.getByText(/Saving merges it/u)).toBeHidden();
    // Nothing is left to save, and he can go on.
    await browserExpect(bobs.getByRole("button", { name: "Save", exact: true })).toBeDisabled({ timeout: 10_000 });
    await typeAtEnd(bobs, "Third paragraph.", " More.");
    await browserExpect(bobs.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 5000 });
    await bobs.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(bobs.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    const { markdown, revision } = await published();
    expect(revision.no).toBe(3);
    expect(markdown).toBe("# Guide\n\nFirst paragraph. From Bob.\n\nSecond paragraph.\n\nThird paragraph. More.\n");
  }, 120_000);

  it("undoes only what you did yourself", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await typeAtEnd(bobs, "First paragraph.", " Bob stays.");
    await shows(alice, "Bob stays.");
    await typeAtEnd(alice, "Third paragraph.", " Alice goes.");
    await shows(bobs, "Alice goes.");
    await alice.getByRole("button", { name: "Undo", exact: true }).click();
    await lacks(alice, "Alice goes.");
    await lacks(bobs, "Alice goes.");
    await shows(alice, "Bob stays.");
    await alice.getByRole("button", { name: "Redo", exact: true }).click();
    await shows(bobs, "Alice goes.");
  }, 120_000);

  it("keeps a draft for whoever comes next, tells them about it, and takes everyone back if someone discards it", async () => {
    const alice = await open(one, admin);
    await ready(alice);
    await typeAtEnd(alice, "First paragraph.", " Left behind.");
    await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved?.contributors, { timeout: 15_000 }).toHaveLength(1);
    await alice.getByRole("button", { name: "Stop editing" }).click();
    await browserExpect(alice.getByText(/shared draft, for you or anyone else/u)).toBeVisible();
    await browserExpect(alice.getByText(/has unsaved changes from/u)).toBeVisible({ timeout: 10_000 });
    await browserExpect(alice.locator("main").getByText("Left behind.")).toHaveCount(0);

    const drafts = await open(one, admin, "/_/drafts");
    await browserExpect(drafts.getByRole("row").filter({ has: drafts.locator(`a[href*="${slug}"]`) })).toContainText("shared with everyone");

    const bobs = await open(other, bob, `/shop/${slug}`);
    await browserExpect(bobs.getByText(/has unsaved changes from/u)).toBeVisible({ timeout: 15_000 });
    await bobs.getByRole("link", { name: "Continue editing" }).click();
    await shows(bobs, "Left behind.");

    const second = await open(one, admin);
    await shows(second, "Left behind.");
    await bobs.getByRole("button", { name: "Discard changes" }).click();
    await bobs.getByRole("alertdialog").or(bobs.getByRole("dialog")).getByRole("button", { name: "Discard changes" }).click();
    await lacks(bobs, "Left behind.");
    await lacks(second, "Left behind.");
    await browserExpect(second.getByText(/discarded the unsaved changes/u)).toBeVisible({ timeout: 10_000 });
    await browserExpect(bobs.getByRole("button", { name: "Save", exact: true })).toBeDisabled({ timeout: 10_000 });
  }, 120_000);

  // Offline, Firefox and WebKit keep an open connection going, so there is nothing lost to test there. Losing the server, below, covers it.
  it.skipIf(engineName !== "chromium")("carries on through losing the connection, and merges when it is back", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await alice.context().setOffline(true);
    // The browser does not end a connection for this, so it takes as long as noticing that nothing is coming through.
    await browserExpect(alice.getByText(/Not connected/u)).toBeVisible({ timeout: 60_000 });
    await typeAtEnd(alice, "First paragraph.", " Typed offline.");
    await typeAtEnd(bobs, "Third paragraph.", " Typed online.");
    await lacks(alice, "Typed online.");
    await lacks(bobs, "Typed offline.");
    await alice.context().setOffline(false);
    await browserExpect(alice.getByText("Synced", { exact: true })).toBeVisible({ timeout: 60_000 });
    await shows(alice, "Typed online.");
    await shows(bobs, "Typed offline.");
  }, 180_000);

  it("loses nothing when a server goes away, and reconnects when one is back", async () => {
    const temporary = await startServer(postgres.getConnectionString(), env);
    let replica = await serve(temporary);
    const port = new URL(replica.origin).port;
    const alice = await open(replica, admin);
    await ready(alice);
    await typeAtEnd(alice, "First paragraph.", " Before it went.");
    await browserExpect(alice.getByText("Synced", { exact: true })).toBeVisible();
    await temporary.runtime.live.stop();
    replica.http.closeAllConnections();
    await new Promise(done => { replica.http.close(done); });
    await temporary.close();
    await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved?.contributors, { timeout: 15_000 }).toHaveLength(1);
    await browserExpect(alice.getByText(/Not connected/u)).toBeVisible({ timeout: 20_000 });
    await typeAtEnd(alice, "Third paragraph.", " While it was gone.");
    const again = await startServer(postgres.getConnectionString(), env);
    replica = await serve(again, Number(port));
    try {
      await browserExpect(alice.getByText("Synced", { exact: true })).toBeVisible({ timeout: 40_000 });
      const bobs = await open(other, bob);
      await shows(bobs, "Before it went.");
      await shows(bobs, "While it was gone.");
    } finally {
      await Promise.all(contexts.splice(0).map(context => context.close()));
      await again.runtime.live.stop();
      replica.http.closeAllConnections();
      await new Promise(done => { replica.http.close(done); });
      await again.close();
    }
  }, 180_000);

  it("shares the page title while it is being changed", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await alice.getByLabel("Title").fill("A better title");
    await browserExpect(bobs.getByLabel("Title")).toHaveValue("A better title", { timeout: 10_000 });
    await browserExpect(bobs.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 5000 });
    await bobs.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(bobs.getByRole("heading", { level: 1, name: "A better title" })).toBeVisible({ timeout: 15_000 });
  }, 120_000);

  it("merges what happened meanwhile when someone comes back from the Markdown source", async () => {
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await alice.getByRole("button", { name: "Markdown source" }).click();
    const source = alice.getByRole("textbox", { name: "Markdown source" });
    await browserExpect(source).toBeVisible();
    await source.fill((await source.inputValue()).replace("First paragraph.", "First paragraph, in source."));
    await typeAtEnd(bobs, "Third paragraph.", " Typed meanwhile.");
    await shows(bobs, "Typed meanwhile.");
    await alice.getByRole("button", { name: "Markdown source" }).click();
    await shows(alice, "First paragraph, in source.");
    await shows(alice, "Typed meanwhile.");
    await shows(bobs, "First paragraph, in source.");
    await shows(bobs, "Typed meanwhile.");
  }, 120_000);

  it("sends someone away once they can no longer edit, keeping nothing more from them", async () => {
    const { client, user } = await person("Carol", "editor");
    const carol = await open(other, client);
    await ready(carol);
    await typeAtEnd(carol, "First paragraph.", " Allowed.");
    await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved?.contributors, { timeout: 15_000 }).toEqual(["Carol"]);
    await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${user.id}`, role: "viewer" });
    await new Promise(done => { setTimeout(done, 1200); });
    await typeAtEnd(carol, "Third paragraph.", " Refused.");
    await browserExpect(carol.getByText("You can no longer edit this page")).toBeVisible({ timeout: 15_000 });
    await browserExpect(carol.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    await new Promise(done => { setTimeout(done, 2500); });
    const alice = await open(one, admin);
    await shows(alice, "Allowed.");
    await lacks(alice, "Refused.");
    // On her way out, telling the server she has stopped editing was refused too, which is as it should be.
    problems = problems.filter(problem => !problem.includes("403"));
  }, 120_000);

  it("keeps who is here, the state of things and the save button in view on a long page", async () => {
    await saveThroughApi(`${BASE}\n${Array.from({ length: 60 }, (_, at) => `Paragraph number ${at}.`).join("\n\n")}\n`);
    const alice = await open(one, admin);
    await ready(alice);
    await alice.evaluate(() => window.scrollTo(0, 2000));
    await browserExpect.poll(() => alice.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
    const bar = await alice.locator(".pd-editor__bar").boundingBox();
    expect(bar?.y).toBeGreaterThanOrEqual(0);
    expect(bar?.y).toBeLessThan(100);
    await browserExpect(alice.getByRole("button", { name: "Save", exact: true })).toBeInViewport();
  }, 120_000);

  it("works alone if the connection cannot get through, and merges on saving", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    contexts.push(context);
    await context.addCookies([...admin.cookies].map(([name, value]) => ({ name, value, url: one.origin })));
    const page = await context.newPage();
    await page.routeWebSocket(/\/api\/v1\/live/u, socket => socket.close());
    await page.goto(`${one.origin}/shop/${slug}?mode=edit`);
    await browserExpect(page.getByText(/Could not connect for editing together/u)).toBeVisible({ timeout: 30_000 });
    await browserExpect(page.locator(".ProseMirror")).toContainText("First paragraph.", { timeout: 10_000 });
    await saveThroughApi(BASE.replace("Third paragraph.", "Third paragraph, from elsewhere."));
    await typeAtEnd(page, "First paragraph.", " Alone.");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(page.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    expect((await published()).markdown).toBe("# Guide\n\nFirst paragraph. Alone.\n\nSecond paragraph.\n\nThird paragraph, from elsewhere.\n");
  }, 120_000);

  it("edits every kind of block together, and saves them as they should be written", async () => {
    const markdown = ["# Guide", "First paragraph.", "```ts\nconst a = 1;\n```", "::::tabs\n\n:::tab[One]\n\nIn a tab.\n\n:::\n\n::::", "| A | B |\n| --- | --- |\n| 1 | 2 |", "- an item\n- another", "A note[^1].", "[^1]: The note.", ""].join("\n\n");
    await saveThroughApi(markdown);
    const alice = await open(one, admin);
    const bobs = await open(other, bob);
    await ready(alice);
    await ready(bobs);
    await alice.locator(".ProseMirror pre code").click();
    await alice.keyboard.press("End");
    await alice.keyboard.type(" // typed");
    await shows(bobs, "const a = 1; // typed");
    await alice.locator(".ProseMirror td", { hasText: "2" }).click();
    await alice.keyboard.press("End");
    await alice.keyboard.type("0");
    await browserExpect(bobs.locator(".ProseMirror td", { hasText: "20" })).toBeVisible({ timeout: 10_000 });
    await bobs.getByRole("button", { name: "Add a tab" }).click();
    await browserExpect(alice.getByRole("textbox", { name: "Tab name" })).toHaveCount(2, { timeout: 10_000 });
    await bobs.getByLabel("Footnote 1").fill("The changed note.");
    await browserExpect(alice.getByLabel("Footnote 1")).toHaveValue("The changed note.", { timeout: 10_000 });
    await alice.locator(".ProseMirror li", { hasText: "another" }).click();
    // The browser says the caret has moved a moment after the click. Nobody presses a key that soon.
    await alice.waitForTimeout(200);
    await alice.keyboard.press("End");
    await alice.keyboard.press("Enter");
    await alice.keyboard.type("third");
    await browserExpect(bobs.locator(".ProseMirror li", { hasText: "third" })).toBeVisible({ timeout: 10_000 });
    await browserExpect(bobs.getByRole("button", { name: "Save", exact: true })).toBeEnabled({ timeout: 5000 });
    await new Promise(done => { setTimeout(done, 500); });
    await bobs.getByRole("button", { name: "Save", exact: true }).click();
    await browserExpect(bobs.locator(".ProseMirror")).toHaveCount(0, { timeout: 10_000 });
    const saved = (await published()).markdown;
    expect(saved).toContain("const a = 1; // typed");
    expect(saved).toMatch(/\|\s*1\s*\|\s*20\s*\|/u);
    expect(saved).toContain(":::tab[New tab]");
    expect(saved).toContain("[^1]: The changed note.");
    expect(saved).toContain("- third");
    expect(saved).toContain("First paragraph.");
  }, 180_000);
});
