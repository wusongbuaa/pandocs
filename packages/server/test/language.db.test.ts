import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { addMessages, inLanguage } from "@pandocs/i18n";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { extractToMarkdown } from "../src/extract/convert.js";
import { createExtractProcessor, extractInWorker } from "../src/extract/processor.js";
import { zh } from "../src/i18n/zh.js";
import { createMailNotifier } from "../src/mail.js";
import { blankPdf } from "./office-files.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const IN_CHINESE = { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" };

describe("the language of an answer", () => {
  let server: TestServer;
  let admin: Client;

  beforeAll(async () => {
    server = await startServer(
      postgres.getConnectionString(),
      {},
      { processors: [createExtractProcessor(extractToMarkdown)] }
    );
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
  });
  afterAll(() => server.close());

  it("is English unless a request asks for something else", async () => {
    expect((await admin.json("GET", "/api/v1/spaces/nowhere")).error.message).toBe(
      "Space not found, or you have no access to it"
    );
    expect((await admin.json("GET", "/api/v1/spaces/nowhere", undefined, IN_CHINESE)).error.message).toBe(
      "空间不存在或没有访问权限"
    );
    expect(
      (await admin.json("GET", "/api/v1/spaces/nowhere", undefined, { "accept-language": "fr" })).error.message
    ).toBe("Space not found, or you have no access to it");
  });

  it("does not carry over from one request to the next", async () => {
    const asked = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        admin.json("GET", "/api/v1/spaces/nowhere", undefined, index % 2 ? IN_CHINESE : {})
      )
    );
    asked.forEach((answer, index) =>
      expect(answer.error.message).toBe(
        index % 2 ? "空间不存在或没有访问权限" : "Space not found, or you have no access to it"
      )
    );
  });

  it("covers what was asked for through a message built from parts", async () => {
    const { error } = await admin.json(
      "POST",
      "/api/v1/spaces",
      { slug: "shop", name: "Again", defaultRole: "viewer" },
      IN_CHINESE
    );
    expect(error.message).toBe("空间 shop 已存在");
  });

  it("says what is wrong with each field in that language too", async () => {
    const wrong = { title: "", defaultLang: "fr", trashRetentionDays: 0, bogus: 1 };
    const english = await admin.json("PATCH", "/api/v1/site", wrong);
    expect(english.status).toBe(422);
    expect(english.error.details).toEqual([
      { path: ["title"], message: "Required" },
      { path: ["defaultLang"], message: "Must be one of: zh, en, ja, ko, ru, ta" },
      { path: ["trashRetentionDays"], message: "At least 1" },
      { path: [], message: "Unknown field: bogus" }
    ]);
    const chinese = await admin.json("PATCH", "/api/v1/site", wrong, IN_CHINESE);
    expect(chinese.error.details.map(({ message }: { message: string }) => message)).toEqual([
      "必填",
      "只能是以下之一：zh、en、ja、ko、ru、ta",
      "不能小于 1",
      "不支持的字段：bogus"
    ]);
  });

  it("covers the login page", async () => {
    const visitor = server.client();
    const english = await (await visitor.request("/login")).text();
    expect(english).toContain('<html lang="en">');
    expect(english).toContain("Sign in");
    const chinese = await (await visitor.request("/login", { headers: IN_CHINESE })).text();
    expect(chinese).toContain('<html lang="zh">');
    expect(chinese).toContain("登录");
    expect(chinese).not.toContain("Sign in");
  });

  it("reports problems with a page to each reader in their own language, even though the analysis is kept", async () => {
    const { data } = await admin.json("POST", "/api/v1/spaces/shop/documents", {
      title: "Odd",
      slug: "odd",
      markdown: ':::no-such-block\n\nx\n\n:::\n\n:::note{tone="loud"}\n\ny\n\n:::\n'
    });
    const id = data.document.id as string;
    const said = async (headers?: Record<string, string>) =>
      (
        (await admin.json("GET", `/api/v1/documents/${id}`, undefined, headers)).data.diagnostics as {
          message: string;
        }[]
      ).map(({ message }) => message);
    expect(await said()).toEqual([
      expect.stringContaining("Unknown block"),
      expect.stringContaining("Must be one of: note, tip")
    ]);
    expect(await said(IN_CHINESE)).toEqual([
      expect.stringContaining("不认识的块"),
      expect.stringContaining("只能是以下之一：note、tip")
    ]);
    expect(await said()).toEqual([
      expect.stringContaining("Unknown block"),
      expect.stringContaining("Must be one of: note, tip")
    ]);
  });

  it("reports a background job's results in the language of whoever started it", async () => {
    const form = new FormData();
    form.set("file", new File([blankPdf() as BlobPart], "scan.pdf", { type: "application/octet-stream" }));
    form.set("target", "{}");
    const started = await admin.request("/api/v1/spaces/shop/imports", {
      method: "POST",
      body: form,
      headers: IN_CHINESE
    });
    const { data: job } = (await started.json()) as { data: { id: string } };
    // Nothing about this tick is in that person's request.
    let done = null;
    for (let attempt = 0; attempt < 200 && !done; attempt += 1) {
      await server.runtime.services.ingest.tick();
      const read = (await admin.json("GET", `/api/v1/imports/${job.id}`)).data;
      if (read.status !== "queued" && read.status !== "running") done = read;
      else await new Promise(wake => setTimeout(wake, 20));
    }
    expect(done?.status).toBe("succeeded");
    expect(done.report.warnings[0]).toContain("扫描件");
  });
});

