import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storageKey } from "../src/application/assets.js";
import { usePostgresFixture } from "./postgres.js";
import { applyPandocsSchema } from "../src/infrastructure/migrate.js";
import { createHarness, resetPandocs, USERS } from "./support.js";

const fixture = usePostgresFixture();

describe("managing the document tree", () => {
  let h: ReturnType<typeof createHarness>;
  let space = "";
  let counter = 0;

  beforeAll(async () => {
    await resetPandocs(fixture.getConnectionString());
    h = createHarness(fixture.getConnectionString());
  });
  afterAll(() => h.close());

  beforeEach(async () => {
    counter += 1;
    space = `tree-${counter}`;
    await h.call(USERS.admin, "POST", "spaces", { slug: space, name: `目录 ${counter}`, defaultRole: "viewer" });
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, { subject: `user:${USERS.editor.id}`, role: "editor" });
    await h.call(USERS.admin, "PUT", `spaces/${space}/members`, {
      subject: `user:${USERS.commenter.id}`,
      role: "commenter"
    });
  });

  const create = async (title: string, parentPath?: string, slug = title) => {
    const created = await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
      title,
      slug,
      markdown: `# ${title}\n\n内容\n`,
      ...(parentPath ? { parentPath } : {})
    });
    expect(created.status).toBe(201);
    return created.data.document.id as string;
  };
  const tree = async () =>
    (await h.call(USERS.editor, "GET", `spaces/${space}/tree`)).data as {
      id: string;
      path: string;
      title: string;
      parentId: string | null;
      sortOrder: number;
    }[];
  const paths = async () => (await tree()).map(node => node.path).sort();
  const order = async (parentId: string | null = null) =>
    (await tree()).filter(node => node.parentId === parentId).map(node => node.title);

  describe("moving", () => {
    it("takes everything below the page along and keeps the old addresses working", async () => {
      await create("甲");
      await create("乙", "甲");
      await create("丙", "甲/乙");
      const target = await create("丁");
      const moved = (await tree()).find(node => node.path === "甲/乙")!;

      const response = await h.call(USERS.editor, "POST", `documents/${moved.id}/move`, { parentId: target });
      expect(response.status).toBe(200);
      expect(response.data.path).toBe("丁/乙");
      expect(await paths()).toEqual(["丁", "丁/乙", "丁/乙/丙", "甲"]);

      const old = await h.call(USERS.reader, "GET", `spaces/${space}/resolve?path=${encodeURIComponent("甲/乙/丙")}`);
      expect(old.data).toMatchObject({ path: "丁/乙/丙", redirected: true });
      const current = await h.call(
        USERS.reader,
        "GET",
        `spaces/${space}/resolve?path=${encodeURIComponent("丁/乙/丙")}`
      );
      expect(current.data).toMatchObject({ path: "丁/乙/丙", redirected: false });
    });

    it("moves pages whose addresses the site cannot open, from before such addresses were refused, and keeps the old ones", async () => {
      const parent = await create("百分比", undefined, "half");
      await create("子页", "half", "child");
      const upper = await create("大写首页", undefined, "upper-index");
      await create("同名", undefined, "50-off");
      await create("目录");
      const nested = await create("子首页", "目录", "nested-index");
      const html = await create("网页", undefined, "page-html-old");
      // As they could be written before: straight into the table, past the checks made since.
      const rename = (id: string, slug: string, path: string) =>
        h.pool.query(`UPDATE pandocs.documents SET slug = $2, path = $3 WHERE id = $1`, [id, slug, path]);
      await rename(parent, "50%off", "50%off");
      await h.pool.query(
        `UPDATE pandocs.documents SET path = '50%off/child' WHERE path = 'half/child' AND space_id = (SELECT id FROM pandocs.spaces WHERE slug = $1)`,
        [space]
      );
      await rename(upper, "Index", "Index");
      await rename(nested, "index", "目录/index");
      await rename(html, "notes.html", "notes.html");
      await applyPandocsSchema(fixture.getConnectionString());
      expect(await paths()).toEqual(
        ["50-off", "50-off-2", "50-off-2/child", "Index-page", "notes-html", "目录", "目录/index-page"].sort()
      );
      for (const [old, now] of [
        ["50%off", "50-off-2"],
        ["50%off/child", "50-off-2/child"],
        ["Index", "Index-page"],
        ["目录/index", "目录/index-page"],
        ["notes.html", "notes-html"]
      ]) {
        expect(
          (await h.call(USERS.reader, "GET", `spaces/${space}/resolve?path=${encodeURIComponent(old!)}`)).data,
          old
        ).toMatchObject({ path: now, redirected: true });
      }
      // Run again, as every start does, it finds nothing more to move.
      await applyPandocsSchema(fixture.getConnectionString());
      expect(await paths()).toEqual(
        ["50-off", "50-off-2", "50-off-2/child", "Index-page", "notes-html", "目录", "目录/index-page"].sort()
      );
    });

    it("changes the address without moving, and a new page may take the old one", async () => {
      const id = await create("页面", undefined, "old");
      expect((await h.call(USERS.editor, "POST", `documents/${id}/move`, { slug: "new" })).data.path).toBe("new");
      expect((await h.call(USERS.reader, "GET", `spaces/${space}/resolve?path=old`)).data).toMatchObject({
        id,
        redirected: true
      });

      const replacement = await create("新占用", undefined, "old");
      expect((await h.call(USERS.reader, "GET", `spaces/${space}/resolve?path=old`)).data).toMatchObject({
        id: replacement,
        redirected: false
      });
      // Moving back over a live page is refused rather than taking its address.
      expect((await h.call(USERS.editor, "POST", `documents/${id}/move`, { slug: "old" })).error.code).toBe(
        "DOCUMENT_PATH_TAKEN"
      );
    });

    it("refuses to put a page under itself or where its children would collide", async () => {
      const parent = await create("甲");
      await create("乙", "甲");
      const child = (await tree()).find(node => node.path === "甲/乙")!;
      expect((await h.call(USERS.editor, "POST", `documents/${parent}/move`, { parentId: child.id })).error.code).toBe(
        "MOVE_INTO_SELF"
      );
      expect((await h.call(USERS.editor, "POST", `documents/${parent}/move`, { parentId: parent })).error.code).toBe(
        "MOVE_INTO_SELF"
      );

      await create("丙");
      await create("乙", "丙");
      const other = (await tree()).find(node => node.path === "丙")!;
      expect(
        (await h.call(USERS.editor, "POST", `documents/${child.id}/move`, { parentId: other.id })).error.code
      ).toBe("DOCUMENT_PATH_TAKEN");
      expect((await h.call(USERS.editor, "POST", `documents/${child.id}/move`, { slug: "a/b" })).error.code).toBe(
        "SLUG_INVALID"
      );
    });

    it("keeps the page's own relative links working, with a version only where they changed", async () => {
      await create("甲");
      await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
        title: "兄弟",
        slug: "兄弟",
        parentPath: "甲",
        markdown: "内容\n"
      });
      const page = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "页面",
          slug: "页面",
          parentPath: "甲",
          markdown: "[兄弟](./兄弟.md) 和 [子](./页面/子.md)\n"
        })
      ).data.document.id as string;
      const child = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "子",
          slug: "子",
          parentPath: "甲/页面",
          markdown: "[回到上级](../页面.md) 和 [兄弟](../兄弟.md)\n"
        })
      ).data.document.id as string;
      const plain = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "没有链接",
          slug: "没有链接",
          parentPath: "甲/页面",
          markdown: "正文\n"
        })
      ).data.document.id as string;
      const thread = (
        await h.call(USERS.commenter, "POST", `documents/${page}/threads`, {
          anchor: { kind: "quote", quote: "兄弟" },
          body: "看这里"
        })
      ).data.id as string;
      const target = await create("乙");

      expect((await h.call(USERS.editor, "POST", `documents/${page}/move`, { parentId: target })).status).toBe(200);

      const read = async (id: string) => (await h.call(USERS.reader, "GET", `documents/${id}`)).data;
      const moved = await read(page);
      expect(moved.markdown).toBe("[兄弟](../甲/兄弟.md) 和 [子](./页面/子.md)\n");
      expect(moved.revision).toMatchObject({
        no: 2,
        message: "Updated relative links after a page moved",
        actorName: USERS.editor.displayName
      });
      const movedChild = await read(child);
      expect(movedChild.markdown).toBe("[回到上级](../页面.md) 和 [兄弟](../../甲/兄弟.md)\n");
      expect((await read(plain)).revision.no).toBe(1);
      // Only the link's address changed, so a comment on its words stays where it was.
      expect((await h.call(USERS.reader, "GET", `threads/${thread}`)).data.anchorState).toBe("exact");
    });

    it("does not make a version just for reordering or renaming the address in place", async () => {
      await create("甲");
      const page = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "页面",
          slug: "页面",
          parentPath: "甲",
          markdown: "[别的](./别的.md)\n"
        })
      ).data.document.id as string;
      await h.call(USERS.editor, "POST", `documents/${page}/move`, { slug: "新地址" });
      await h.call(USERS.editor, "POST", `documents/${page}/move`, { beforeId: null });
      expect((await h.call(USERS.reader, "GET", `documents/${page}`)).data.revision.no).toBe(1);
    });

    it("rewrites translations of a moved page too, without making a version", async () => {
      await h.call(USERS.admin, "PATCH", "site", {
        defaultLang: "zh",
        locales: [
          { lang: "zh", label: "简体中文" },
          { lang: "en", label: "English" }
        ]
      });
      await create("甲");
      const page = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "页面",
          slug: "页面",
          parentPath: "甲",
          markdown: "[兄弟](./兄弟.md)\n"
        })
      ).data.document.id as string;
      await h.call(USERS.editor, "PUT", `documents/${page}/translations/en`, {
        title: "Page",
        markdown: "[Sibling](./兄弟.md)\n",
        sourceRevision: 1
      });
      const target = await create("乙");
      await h.call(USERS.editor, "POST", `documents/${page}/move`, { parentId: target });
      const translation = (await h.call(USERS.reader, "GET", `documents/${page}/translations/en`)).data;
      expect(translation.markdown).toBe("[Sibling](../甲/兄弟.md)\n");
      // Only an address changed in the source, so a translation that was up to date still is.
      expect(translation).toMatchObject({ sourceRevision: 2, stale: false });
      await h.call(USERS.admin, "PATCH", "site", { locales: [{ lang: "zh", label: "简体中文" }] });
    });

    it("leaves a translation that had already fallen behind marked as behind", async () => {
      await h.call(USERS.admin, "PATCH", "site", {
        defaultLang: "zh",
        locales: [
          { lang: "zh", label: "简体中文" },
          { lang: "en", label: "English" }
        ]
      });
      await create("甲");
      const page = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "页面",
          slug: "页面",
          parentPath: "甲",
          markdown: "[兄弟](./兄弟.md)\n"
        })
      ).data.document.id as string;
      await h.call(USERS.editor, "PUT", `documents/${page}/translations/en`, {
        title: "Page",
        markdown: "[Sibling](./兄弟.md)\n",
        sourceRevision: 1
      });
      await h.write(USERS.editor, "PUT", `documents/${page}/content`, {
        markdown: "[兄弟](./兄弟.md) 新内容\n",
        expectedRevision: 1
      });
      const target = await create("乙");
      await h.call(USERS.editor, "POST", `documents/${page}/move`, { parentId: target });
      expect((await h.call(USERS.reader, "GET", `documents/${page}`)).data.revision.no).toBe(3);
      expect((await h.call(USERS.reader, "GET", `documents/${page}/translations/en`)).data).toMatchObject({
        sourceRevision: 1,
        stale: true
      });
      await h.call(USERS.admin, "PATCH", "site", { locales: [{ lang: "zh", label: "简体中文" }] });
    });

    it("keeps a page made under another at the same moment it is deleted or moved under it, or refuses to make it", async () => {
      for (let round = 0; round < 12; round += 1) {
        const parent = await create(`删除父页${round}`);
        const [, made] = await Promise.all([
          h.call(USERS.admin, "DELETE", `documents/${parent}?recursive=true`),
          h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
            title: "新子页",
            slug: "child",
            parentPath: `删除父页${round}`,
            markdown: "内容\n"
          })
        ]);
        // Either it was refused, or it went to the trash with the page above it.
        if (made.status === 201)
          expect(
            (await h.call(USERS.editor, "GET", `documents/${made.data.document.id}`)).status,
            `round ${round}`
          ).toBe(404);
        else expect(made.status, `round ${round}`).toBe(404);
      }
      const archive = await create("归档");
      for (let round = 0; round < 12; round += 1) {
        const moving = await create(`移动父页${round}`);
        const [moved, made] = await Promise.all([
          h.call(USERS.admin, "POST", `documents/${moving}/move`, { parentId: archive }),
          h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
            title: "新子页",
            slug: "child",
            parentPath: `移动父页${round}`,
            markdown: "内容\n"
          })
        ]);
        expect(moved.status).toBe(200);
        if (made.status === 201)
          expect(
            (await h.call(USERS.editor, "GET", `documents/${made.data.document.id}`)).data.document.path,
            `round ${round}`
          ).toBe(`归档/移动父页${round}/child`);
        else expect(made.status, `round ${round}`).toBe(404);
      }
    });

    it("tells one of two people moving pages under each other at once that the other got there first", async () => {
      for (let round = 0; round < 8; round += 1) {
        const early = await create(`早班${round}`);
        const late = await create(`夜班${round}`);
        const answers = await Promise.all([
          h.call(USERS.admin, "POST", `documents/${early}/move`, { parentId: late }),
          h.call(USERS.editor, "POST", `documents/${late}/move`, { parentId: early })
        ]);
        for (const answer of answers) expect([200, 409, 422], JSON.stringify(answer.error)).toContain(answer.status);
        for (const answer of answers.filter(item => item.status === 409))
          expect(answer.error.code).toBe("CONCURRENT_CHANGE");
        // Never a page under itself.
        const nodes = await tree();
        const [a, b] = [nodes.find(node => node.id === early)!, nodes.find(node => node.id === late)!];
        expect(a.parentId === late && b.parentId === early).toBe(false);
      }
    });

    it("orders pages among their siblings", async () => {
      const a = await create("一");
      const b = await create("二");
      const c = await create("三");
      expect(await order()).toEqual(["一", "二", "三"]);
      await h.call(USERS.editor, "POST", `documents/${c}/move`, { beforeId: a });
      expect(await order()).toEqual(["三", "一", "二"]);
      await h.call(USERS.editor, "POST", `documents/${c}/move`, { beforeId: null });
      expect(await order()).toEqual(["一", "二", "三"]);
      expect((await h.call(USERS.editor, "POST", `documents/${a}/move`, { beforeId: a })).error.code).toBe(
        "MOVE_TARGET_INVALID"
      );
      await h.call(USERS.editor, "POST", `documents/${b}/move`, { parentId: a });
      expect(await order()).toEqual(["一", "三"]);
      expect(await order(a)).toEqual(["二"]);
    });

    it("needs edit rights on the page and on where it goes", async () => {
      const id = await create("页面");
      expect((await h.call(USERS.commenter, "POST", `documents/${id}/move`, { slug: "x" })).status).toBe(403);
      const locked = (
        await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
          title: "受限",
          slug: "locked",
          markdown: "x\n",
          restricted: true
        })
      ).data.document.id as string;
      expect((await h.call(USERS.editor, "POST", `documents/${id}/move`, { parentId: locked })).status).toBe(404);
    });
  });

  describe("the trash", () => {
    it("takes a page and everything below it, and brings them back together", async () => {
      const parent = await create("甲");
      await create("乙", "甲");
      await create("丙", "甲/乙");
      expect((await h.call(USERS.editor, "DELETE", `documents/${parent}`)).error.code).toBe("DOCUMENT_HAS_CHILDREN");
      expect((await h.call(USERS.editor, "DELETE", `documents/${parent}?recursive=true`)).status).toBe(200);
      expect(await paths()).toEqual([]);
      expect((await h.call(USERS.reader, "GET", `documents/${parent}`)).status).toBe(404);

      const trash = await h.call(USERS.editor, "GET", `spaces/${space}/trash`);
      expect(trash.data).toHaveLength(1);
      expect(trash.data[0]).toMatchObject({
        id: parent,
        title: "甲",
        path: "甲",
        descendants: 2,
        deletedName: USERS.editor.displayName
      });

      expect((await h.call(USERS.editor, "POST", `documents/${parent}/restore`)).status).toBe(200);
      expect(await paths()).toEqual(["甲", "甲/乙", "甲/乙/丙"]);
      expect((await h.call(USERS.editor, "GET", `spaces/${space}/trash`)).data).toEqual([]);
    });

    it("finds a place for a page whose parent or address is gone", async () => {
      const parent = await create("甲");
      const child = await create("乙", "甲");
      await h.call(USERS.editor, "DELETE", `documents/${child}`);
      await h.call(USERS.editor, "DELETE", `documents/${parent}`);
      expect((await h.call(USERS.editor, "POST", `documents/${child}/restore`)).data).toMatchObject({
        path: "乙",
        parentId: null
      });

      const again = await create("丙");
      await h.call(USERS.editor, "DELETE", `documents/${again}`);
      await create("丙");
      expect((await h.call(USERS.editor, "POST", `documents/${again}/restore`)).data).toMatchObject({
        path: "丙-2",
        slug: "丙-2"
      });
    });

    it("keeps links and old addresses working when a page comes back somewhere else", async () => {
      const parent = await create("甲");
      const page = (
        await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
          title: "页面",
          slug: "页面",
          parentPath: "甲",
          markdown: "[兄弟](./兄弟.md)\n"
        })
      ).data.document.id as string;
      await h.call(USERS.editor, "DELETE", `documents/${page}`);
      await h.call(USERS.editor, "DELETE", `documents/${parent}`);
      expect((await h.call(USERS.editor, "POST", `documents/${page}/restore`)).data.path).toBe("页面");
      expect((await h.call(USERS.reader, "GET", `documents/${page}`)).data.markdown).toBe("[兄弟](./甲/兄弟.md)\n");
      expect(
        (await h.call(USERS.reader, "GET", `spaces/${space}/resolve?path=${encodeURIComponent("甲/页面")}`)).data
      ).toMatchObject({ id: page, path: "页面", redirected: true });
    });

    it("empties the trash for an admin, and removes old pages only when a retention period is set", async () => {
      const gone = await create("要清空的页");
      await h.call(USERS.editor, "DELETE", `documents/${gone}`);
      expect((await h.call(USERS.editor, "DELETE", `spaces/${space}/trash`)).status).toBe(403);
      const emptied = await h.call(USERS.admin, "DELETE", `spaces/${space}/trash`);
      expect(emptied.data.removed).toBeGreaterThanOrEqual(1);
      expect((await h.call(USERS.admin, "GET", `spaces/${space}/trash`)).data).toEqual([]);

      const old = await create("放久了的页");
      const recent = await create("刚删的页");
      await h.call(USERS.editor, "DELETE", `documents/${old}`);
      await h.call(USERS.editor, "DELETE", `documents/${recent}`);
      await h.pool.query(`UPDATE pandocs.documents SET deleted_at = now() - interval '40 days' WHERE id = $1`, [old]);
      expect(await h.services.tree.sweepTrash(null)).toBe(0);
      expect((await h.call(USERS.admin, "GET", `spaces/${space}/trash`)).data).toHaveLength(2);
      expect(await h.services.tree.sweepTrash(30)).toBe(1);
      expect(
        (await h.call(USERS.admin, "GET", `spaces/${space}/trash`)).data.map((entry: { id: string }) => entry.id)
      ).toEqual([recent]);
      expect((await h.call(USERS.admin, "PATCH", "site", { trashRetentionDays: 30 })).data.trashRetentionDays).toBe(30);
      await h.call(USERS.admin, "PATCH", "site", { trashRetentionDays: null });
    });

    it("lists only what someone can edit, and only an admin can empty it", async () => {
      const id = await create("甲");
      await h.call(USERS.editor, "DELETE", `documents/${id}`);
      expect((await h.call(USERS.reader, "GET", `spaces/${space}/trash`)).status).toBe(403);
      expect((await h.call(USERS.commenter, "POST", `documents/${id}/restore`)).status).toBe(403);
      expect((await h.call(USERS.editor, "DELETE", `documents/${id}/purge`)).status).toBe(403);
      expect((await h.call(USERS.admin, "DELETE", `documents/${id}/purge`)).status).toBe(200);
      expect((await h.call(USERS.admin, "POST", `documents/${id}/restore`)).status).toBe(404);
      expect((await h.call(USERS.editor, "GET", `spaces/${space}/trash`)).data).toEqual([]);
    });

    it("will not take a restricted page the person cannot edit along with its parent", async () => {
      const parent = await create("甲");
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "受限",
        slug: "locked",
        parentPath: "甲",
        markdown: "x\n",
        restricted: true
      });
      expect((await h.call(USERS.editor, "DELETE", `documents/${parent}?recursive=true`)).status).toBe(403);
      expect((await h.call(USERS.admin, "DELETE", `documents/${parent}?recursive=true`)).status).toBe(200);
    });
  });

  describe("spaces", () => {
    it("keeps a deleted space's content until it is restored", async () => {
      const id = await create("甲");
      expect((await h.call(USERS.editor, "DELETE", `spaces/${space}`)).status).toBe(403);
      expect((await h.call(USERS.admin, "DELETE", `spaces/${space}`)).status).toBe(200);
      expect((await h.call(USERS.admin, "GET", `spaces/${space}`)).status).toBe(404);
      expect((await h.call(USERS.admin, "GET", `documents/${id}`)).status).toBe(404);
      expect(
        (await h.call(USERS.admin, "GET", "spaces")).data.map((item: { slug: string }) => item.slug)
      ).not.toContain(space);

      expect((await h.call(USERS.editor, "GET", "deleted-spaces")).status).toBe(403);
      const deleted = (await h.call(USERS.admin, "GET", "deleted-spaces")).data.find(
        (item: { slug: string }) => item.slug === space
      );
      expect(deleted).toMatchObject({ name: expect.stringContaining("目录"), deletedName: USERS.admin.displayName });

      // Its address is free while it is deleted, so restoring has to notice if it was taken.
      await h.call(USERS.admin, "POST", "spaces", { slug: space, name: "占用", defaultRole: "viewer" });
      expect((await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`)).error.code).toBe(
        "SPACE_SLUG_TAKEN"
      );
      await h.call(USERS.admin, "DELETE", `spaces/${space}`);
      expect((await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`)).status).toBe(200);
      expect((await h.call(USERS.admin, "GET", `documents/${id}`)).status).toBe(200);
    });

    it("deletes a deleted space for good, and leaves one still in use alone", async () => {
      const page = await create("甲");
      const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
      const asset = await h.call(USERS.editor, "POST", `spaces/${space}/assets?filename=a.png`, image);
      expect(asset.status).toBe(201);
      const hash = asset.data.sha256 as string;
      const kept = await h.call(USERS.admin, "POST", "spaces", {
        slug: `${space}-kept`,
        name: "留下",
        defaultRole: "viewer"
      });
      const keptAsset = await h.call(
        USERS.admin,
        "POST",
        `spaces/${space}-kept/assets?filename=b.png`,
        new Uint8Array([...image, 1])
      );
      expect(keptAsset.status).toBe(201);
      const importId = randomUUID();
      const { rows: here } = await h.pool.query<{ id: string }>(`SELECT id FROM pandocs.spaces WHERE slug = $1`, [
        space
      ]);
      await h.pool.query(
        `INSERT INTO pandocs.bulk_imports (id, space_id, source, principal, created_by, created_name) VALUES ($1, $2, 'zip', '{}', $3, $4)`,
        [importId, here[0]!.id, USERS.admin.id, USERS.admin.displayName]
      );
      await h.services.context.ports.assets.put(`imports/${importId}`, new Uint8Array([1, 2, 3]), "application/zip");
      await h.pool.query(
        `INSERT INTO pandocs.search_terms (day, space, term, audience) VALUES (current_date, $1, '甲', 'person')`,
        [space]
      );
      await h.pool.query(
        `INSERT INTO pandocs.questions (space, question, answer, answered) VALUES ($1, '这是什么', '一页', false)`,
        [space]
      );

      expect((await h.call(USERS.admin, "DELETE", `spaces/${space}`)).status).toBe(200);
      const deleted = (await h.call(USERS.admin, "GET", "deleted-spaces")).data.find(
        (item: { slug: string }) => item.slug === space
      );
      const readonly = { ...USERS.admin, scopes: ["read"] as const };
      expect((await h.call(USERS.editor, "DELETE", `deleted-spaces/${deleted.id}`)).status).toBe(403);
      expect((await h.call(readonly, "DELETE", `deleted-spaces/${deleted.id}`)).status).toBe(403);
      expect((await h.call(USERS.admin, "DELETE", `deleted-spaces/${kept.data.id}`)).status).toBe(404);
      expect((await h.call(USERS.admin, "DELETE", "deleted-spaces/not-an-id")).status).toBe(404);

      expect((await h.call(USERS.admin, "DELETE", `deleted-spaces/${deleted.id}`)).status).toBe(200);
      expect(
        (await h.call(USERS.admin, "GET", "deleted-spaces")).data.find((item: { id: string }) => item.id === deleted.id)
      ).toBeUndefined();
      expect((await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`)).status).toBe(404);
      expect((await h.call(USERS.admin, "DELETE", `deleted-spaces/${deleted.id}`)).status).toBe(404);
      expect((await h.call(USERS.admin, "GET", `documents/${page}`)).status).toBe(404);
      expect((await h.call(USERS.admin, "GET", `spaces/${space}-kept`)).status).toBe(200);
      const left = await h.pool.query(
        `SELECT (SELECT count(*) FROM pandocs.documents WHERE space_id = $1) AS pages, (SELECT count(*) FROM pandocs.assets WHERE space_id = $1) AS assets, (SELECT count(*) FROM pandocs.bulk_imports WHERE id = $2) AS imports`,
        [deleted.id, importId]
      );
      expect(left.rows[0]).toMatchObject({ pages: "0", assets: "0", imports: "0" });
      await expect(readFile(join(h.assetRoot, storageKey(deleted.id, hash)))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(h.assetRoot, "imports", importId))).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        new Uint8Array(await readFile(join(h.assetRoot, storageKey(kept.data.id, keptAsset.data.sha256 as string))))
      ).toEqual(new Uint8Array([...image, 1]));
      const remembered = await h.pool.query(
        `SELECT (SELECT count(*) FROM pandocs.search_terms WHERE space = $1) AS searches, (SELECT count(*) FROM pandocs.questions WHERE space = $1) AS questions`,
        [space]
      );
      expect(remembered.rows[0]).toMatchObject({ searches: "1", questions: "1" });
      const record = (await h.call(USERS.admin, "GET", "audit?category=space")).data as {
        action: string;
        detail: { slug?: string; pages?: number; assets?: number };
      }[];
      expect(record.find(event => event.action === "space.purge" && event.detail.slug === space)?.detail).toMatchObject(
        { name: `目录 ${counter}`, pages: 1, assets: 1 }
      );
      expect(record.some(event => event.action === "space.delete" && event.detail.slug === space)).toBe(true);
    });

    it("restores a deleted space at another address when a space made since has its own", async () => {
      const id = await create("甲");
      await h.call(USERS.admin, "DELETE", `spaces/${space}`);
      const deleted = (await h.call(USERS.admin, "GET", "deleted-spaces")).data.find(
        (item: { slug: string }) => item.slug === space
      );
      await h.call(USERS.admin, "POST", "spaces", { slug: space, name: "占用", defaultRole: "viewer" });
      expect((await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`)).error.code).toBe(
        "SPACE_SLUG_TAKEN"
      );
      expect(
        (await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`, { slug: space })).error.code
      ).toBe("SPACE_SLUG_TAKEN");
      expect(
        (await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`, { slug: "Not An Address" })).status
      ).toBe(422);
      const restored = await h.call(USERS.admin, "POST", `deleted-spaces/${deleted.id}/restore`, {
        slug: `${space}-back`
      });
      expect(restored.data).toMatchObject({ id: deleted.id, slug: `${space}-back` });
      expect((await h.call(USERS.admin, "GET", `documents/${id}`)).data.document.path).toBe("甲");
      expect((await h.call(USERS.admin, "GET", `spaces/${space}`)).data.name).toBe("占用");
    });

    it("shows names next to members when the directory knows them", async () => {
      const named = createHarness(fixture.getConnectionString(), {
        directory: {
          search: async () => [],
          names: async ids => ids.filter(id => id === USERS.editor.id).map(id => ({ id, name: "林澈" }))
        }
      });
      const members = (await named.call(USERS.admin, "GET", `spaces/${space}/members`)).data as {
        subject: string;
        name?: string;
      }[];
      expect(members.find(member => member.subject === `user:${USERS.editor.id}`)?.name).toBe("林澈");
      expect(members.find(member => member.subject === `user:${USERS.commenter.id}`)?.name).toBeUndefined();
      const record = (await named.call(USERS.admin, "GET", `spaces/${space}/audit?category=member`)).data as {
        detail: { subject: string; subjectName?: string };
      }[];
      expect(record.find(event => event.detail.subject === `user:${USERS.editor.id}`)?.detail.subjectName).toBe("林澈");
      expect(
        record.find(event => event.detail.subject === `user:${USERS.commenter.id}`)?.detail.subjectName
      ).toBeUndefined();
      await named.close();
    });
  });

  describe("the record of what happened", () => {
    it("names who did what to which page, per space and by category", async () => {
      const id = await create("甲");
      await h.call(USERS.commenter, "POST", `documents/${id}/threads`, {
        anchor: { kind: "document" },
        body: "一条评论"
      });
      await h.call(USERS.editor, "POST", `documents/${id}/move`, { slug: "乙" });

      expect((await h.call(USERS.editor, "GET", `spaces/${space}/audit`)).status).toBe(403);
      const all = (await h.call(USERS.admin, "GET", `spaces/${space}/audit`)).data as {
        id: string;
        action: string;
        actorName: string;
        documentTitle: string | null;
        documentPath: string | null;
      }[];
      expect(all[0]).toMatchObject({
        action: "document.move",
        actorName: USERS.editor.displayName,
        documentTitle: "甲",
        documentPath: "乙"
      });
      expect(all.find(event => event.action === "thread.create")).toMatchObject({
        actorName: USERS.commenter.displayName,
        documentTitle: "甲"
      });
      expect(all.at(-1)).toMatchObject({ action: "space.create" });

      const discussion = (await h.call(USERS.admin, "GET", `spaces/${space}/audit?category=discussion`)).data as {
        action: string;
      }[];
      expect(discussion.map(event => event.action)).toEqual(["thread.create"]);
      const members = (await h.call(USERS.admin, "GET", `spaces/${space}/audit?category=member`)).data as {
        action: string;
      }[];
      expect(members.map(event => event.action)).toEqual(["space.member.set", "space.member.set"]);
      expect((await h.call(USERS.admin, "GET", `spaces/${space}/audit?category=nope`)).status).toBe(422);

      const page = (await h.call(USERS.admin, "GET", `spaces/${space}/audit?limit=1&before=${all[0]!.id}`)).data as {
        id: string;
      }[];
      expect(page).toEqual([expect.objectContaining({ id: all[1]!.id })]);
    });

    it("has a whole-site view for administrators only", async () => {
      expect((await h.call(USERS.editor, "GET", "audit")).status).toBe(403);
      await h.call(USERS.admin, "PATCH", "site", { title: "站点" });
      expect((await h.call(USERS.admin, "GET", "audit?category=space")).data[0]).toMatchObject({
        action: "site.update"
      });
    });
  });

  describe("export", () => {
    it("gives the Markdown as written, the images it uses, and what Markdown cannot hold", async () => {
      const image = new Uint8Array(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64"
        )
      );
      const asset = await h.call(USERS.editor, "POST", `spaces/${space}/assets?filename=a.png`, image);
      await create("甲");
      await h.call(USERS.editor, "POST", `spaces/${space}/documents`, {
        title: "乙",
        slug: "乙",
        parentPath: "甲",
        markdown: `![图](${asset.data.path})\n`
      });
      await h.call(USERS.admin, "POST", `spaces/${space}/documents`, {
        title: "受限",
        slug: "locked",
        markdown: "秘密\n",
        restricted: true
      });

      const { response } = await h.call(USERS.reader, "GET", `spaces/${space}/export`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
      expect(Object.keys(files).sort()).toEqual(["manifest.json", asset.data.path, "甲.md", "甲/乙.md"].sort());
      expect(new TextDecoder().decode(files["甲/乙.md"])).toBe(`![图](${asset.data.path})\n`);
      expect(files[asset.data.path]).toEqual(image);
      const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"])) as {
        documents: { file: string; title: string; parent: string | null }[];
        missingAssets: string[];
      };
      expect(manifest.documents.find(item => item.file === "甲/乙.md")).toMatchObject({ title: "乙", parent: "甲" });
      expect(manifest.missingAssets).toEqual([]);
    });
  });
});
