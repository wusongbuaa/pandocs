import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresFixture } from "./postgres.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("bringing an export back", () => {
  let h: ReturnType<typeof createHarness>;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
    for (const slug of ["source", "target"]) await h.call(USERS.admin, "POST", "spaces", { slug, name: slug, defaultRole: "viewer" });
    for (const slug of ["source", "target"]) await h.call(USERS.admin, "PUT", `spaces/${slug}/members`, { subject: `user:${USERS.editor.id}`, role: "editor" });
  });
  afterAll(async () => {
    expect(h.errors).toEqual([]);
    await h.close();
  });

  const importZip = (space: string, bytes: Uint8Array, who = USERS.editor) => h.call(who, "POST", `spaces/${space}/archive`, bytes, { "content-type": "application/zip" });

  it("restores pages, order, titles and images in another space, and changes nothing when run again", async () => {
    const asset = (await h.call(USERS.editor, "POST", "spaces/source/assets?filename=a.png", PNG, { "content-type": "image/png" })).data as { path: string };
    const parent = (await h.call(USERS.editor, "POST", "spaces/source/documents", { title: "上级页", slug: "parent", markdown: `![图](${asset.path})\n` })).data.document;
    await h.call(USERS.editor, "POST", "spaces/source/documents", { title: "子页", slug: "child", parentPath: parent.path, markdown: "[回上级](../parent.md)\n" });
    await h.call(USERS.editor, "POST", "spaces/source/documents", { title: "后面的页", slug: "later", markdown: "内容\n", sortOrder: 500 });
    const exported = await h.call(USERS.editor, "GET", "spaces/source/export");
    const bytes = new Uint8Array(await exported.response.arrayBuffer());

    const first = await importZip("target", bytes);
    expect(first.data).toEqual({ created: 3, updated: 0, unchanged: 0, assets: 1, skipped: [] });
    const tree = (await h.call(USERS.editor, "GET", "spaces/target/tree")).data as { path: string; title: string; sortOrder: number; id: string }[];
    expect(tree.map(node => [node.path, node.title])).toEqual(expect.arrayContaining([["parent", "上级页"], ["parent/child", "子页"], ["later", "后面的页"]]));
    expect(tree.find(node => node.path === "later")!.sortOrder).toBe(500);
    const page = (await h.call(USERS.editor, "GET", `documents/${tree.find(node => node.path === "parent")!.id}`)).data;
    expect(page.markdown).toContain(asset.path);
    expect((await h.call(USERS.reader, "GET", `spaces/target/${asset.path}`)).status).toBe(200);

    expect((await importZip("target", bytes)).data).toEqual({ created: 0, updated: 0, unchanged: 3, assets: 1, skipped: [] });
  });

  it("leaves out a page with a blank title or an order out of range, says why, and brings in the rest", async () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ documents: [{ file: "blankish.md", title: "   " }, { file: "far.md", title: "太靠后", sortOrder: 2 ** 40 }, { file: "two-lines.md", title: " 两行\n标题 " }] })),
      "blankish.md": strToU8("内容\n"),
      "far.md": strToU8("内容\n"),
      "two-lines.md": strToU8("内容\n")
    });
    const result = await importZip("target", zip);
    expect(result.status).toBe(200);
    expect(result.data.created).toBe(1);
    expect(result.data.skipped.map((item: { file: string }) => item.file).sort()).toEqual(["blankish.md", "far.md"]);
    const tree = (await h.call(USERS.editor, "GET", "spaces/target/tree")).data as { path: string; title: string }[];
    expect(tree.find(node => node.path === "two-lines")?.title).toBe("两行 标题");
  });

  it("gives a page at the same address a new version when its text differs, so nothing is lost", async () => {
    const page = (await h.call(USERS.editor, "POST", "spaces/target/documents", { title: "已有的页", slug: "existing", markdown: "旧内容\n" })).data.document;
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ documents: [{ file: "existing.md", title: "新标题" }] })),
      "existing.md": strToU8("新内容\n")
    });
    expect((await importZip("target", zip)).data).toMatchObject({ created: 0, updated: 1 });
    const read = (await h.call(USERS.editor, "GET", `documents/${page.id}`)).data;
    expect(read).toMatchObject({ markdown: "新内容\n", revision: { no: 2, message: "Imported from an archive" }, document: { title: "新标题" } });
    expect((await h.call(USERS.editor, "GET", `documents/${page.id}/revisions/1`)).data.markdown).toBe("旧内容\n");
  });

  it("reports what could not come in and brings the rest", async () => {
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ documents: [
        { file: "fine.md", title: "没问题" },
        { file: "missing.md", title: "文件不在" },
        { file: "no/parent.md", title: "没有上级" },
        { file: "has space.md", title: "地址有空格" }
      ] })),
      "fine.md": strToU8("内容\n"),
      "no/parent.md": strToU8("内容\n"),
      "has space.md": strToU8("内容\n"),
      [`assets/${"0".repeat(64)}.png`]: PNG
    });
    const { data } = await importZip("target", zip);
    expect(data.created).toBe(1);
    expect(data.assets).toBe(0);
    expect(data.skipped.map((item: { file: string }) => item.file).sort()).toEqual([`assets/${"0".repeat(64)}.png`, "has space.md", "missing.md", "no/parent.md"].sort());
  });

  it("refuses what is not one of its exports, and people who cannot edit", async () => {
    expect((await importZip("target", new Uint8Array([1, 2, 3]))).error.code).toBe("ARCHIVE_INVALID");
    expect((await importZip("target", zipSync({ "a.md": strToU8("内容") }))).error.code).toBe("ARCHIVE_INVALID");
    expect((await importZip("target", zipSync({ "manifest.json": strToU8("不是 JSON") }))).error.code).toBe("ARCHIVE_INVALID");
    expect((await importZip("target", zipSync({ "manifest.json": strToU8("{}") }), USERS.reader)).status).toBe(403);
  });
});
