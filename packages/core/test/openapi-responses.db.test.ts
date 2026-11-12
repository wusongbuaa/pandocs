import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { PermanentIngestError } from "@pandocs/core";
import { createLiveCodec } from "@pandocs/editor-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

interface Operation {
  readonly operationId?: string;
  readonly responses?: Record<string, { content?: Record<string, { schema?: object }> }>;
}

const spec = parse(readFileSync(join(import.meta.dirname, "../../../docs/api/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, object> };
};
const operations = new Map(
  Object.values(spec.paths).flatMap(item =>
    Object.values(item)
      .filter((value): value is Operation => typeof value === "object" && value !== null && "operationId" in value)
      .map(operation => [operation.operationId!, operation])
  )
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormats as unknown as (instance: Ajv2020) => void)(ajv);
ajv.addSchema({ $id: "spec", components: spec.components });

/** SDKs are generated from these schemas, so they have to describe what the server really sends. */
function check(operationId: string, status: number, data: unknown) {
  const schema = operations.get(operationId)?.responses?.[String(status)]?.content?.["application/json"]?.schema;
  expect(schema, `${operationId} ${status} has a schema`).toBeTruthy();
  const rewritten = JSON.parse(JSON.stringify(schema).replaceAll("#/components/", "spec#/components/")) as object;
  const validate = ajv.compile(rewritten);
  const valid = validate({ version: 1, data });
  expect(validate.errors ?? [], operationId).toEqual([]);
  expect(valid).toBe(true);
}

describe("what the API description promises", () => {
  let h: ReturnType<typeof createHarness>;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    const codec = createLiveCodec();
    h = createHarness(fixture.getConnectionString(), {
      liveCodec: {
        seed: async (markdown, meta) => codec.seed(markdown, meta),
        markdownOf: async (state, baseMarkdown) => codec.markdownOf(state, baseMarkdown),
        align: async (state, markdown, meta) => codec.align(state, markdown, meta),
        merge: async () => {
          throw new Error("nothing here merges");
        }
      },
      git: {
        head: async () => null,
        open: async () => ({
          head: null,
          author: null,
          files: new Map(),
          prefetch: async () => undefined,
          read: async () => new Uint8Array(),
          commit: async () => "0".repeat(40),
          dispose: async () => undefined
        })
      },
      importers: [
        {
          source: "test",
          input: "url",
          label: () => "Test",
          run: async (input, sink) => {
            if (input.url === "fail") throw new PermanentIngestError("NOPE", "It cannot be done");
            sink.expect(1);
            sink.note("A page", "Not all of it came over");
            await sink.page({ path: "from-elsewhere", title: "From elsewhere", markdown: "Text.\n" });
          }
        }
      ]
    });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  it("is what the server sends", async () => {
    const send = async (
      operationId: string,
      status: number,
      call: Promise<{ status: number; data: any; error?: any }>
    ) => {
      const result = await call;
      expect(result.error, operationId).toBeUndefined();
      expect(result.status, operationId).toBe(status);
      check(operationId, status, result.data);
      return result.data;
    };
    const admin = USERS.admin;
    check("getMe", 200, (await h.call(USERS.agent, "GET", "me")).data);
    await send(
      "createSpace",
      201,
      h.call(admin, "POST", "spaces", { slug: "books", name: "书", defaultRole: "viewer" })
    );
    await send("listSpaces", 200, h.call(admin, "GET", "spaces"));
    await send("getSpace", 200, h.call(admin, "GET", "spaces/books"));
    const asset = await send("uploadAsset", 201, h.call(admin, "POST", "spaces/books/assets?filename=a.png", PNG));
    const created = await send(
      "createDocument",
      201,
      h.call(admin, "POST", "spaces/books/documents", {
        title: "页面",
        slug: "page",
        markdown: `# 页面\n\n第一段。\n\n![图](${asset.path})\n\n:::warning 坏块{bad}\n`
      })
    );
    const id = created.document.id as string;
    await send("getSpaceTree", 200, h.call(admin, "GET", "spaces/books/tree"));
    await send("getDocument", 200, h.call(admin, "GET", `documents/${id}`));
    await send(
      "saveDocumentContent",
      200,
      h.write(admin, "PUT", `documents/${id}/content`, {
        markdown: "# 页面\n\n第一段，改过。\n\n第二段。\n",
        expectedRevision: 1
      })
    );
    await send(
      "applyDocumentOps",
      200,
      h.write(admin, "POST", `documents/${id}/ops`, {
        ops: [{ op: "str_replace", pattern: "第二段", content: "新的第二段" }],
        expectedRevision: 2
      })
    );
    await send(
      "rollbackDocument",
      200,
      h.write(admin, "POST", `documents/${id}/rollback`, { to: 2, expectedRevision: 3 })
    );
    await send("listRevisions", 200, h.call(admin, "GET", `documents/${id}/revisions`));
    await send("searchDocuments", 200, h.call(admin, "GET", "search?q=第一段"));

    const thread = await send(
      "createThread",
      201,
      h.call(USERS.agent === undefined ? admin : admin, "POST", `documents/${id}/threads`, {
        anchor: { kind: "quote", quote: "第一段" },
        body: "这里要确认"
      })
    );
    await send("replyThread", 201, h.call(admin, "POST", `threads/${thread.id}/comments`, { body: "确认了" }));
    await send("getThread", 200, h.call(admin, "GET", `threads/${thread.id}`));
    await send("listThreads", 200, h.call(admin, "GET", `documents/${id}/threads`));

    const proposal = await send(
      "createProposal",
      201,
      h.write(admin, "POST", `documents/${id}/proposals`, { baseRevision: 4, markdown: "# 页面\n\n提案里的第一段。\n" })
    );
    await send("listProposals", 200, h.call(admin, "GET", `documents/${id}/proposals`));
    await send("getProposal", 200, h.call(admin, "GET", `proposals/${proposal.id}`));

    await send("getSpaceManifest", 200, h.call(admin, "GET", "spaces/books/manifest"));
    await send("listChanges", 200, h.call(admin, "GET", "changes"));
    const [page] = (await h.call(admin, "GET", "spaces/books/tree")).data;
    const report = await send(
      "leaveFeedback",
      201,
      h.call(admin, "POST", `documents/${page.id as string}/feedback`, {
        kind: "report",
        body: "这里写错了",
        quote: "内容"
      })
    );
    await h.call(admin, "POST", "stats/views", { document: page.id });
    await h.call(admin, "POST", "stats/searches", { term: "词", results: 0 });
    await h.services.stats.recordQuestion({
      space: "books",
      question: "问",
      answer: "答 [1]",
      citations: [{ title: "页", url: "/books/x" }],
      answered: true
    });
    check("getSiteInsights", 200, (await h.call(admin, "GET", "insights")).data);
    check("getSpaceInsights", 200, (await h.call(admin, "GET", "spaces/books/insights?days=7")).data);
    const [feedback] = await send("listSpaceFeedback", 200, h.call(admin, "GET", "spaces/books/feedback"));
    expect(feedback.id).toBe(report.id);
    await send("listSiteFeedback", 200, h.call(admin, "GET", "feedback?status=all"));

    await send(
      "setDocumentLabels",
      200,
      h.call(admin, "PUT", `documents/${page.id as string}/labels`, { labels: ["指南"] })
    );
    await send("listSpaceLabels", 200, h.call(admin, "GET", "spaces/books/labels"));
    await send("getDocument", 200, h.call(admin, "GET", `documents/${page.id as string}`));
    await send("getSpaceTree", 200, h.call(admin, "GET", "spaces/books/tree"));
    await send("searchDocuments", 200, h.call(admin, "GET", "search?label=指南"));

    const template = await send(
      "createTemplate",
      201,
      h.call(admin, "POST", "spaces/books/templates", { name: "周报", markdown: "# {{title}}\n" })
    );
    await send("listTemplates", 200, h.call(admin, "GET", "spaces/books/templates"));
    await send(
      "updateTemplate",
      200,
      h.call(admin, "PATCH", `templates/${template.id as string}`, { description: "每周" })
    );
    await send(
      "createDocument",
      201,
      h.call(admin, "POST", "spaces/books/documents", { title: "第一周", slug: "week", template: template.id })
    );

    await send("followDocument", 200, h.call(admin, "PUT", `documents/${page.id as string}/subscription`));
    await send("getDocumentSubscription", 200, h.call(admin, "GET", `documents/${page.id as string}/subscription`));
    await send("followSpace", 200, h.call(admin, "PUT", "spaces/books/subscription"));
    await send("listMySubscriptions", 200, h.call(admin, "GET", "me/subscriptions"));
    await send("unfollowDocument", 200, h.call(admin, "DELETE", `documents/${page.id as string}/subscription`));
    await send("unfollowSpace", 200, h.call(admin, "DELETE", "spaces/books/subscription"));

    expect(
      (await send("openLiveDraft", 200, h.call(admin, "POST", `documents/${page.id as string}/live`))).available
    ).toBe(true);
    expect(
      (await send("getLiveDraft", 200, h.call(admin, "GET", `documents/${page.id as string}/live`))).unsaved
    ).toBeNull();
    await h.services.live.write(
      page.id as string,
      ((await h.services.live.open(admin, page.id as string)) as { name: string }).name,
      stored => stored,
      { touched: true, contributors: { [admin.id]: admin.displayName } }
    );
    expect(
      (await send("getLiveDraft", 200, h.call(admin, "GET", `documents/${page.id as string}/live`))).unsaved
        .contributors
    ).toHaveLength(1);
    await send("discardLiveDraft", 200, h.call(admin, "DELETE", `documents/${page.id as string}/live`));

    expect((await send("getGitSync", 200, h.call(admin, "GET", "spaces/books/git-sync"))).sync).toBeNull();
    await send(
      "setGitSync",
      200,
      h.call(admin, "PUT", "spaces/books/git-sync", { repository: "https://git.example.com/acme/docs.git", token: "t" })
    );
    expect((await send("getGitSync", 200, h.call(admin, "GET", "spaces/books/git-sync"))).sync.hasToken).toBe(true);
    await send("runGitSync", 200, h.call(admin, "POST", "spaces/books/git-sync/run"));
    await h.services.gitSync.tick();
    const [gitRun] = await send("listGitSyncRuns", 200, h.call(admin, "GET", "spaces/books/git-sync/runs"));
    expect(gitRun.pushed).toBeGreaterThan(0);
    await send("removeGitSync", 200, h.call(admin, "DELETE", "spaces/books/git-sync"));

    const hook = await send(
      "createSpaceWebhook",
      201,
      h.call(admin, "POST", "spaces/books/webhooks", {
        name: "钩子",
        kind: "generic",
        url: "https://example.com/in",
        secret: "s"
      })
    );
    await send("listSpaceWebhooks", 200, h.call(admin, "GET", "spaces/books/webhooks"));
    await send(
      "createSiteWebhook",
      201,
      h.call(admin, "POST", "webhooks", { name: "全站", kind: "feishu", url: "https://example.com/in" })
    );
    await send("listSiteWebhooks", 200, h.call(admin, "GET", "webhooks"));
    await send("updateWebhook", 200, h.call(admin, "PATCH", `webhooks/${hook.id as string}`, { name: "改过" }));
    await h.call(admin, "POST", `documents/${page.id as string}/threads`, {
      anchor: { kind: "document" },
      body: "一条评论"
    });
    const [delivery] = await send(
      "listWebhookDeliveries",
      200,
      h.call(admin, "GET", `webhooks/${hook.id as string}/deliveries`)
    );
    expect(delivery.event).toBe("comment.created");
    await h.pool.query("UPDATE pandocs.webhook_deliveries SET status = 'failed'");
    await send("createShareLink", 201, h.call(admin, "POST", `documents/${page.id as string}/share-links`, {}));
    await send("listShareLinks", 200, h.call(admin, "GET", `documents/${page.id as string}/share-links`));
    const changeSet = await send(
      "createChangeSet",
      201,
      h.call(admin, "POST", "spaces/books/change-sets", { title: "一批改动" })
    );
    const inChangeSet = await send(
      "putChangeSetPage",
      201,
      h.call(admin, "POST", `change-sets/${changeSet.id as string}/pages`, {
        document: page.id,
        baseRevision: page.currentRevisionNo,
        markdown: "改过了。\n"
      })
    );
    await send(
      "putChangeSetPage",
      201,
      h.call(admin, "POST", `change-sets/${changeSet.id as string}/pages`, {
        path: "from-change-set",
        title: "新页面",
        markdown: "新的。\n"
      })
    );
    await send(
      "updateChangeSet",
      200,
      h.call(admin, "PATCH", `change-sets/${changeSet.id as string}`, { description: "为什么" })
    );
    await send("listChangeSets", 200, h.call(admin, "GET", "spaces/books/change-sets"));
    await send("getChangeSet", 200, h.call(admin, "GET", `change-sets/${changeSet.id as string}`));
    await send("closeChangeSet", 200, h.call(admin, "POST", `change-sets/${changeSet.id as string}/close`));
    await send("reopenChangeSet", 200, h.call(admin, "POST", `change-sets/${changeSet.id as string}/reopen`));
    expect(inChangeSet.kind).toBe("edit");
    await h.call(admin, "POST", `change-sets/${changeSet.id as string}/merge`);
    const merged = await send("getChangeSet", 200, h.call(admin, "GET", `change-sets/${changeSet.id as string}`));
    expect(merged.status).toBe("merged");
    await send("getDocument", 200, h.call(admin, "GET", `documents/${page.id as string}`));
    await send("getSpace", 200, h.call(admin, "GET", "spaces/books"));
    await send("listBulkImportSources", 200, h.call(admin, "GET", "bulk-imports/sources"));
    const started = await send(
      "startBulkImport",
      201,
      h.call(admin, "POST", "spaces/books/bulk-imports", { source: "test", url: "x" })
    );
    await h.services.bulkImports.tick();
    expect(
      (await send("getBulkImport", 200, h.call(admin, "GET", `bulk-imports/${started.id as string}`))).report.notes
    ).toHaveLength(1);
    const failing = await send(
      "startBulkImport",
      201,
      h.call(admin, "POST", "spaces/books/bulk-imports", { source: "test", url: "fail" })
    );
    await h.services.bulkImports.tick();
    await send("listBulkImports", 200, h.call(admin, "GET", "spaces/books/bulk-imports"));
    await send("retryBulkImport", 200, h.call(admin, "POST", `bulk-imports/${failing.id as string}/retry`));
    await send("cancelBulkImport", 200, h.call(admin, "POST", `bulk-imports/${failing.id as string}/cancel`));
    await send(
      "retryWebhookDelivery",
      200,
      h.call(admin, "POST", `webhooks/${hook.id as string}/deliveries/${delivery.id as string}/retry`)
    );
  });
});