describe("a conversion on its own thread", () => {
  it("reports in the language of whoever it is for", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pandocs-worker-"));
    const outfile = join(dir, "extract-worker.mjs");
    try {
      await build({
        entryPoints: [join(import.meta.dirname, "../src/extract/worker.ts")],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        banner: {
          js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
        },
        logLevel: "silent"
      });
      const extract = extractInWorker(pathToFileURL(outfile));
      const file = { bytes: blankPdf(), contentType: "application/pdf", filename: "scan.pdf" };
      expect((await extract(file)).warnings[0]).toContain("almost no text");
      expect((await inLanguage("zh", () => extract(file))).warnings[0]).toContain("扫描件");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("mail", () => {
  it("goes out in the language of the request that caused it", async () => {
    addMessages("zh", zh);
    const sent: { subject?: string; text?: string; html?: string }[] = [];
    const notifier = createMailNotifier({
      smtp: { host: "smtp.test", port: 25, secure: false, from: "docs@example.test" } as never,
      publicUrl: new URL("https://docs.example.test"),
      users: { findById: async () => ({ email: "ana@example.test", status: "active" }) } as never,
      send: async message => sent.push(message as never)
    });
    const event = {
      kind: "mention",
      recipientId: "u",
      actorName: "Ben",
      documentTitle: "Guide",
      summary: "Look",
      location: "shop/guide"
    } as never;
    await notifier.notify(event);
    await inLanguage("zh", () => notifier.notify(event));
    expect(sent[0]!.subject).toBe('Ben mentioned you in "Guide"');
    expect(sent[0]!.html).toContain("Open the document");
    expect(sent[1]!.subject).toBe("Ben 在《Guide》里提到了你");
    expect(sent[1]!.text).toBe("Look\n\n打开文档：https://docs.example.test/shop/guide");
  });

  it("says what happened, and lists every page one message covers", async () => {
    const sent: { subject?: string; text?: string; html?: string }[] = [];
    const notifier = createMailNotifier({
      smtp: { host: "smtp.test", port: 25, secure: false, from: "docs@example.test" } as never,
      publicUrl: new URL("https://docs.example.test"),
      users: { findById: async () => ({ email: "ana@example.test", status: "active" }) } as never,
      send: async message => sent.push(message as never)
    });
    const event = {
      recipientId: "u",
      actorName: "Ben",
      documentId: "d",
      documentTitle: "<Guide>",
      summary: "",
      location: "shop/guide"
    };
    await notifier.notify({ ...event, kind: "reply" });
    await notifier.notify({ ...event, kind: "proposal_decided" });
    await notifier.notify({ ...event, kind: "page_updated" });
    await notifier.notify({
      ...event,
      kind: "page_updated",
      alsoUpdated: [{ documentTitle: "<b>Other</b>", location: "shop/other" }]
    });
    expect(sent.map(message => message.subject)).toEqual([
      'Ben replied in "<Guide>"',
      'Ben decided on a suggestion for "<Guide>"',
      'Ben updated "<Guide>"',
      '"<Guide>" and 1 more pages were updated'
    ]);
    expect(sent[3]!.text).toContain("<b>Other</b>: https://docs.example.test/shop/other");
    expect(sent[3]!.html).toContain('<a href="https://docs.example.test/shop/other">&#60;b&#62;Other&#60;/b&#62;</a>');
    expect(sent[3]!.html).not.toContain("<b>Other");
  });
});
