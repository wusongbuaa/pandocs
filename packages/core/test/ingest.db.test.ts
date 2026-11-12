import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { PermanentIngestError, sweepIdempotencyKeys, type Processor } from "@pandocs/core";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const PDF = new TextEncoder().encode("%PDF-1.7 fake content");

describe("assets and ingest", () => {
  let h: ReturnType<typeof createHarness>;
  let flaky = 0;

  let slowDone: (() => void) | null = null;
  const extract: Processor = {
    name: "extract",
    async run(input) {
      if (input.filename.includes("broken")) throw new PermanentIngestError("DOCUMENT_ENCRYPTED", "文件受密码保护");
      if (input.filename.includes("slow")) await new Promise<void>(done => (slowDone = done));
      if (input.filename.includes("flaky") && (flaky += 1) < 2) throw new Error("转换服务繁忙");
      return {
        markdown: `# 提取结果\n\n来自 ${input.filename}，类型 ${input.contentType}\n`,
        detail: "现有提取器",
        warnings: ["表格可能有损"]
      };
    }
  };
  const better: Processor = {
    name: "better-extract",
    run: async input => ({ markdown: `# 更好的结果\n\n${input.filename}\n` })
  };

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString(), { processors: [extract, better] });
    await h.call(USERS.admin, "POST", "spaces", { slug: "handbook", name: "手册", defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "PUT", "spaces/handbook/members", {
      subject: `user:${USERS.commenter.id}`,
      role: "commenter"
    });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  // Submitting nudges the worker in the background, so wait for the job rather than assume who runs it.
  const settle = async (id: string, harness = h) => {
    for (let i = 0; i < 200; i += 1) {
      const job = (await harness.call(USERS.editor, "GET", `imports/${id}`)).data;
      if (job.status !== "queued" && job.status !== "running") return job;
      await harness.services.ingest.tick();
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("导入任务没有结束");
  };
  const upload = (
    principal: (typeof USERS)[keyof typeof USERS],
    bytes: Uint8Array,
    filename: string,
    target: object = {}
  ) => {
    const form = new FormData();
    form.set("file", new File([bytes as BlobPart], filename));
    form.set("target", JSON.stringify(target));
    return h.call(principal, "POST", "spaces/handbook/imports", form);
  };

  describe("assets", () => {
    it("stores by content and serves only to people with access", async () => {
      const first = await h.call(USERS.editor, "POST", "spaces/handbook/assets?filename=a.png", PNG);
      expect(first.status).toBe(201);
      expect(first.data.path).toMatch(/^assets\/[a-f0-9]{64}\.png$/u);
      const second = await h.call(USERS.editor, "POST", "spaces/handbook/assets?filename=other-name.png", PNG);
      expect(second.data.sha256).toBe(first.data.sha256);

      const read = await h.call(USERS.reader, "GET", `spaces/handbook/${first.data.path}`);
      expect(read.response.headers.get("content-type")).toBe("image/png");
      expect(read.response.headers.get("cache-control")).toContain("private");
      expect(new Uint8Array(await read.response.arrayBuffer())).toEqual(PNG);

      await h.call(USERS.admin, "POST", "spaces", { slug: "secret", name: "内部", defaultRole: "none" });
      expect((await h.call(USERS.reader, "GET", `spaces/secret/${first.data.path}`)).status).toBe(404);
      expect((await h.call(USERS.reader, "POST", "spaces/handbook/assets?filename=x.png", PNG)).status).toBe(403);
    });

    it("never serves untrusted formats inline", async () => {
      const { data } = await h.call(USERS.editor, "POST", "spaces/handbook/assets?filename=evil.png", SVG);
      expect(data.mime).toBe("application/octet-stream");
      const read = await h.call(USERS.reader, "GET", `spaces/handbook/assets/${data.sha256}`);
      expect(read.response.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''evil.png");
      expect(read.response.headers.get("x-content-type-options")).toBe("nosniff");
    });
  });

  describe("routing by channel and content type", () => {
    it("publishes Markdown from an editor over the API", async () => {
      const viaApi = { ...USERS.editor, channel: "api" as const };
      const { status, data } = await h.call(viaApi, "POST", "spaces/handbook/imports", {
        markdown: "﻿# 接口导入\r\n\r\n内容  \r\n",
        target: { title: "接口导入" }
      });
      expect(status).toBe(201);
      expect(data).toMatchObject({ status: "succeeded", route: "markdown-programmatic", persist: "publish" });
      expect(data.sourceText).toBeUndefined();
      const text = await (await h.call(USERS.reader, "GET", `documents/${data.documentId}/content`)).response.text();
      expect(text).toBe("# 接口导入\n\n内容\n");
      expect((await h.call(USERS.reader, "GET", `documents/${data.documentId}/revisions`)).data[0]).toMatchObject({
        channel: "api",
        ingestJobId: data.id
      });
    });

    it("turns content from someone without edit rights into a proposal or a draft", async () => {
      const viaCli = { ...USERS.commenter, channel: "cli" as const };
      const draft = await h.call(viaCli, "POST", "spaces/handbook/imports", { markdown: "# 草稿\n\n内容\n" });
      expect(draft.data).toMatchObject({ status: "succeeded", persist: "draft", documentId: null, draftTitle: "草稿" });

      const documentId = (
        await h.call(USERS.editor, "POST", "spaces/handbook/documents", { title: "已有文档", markdown: "旧内容\n" })
      ).data.document.id as string;
      const proposal = await h.call(viaCli, "POST", "spaces/handbook/imports", {
        markdown: "新内容\n",
        target: { documentId }
      });
      expect(proposal.data).toMatchObject({ status: "succeeded", persist: "proposal", documentId });
      const view = await h.call(USERS.reader, "GET", `proposals/${proposal.data.proposalId}`);
      expect(view.data.proposedMarkdown).toBe("新内容\n");
      expect((await h.call(USERS.reader, "GET", `documents/${documentId}`)).data.revision.no).toBe(1);
    });

    it("keeps web uploads as drafts until someone publishes them", async () => {
      const { data } = await upload(USERS.editor, new TextEncoder().encode("# 上传\n\n正文\n"), "上传.md");
      expect(data).toMatchObject({
        route: "markdown-upload",
        persist: "draft",
        status: "succeeded",
        draftTitle: "上传"
      });
      const published = await h.call(USERS.editor, "POST", `imports/${data.id}/publish`, {
        title: "上传的文档",
        slug: "uploaded"
      });
      expect(published.data.documentId).toBeTruthy();
      expect((await h.call(USERS.reader, "GET", `documents/${published.data.documentId}`)).data.document.path).toBe(
        "uploaded"
      );
      expect((await h.call(USERS.editor, "POST", `imports/${data.id}/publish`, {})).error.code).toBe(
        "INGEST_NOT_PUBLISHABLE"
      );
      expect((await h.call(USERS.editor, "POST", `imports/${data.id}/discard`)).error.code).toBe(
        "INGEST_ALREADY_PUBLISHED"
      );
    });

    it("keeps what comes in for a space that reviews every change a draft, which only a change set can land", async () => {
      await h.call(USERS.admin, "POST", "spaces", { slug: "reviewed", name: "审阅", defaultRole: "viewer" });
      await h.call(USERS.admin, "PUT", "spaces/reviewed/members", {
        subject: `user:${USERS.editor.id}`,
        role: "editor"
      });
      const documentId = (
        await h.call(USERS.admin, "POST", "spaces/reviewed/documents", { title: "规程", markdown: "旧规程\n" })
      ).data.document.id as string;
      await h.call(USERS.admin, "PATCH", "spaces/reviewed", {
        mergeRules: { requiredApprovals: 1, requireChangeSets: true }
      });
      const viaApi = { ...USERS.editor, channel: "api" as const };
      const onto = await h.call(viaApi, "POST", "spaces/reviewed/imports", {
        markdown: "新规程\n",
        target: { documentId }
      });
      expect(onto.data).toMatchObject({ status: "succeeded", persist: "draft", revisionNo: null });
      expect((await h.call(USERS.reader, "GET", `documents/${documentId}`)).data.revision.no).toBe(1);
      expect((await h.call(USERS.editor, "POST", `imports/${onto.data.id}/publish`, {})).error?.code).toBe(
        "CHANGE_SET_REQUIRED"
      );
      expect((await h.call(USERS.admin, "POST", `imports/${onto.data.id}/publish`, {})).error?.code).toBe(
        "CHANGE_SET_REQUIRED"
      );
      expect((await h.call(USERS.reader, "GET", `documents/${documentId}`)).data.markdown).toBe("旧规程\n");
      const fresh = await h.call(viaApi, "POST", "spaces/reviewed/imports", { markdown: "# 新页\n\n内容\n" });
      expect(fresh.data).toMatchObject({ status: "succeeded", persist: "draft", documentId: null });
    });

    it("lets a commenter's draft wait for someone who can publish", async () => {
      const { data } = await upload(USERS.commenter, new TextEncoder().encode("正文\n"), "想法.md");
      expect((await h.call(USERS.commenter, "POST", `imports/${data.id}/publish`, {})).status).toBe(403);
      expect((await h.call(USERS.reader, "GET", `imports/${data.id}`)).status).toBe(404);
      expect(
        (await h.call(USERS.editor, "POST", `imports/${data.id}/publish`, { title: "采纳", markdown: "改过的正文\n" }))
          .status
      ).toBe(200);
    });

    it("sends documents through the extract route in the background", async () => {
      const { data } = await upload(USERS.editor, PDF, "方案.pdf");
      expect(data).toMatchObject({ route: "document-extract", status: "queued", contentType: "application/pdf" });
      const job = await settle(data.id);
      expect(job).toMatchObject({ status: "succeeded", draftTitle: "提取结果" });
      expect(job.draftMarkdown).toContain("来自 方案.pdf");
      expect(job.report.processors.map((step: { name: string }) => step.name)).toEqual(["extract", "normalize"]);
      expect(job.report.warnings).toEqual(["表格可能有损"]);
      // What it found, and the file itself at the top.
      expect(job.report.stats.blocks).toBe(3);
      expect(job.draftMarkdown.split("\n")[0]).toMatch(/^::file\[方案\.pdf\]\{src="assets\/[a-f0-9]{64}\.pdf"\}$/u);
      expect(
        (await h.call(USERS.editor, "GET", "spaces/handbook/imports")).data.some(
          (item: { id: string }) => item.id === data.id
        )
      ).toBe(true);
    });

    it("trusts the bytes over the file name", async () => {
      const { data } = await upload(USERS.editor, PDF, "伪装.md");
      expect(data).toMatchObject({ contentType: "application/pdf", route: "document-extract" });
      await settle(data.id);
      const zip = await upload(USERS.editor, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), "压缩包.zip");
      expect(zip.error.code).toBe("CONTENT_TYPE_UNSUPPORTED");
      expect((await upload(USERS.editor, new Uint8Array([0, 1, 2, 3, 4, 0, 9]), "未知")).error.code).toBe(
        "CONTENT_TYPE_UNSUPPORTED"
      );
    });

    it("retries transient failures and stops on permanent ones", async () => {
      const flakyJob = (await upload(USERS.editor, PDF, "flaky.pdf")).data;
      let job = await settle(flakyJob.id);
      expect(job).toMatchObject({ status: "retry_wait", errorCode: "PROCESSOR_FAILED", attempts: 1 });
      await h.pool.query(`UPDATE pandocs.ingest_jobs SET next_run_at = now() WHERE id = $1`, [flakyJob.id]);
      await h.services.ingest.tick();
      job = await settle(flakyJob.id);
      // Nothing is left of the try that failed.
      expect(job).toMatchObject({ status: "succeeded", errorCode: null, errorMessage: null });

      const broken = (await upload(USERS.editor, PDF, "broken.pdf")).data;
      job = await settle(broken.id);
      expect(job).toMatchObject({ status: "failed", errorCode: "DOCUMENT_ENCRYPTED", attempts: 1 });
    });

    it("keeps renewing the lease of a long conversion, so no other worker takes it for a crashed one", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        const slow = (await upload(USERS.editor, PDF, "slow.pdf")).data;
        for (let i = 0; i < 200 && !slowDone; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
        expect(slowDone).not.toBeNull();
        // As if most of the lease had gone by.
        await h.pool.query(`UPDATE pandocs.ingest_jobs SET lease_until = now() + interval '1 second' WHERE id = $1`, [
          slow.id
        ]);
        vi.advanceTimersByTime(100_000);
        const renewed = async () =>
          (
            await h.pool.query<{ left: number }>(
              `SELECT extract(epoch FROM lease_until - now())::int AS left FROM pandocs.ingest_jobs WHERE id = $1`,
              [slow.id]
            )
          ).rows[0]!.left;
        for (let i = 0; i < 200 && (await renewed()) < 200; i += 1)
          await new Promise(resolve => setTimeout(resolve, 10));
        expect(await renewed()).toBeGreaterThan(200);
        slowDone!();
        expect((await settle(slow.id)).status).toBe("succeeded");
        const { rows } = await h.pool.query(`SELECT attempts, lease_owner FROM pandocs.ingest_jobs WHERE id = $1`, [
          slow.id
        ]);
        expect(rows[0]).toEqual({ attempts: 1, lease_owner: null });
      } finally {
        slowDone = null;
        vi.useRealTimers();
      }
    });

    it("re-runs a job with another processor from the original file", async () => {
      const broken = (await upload(USERS.editor, PDF, "broken-again.pdf")).data;
      await settle(broken.id);
      expect((await h.call(USERS.commenter, "POST", `imports/${broken.id}/retry`, {})).status).toBe(404);
      await h.call(USERS.editor, "POST", `imports/${broken.id}/retry`, { processors: ["better-extract", "normalize"] });
      const job = await settle(broken.id);
      expect(job).toMatchObject({
        status: "succeeded",
        draftTitle: "更好的结果",
        processors: ["better-extract", "normalize"]
      });
    });

    it("fails clearly when a route needs a processor this deployment lacks", async () => {
      const bare = createHarness(fixture.getConnectionString());
      const form = new FormData();
      form.set("file", new File([PDF as BlobPart], "无处理器.pdf"));
      const { data } = await bare.call(USERS.editor, "POST", "spaces/handbook/imports", form);
      const job = await settle(data.id, bare);
      expect(job).toMatchObject({ status: "failed", errorCode: "PROCESSOR_UNAVAILABLE" });
      await bare.close();
    });
  });

  it("forgets idempotency keys after a week, not sooner", async () => {
    const insert = (key: string, age: string) =>
      h.pool.query(
        `INSERT INTO pandocs.idempotency_keys (principal_id, key, request_hash, status, response, created_at) VALUES ('p', $1, 'h', 200, '{}', now() - $2::interval)`,
        [key, age]
      );
    await insert("expired-key", "8 days");
    await insert("recent-key", "6 days");
    await sweepIdempotencyKeys(h.services);
    const { rows } = await h.pool.query(`SELECT key FROM pandocs.idempotency_keys WHERE principal_id = 'p'`);
    expect(rows.map(row => row.key)).toEqual(["recent-key"]);
  });
});
