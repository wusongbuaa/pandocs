import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { createPublisher } from "../src/app.js";
import { extractToMarkdown } from "../src/extract/convert.js";
import { createExtractProcessor, extractInWorker } from "../src/extract/processor.js";
import { blankPdf, docx, pdf } from "./office-files.js";
import { signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const postgres = usePostgresFixture();
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("importing files that are not Markdown", () => {
  let server: TestServer;
  let admin: Client;

  const upload = async (person: Client, bytes: Uint8Array, filename: string, target: object = {}) => {
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], filename, { type: "application/octet-stream" }));
    form.set("target", JSON.stringify(target));
    const response = await person.request("/api/v1/spaces/shop/imports", { method: "POST", body: form });
    const payload = await response.json() as { data: { id: string; status: string }; error?: { code: string } };
    expect(response.status, JSON.stringify(payload)).toBe(201);
    return payload.data;
  };
  /** Moves the background work along, rather than waiting for the worker's next look. */
  const finished = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await server.runtime.services.ingest.tick();
      const job = (await admin.json("GET", `/api/v1/imports/${id}`)).data;
      if (job.status !== "queued" && job.status !== "running") return job;
      await new Promise(done => setTimeout(done, 20));
    }
    throw new Error("the import never finished");
  };
  const publish = async (id: string, slug: string) => (await admin.json("POST", `/api/v1/imports/${id}/publish`, { slug })).data;

  beforeAll(async () => {
    server = await startServer(postgres.getConnectionString(), {}, { processors: [createExtractProcessor(extractToMarkdown)] });
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "书店", defaultRole: "viewer" });
  });
  afterAll(() => server.close());

  it("makes a draft from a Word file, with the file itself at the top and its images stored", async () => {
    const job = await upload(admin, docx(), "退货流程.docx");
    const done = await finished(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.draftTitle).toBe("退货流程");
    const lines = (done.draftMarkdown as string).split("\n");
    expect(lines[0]).toMatch(/^::file\[退货流程\.docx\]\{src="assets\/[a-f0-9]{64}\.docx"\}$/u);
    expect(done.draftMarkdown).toContain("七天内可以**无理由**退货");
    expect(done.report.diagnostics).toEqual([]);

    const image = /assets\/([a-f0-9]{64})\.png/u.exec(done.draftMarkdown as string)![1]!;
    const stored = await admin.request(`/api/v1/spaces/shop/assets/${image}`);
    expect(stored.status).toBe(200);
    expect(stored.headers.get("content-type")).toBe("image/png");
  });

  it("becomes a page like any other once published: searchable, discussable, with the original a click away", async () => {
    const job = await upload(admin, docx(), "规章.docx");
    await finished(job.id);
    const page = await publish(job.id, "rules");
    const id = page.documentId as string;
    const read = (await admin.json("GET", `/api/v1/documents/${id}`)).data;
    expect(read.diagnostics).toEqual([]);
    expect(read.revision.ingestJobId).toBe(job.id);
    expect((await admin.json("GET", "/api/v1/search?q=无理由")).data.map((hit: { id: string }) => hit.id)).toContain(id);
    const thread = await admin.json("POST", `/api/v1/documents/${id}/threads`, { anchor: { kind: "quote", quote: "无理由" }, body: "确认一下" });
    expect(thread.status).toBe(201);

    const hash = /assets\/([a-f0-9]{64})\.docx/u.exec(read.markdown as string)![1]!;
    const original = await admin.request(`/api/v1/spaces/shop/assets/${hash}`);
    expect(original.status).toBe(200);
    // These are the same bytes as an earlier import, so they keep the name they first came with.
    expect(original.headers.get("content-disposition")).toBe(`attachment; filename*=UTF-8''${encodeURIComponent("退货流程.docx")}`);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(docx());
  });

  it("puts the original and its images in a copy on disk too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pandocs-extract-"));
    try {
      const manifest = (await admin.json("GET", "/api/v1/spaces/shop/manifest")).data;
      const original = manifest.files.find((file: { path: string }) => file.path.endsWith(".docx"));
      expect(original).toMatchObject({ kind: "asset" });
      await createPublisher({ services: server.runtime.services, dir, spaces: ["shop"], log: () => undefined }).publish("shop");
      expect(new Uint8Array(readFileSync(join(dir, "shop", original.path)))).toEqual(docx());
      expect(readFileSync(join(dir, "shop", "rules.md"), "utf8")).toContain("无理由");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces a page's text when a new version of the file comes, and history keeps the old one", async () => {
    const created = (await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "季报", slug: "report", markdown: "旧内容\n" })).data.document;
    const job = await upload(admin, pdf("New quarterly figures"), "季报.pdf", { documentId: created.id });
    const done = await finished(job.id);
    expect(done.status).toBe("succeeded");
    const published = await admin.json("POST", `/api/v1/imports/${job.id}/publish`, {});
    expect(published.status).toBe(200);
    const read = (await admin.json("GET", `/api/v1/documents/${created.id}`)).data;
    expect(read.markdown).toContain("New quarterly figures");
    expect(read.markdown).toContain("::file[季报.pdf]");
    expect(read.revision.no).toBe(2);
  });

  it("keeps a scanned PDF as a page with just the file, and says what is missing", async () => {
    const job = await upload(admin, blankPdf(), "扫描件.pdf");
    const done = await finished(job.id);
    expect(done.status).toBe("succeeded");
    expect((done.draftMarkdown as string).trim()).toMatch(/^::file\[扫描件\.pdf\]/u);
    expect(done.report.warnings[0]).toContain("almost no text");
  });

  it("says why when a file cannot be converted, and does not try again", async () => {
    const job = await upload(admin, new TextEncoder().encode("not really"), "旧格式.doc");
    const done = await finished(job.id);
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBe("OLD_OFFICE_FORMAT");
    expect(done.errorMessage).toContain("Save it as");
  });

  it("escapes a file name that would break the block", async () => {
    const job = await upload(admin, pdf("Some text in here"), "一份[带括号]的.pdf");
    const done = await finished(job.id);
    expect((done.draftMarkdown as string).split("\n")[0]).toMatch(/^::file\[一份 带括号 的\.pdf\]/u);
    expect(done.report.diagnostics).toEqual([]);
  });

  it("gives someone who cannot publish a draft for someone who can, as with any import", async () => {
    await admin.json("POST", "/api/v1/admin/users", { email: "writer@example.test", displayName: "投稿人", password: "writer-password-1" });
    const writer = server.client();
    await writer.form("/login", { email: "writer@example.test", password: "writer-password-1", next: "/" });
    const { id } = (await writer.json("GET", "/api/v1/account")).data;
    await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${id}`, role: "commenter" });
    const job = await upload(writer, docx(), "投稿.docx");
    const done = await finished(job.id);
    expect(done.status).toBe("succeeded");
    expect(done.documentId).toBeNull();
    expect((await writer.json("POST", `/api/v1/imports/${job.id}/publish`, { slug: "submitted" })).status).toBe(403);
  });
});

describe("converting on a thread of its own", () => {
  const workerFile = (code: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pandocs-worker-"));
    const file = join(dir, "worker.mjs");
    return { file, dir, code };
  };

  it("stops a file that takes too long", async () => {
    const { writeFileSync } = await import("node:fs");
    const { dir, file } = workerFile("");
    writeFileSync(file, "setInterval(() => {}, 1000);");
    try {
      const failure = await extractInWorker(new URL(`file://${file}`), { timeoutMs: 100 })({ bytes: new Uint8Array(1), contentType: "a", filename: "a" }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "EXTRACT_TIMEOUT" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports what the thread said, final or not", async () => {
    const { writeFileSync } = await import("node:fs");
    const { dir, file } = workerFile("");
    const run = (code: string) => {
      writeFileSync(file, `import { parentPort } from "node:worker_threads"; ${code}`);
      return extractInWorker(new URL(`file://${file}`))({ bytes: new Uint8Array(1), contentType: "a", filename: "a" });
    };
    try {
      await expect(run(`parentPort.postMessage({ output: { markdown: "好", warnings: [], files: [] } });`)).resolves.toEqual({ markdown: "好", warnings: [], files: [] });
      await expect(run(`parentPort.postMessage({ failure: { permanent: true, code: "NOPE", message: "不行" } });`)).rejects.toMatchObject({ code: "NOPE", message: "不行" });
      const retryable = await run(`parentPort.postMessage({ failure: { permanent: false, code: "X", message: "可以再试" } });`).catch((error: unknown) => error) as Error & { code?: string };
      expect(retryable.message).toBe("可以再试");
      expect(retryable.code).toBeUndefined();
      await expect(run(`throw new Error("崩了");`)).rejects.toThrow("崩了");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(vi.isMockFunction(extractInWorker)).toBe(false);
  });
});
