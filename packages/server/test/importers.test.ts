import type { BulkImporter, ImportedPage, ImportSink } from "@pandocs/core";
import { PermanentIngestError } from "@pandocs/core";
import { parseDocument, resolveDocLink } from "@pandocs/markdown";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createConfluenceImporter } from "../src/importers/confluence.js";
import { blocksToMarkdown, type FeishuBlock } from "../src/importers/feishu-blocks.js";
import { createFeishuImporter, parseFeishuAddress } from "../src/importers/feishu.js";
import { createNotionImporter } from "../src/importers/notion.js";
import { confluenceExport, notionExport, OTHER_PNG, PNG } from "./import-sources.js";

function collector() {
  const pages: ImportedPage[] = [];
  const notes: { file: string; reason: string }[] = [];
  const assets: { name: string; bytes: Uint8Array }[] = [];
  let expected: number | null = null;
  const sink: ImportSink = {
    expect: count => {
      expected = count;
    },
    note: (file, reason) => notes.push({ file, reason }),
    asset: async (bytes, name) => {
      assets.push({ name, bytes });
      return `assets/${assets.length}.${name.split(".").pop()}`;
    },
    page: async page => {
      pages.push(page);
    }
  };
  return {
    pages,
    notes,
    assets,
    sink,
    expected: () => expected,
    page: (path: string) => pages.find(page => page.path === path)!
  };
}

/** An archive whose directory says one file unpacks to far more than it does, as a crafted one would. */
function claimingSize(archive: Uint8Array, name: string, size: number): Uint8Array {
  const bytes = archive.slice();
  const view = new DataView(bytes.buffer);
  const wanted = strToU8(name);
  for (let at = 0; at + 46 <= bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50 || view.getUint16(at + 28, true) !== wanted.length) continue;
    if (bytes.subarray(at + 46, at + 46 + wanted.length).every((byte, index) => byte === wanted[index]))
      view.setUint32(at + 24, size, true);
  }
  return bytes;
}

const run = async (importer: BulkImporter, input: { bytes?: Uint8Array; url?: string; includeChildren?: boolean }) => {
  const output = collector();
  await importer.run({ includeChildren: false, ...input }, output.sink);
  return output;
};

describe("a Notion export", () => {
  it("makes the same tree of pages, parents first, without the folders that are not pages", async () => {
    const { pages, expected } = await run(createNotionImporter(), { bytes: notionExport() });
    expect(pages.map(page => [page.path, page.title])).toEqual(
      [
        ["handbook", "Handbook"],
        ["handbook/returns", "Returns"],
        ["handbook/returns/refund", "Refund"],
        ["handbook/returns/refund-2", "Refund"],
        ["handbook/returns/refund-2/detail", "Detail"],
        ["just-a-folder", "Just a folder"],
        ["just-a-folder/loose-page", "Loose page"],
        ["orders", "Orders"],
        ["orders/first-order", "First order"],
        ["6123456789ab", "退货说明"]
      ].sort(() => 0)
    );
    expect(expected()).toBe(10);
  });

  it("keeps its links working: between pages, by Notion address, and from one level to another", async () => {
    const { page } = await run(createNotionImporter(), { bytes: notionExport() });
    const home = page("handbook").markdown;
    expect(home).toContain("[Returns](./handbook/returns.md)");
    expect(home).toContain("[the same page by address](./handbook/returns.md)");
    expect(resolveDocLink("handbook", "./handbook/returns.md")?.path).toBe("handbook/returns");
    expect(home).toContain("A page that was not exported: Gone.");
    expect(home).toContain("[site](https://example.com/a_(b))");
    const returns = page("handbook/returns").markdown;
    expect(returns).toContain("[Handbook](../handbook.md)");
    expect(resolveDocLink("handbook/returns", "../handbook.md")?.path).toBe("handbook");
    expect(returns).toContain("[Refund](./returns/refund.md#how)");
  });

  it("brings only the files pages use, and says how a page refers to them", async () => {
    const { page, assets } = await run(createNotionImporter(), { bytes: notionExport() });
    const home = page("handbook").markdown;
    expect(assets.map(asset => asset.name)).toEqual(["diagram.png", "Policy.pdf", "Terms.pdf"]);
    expect(home).toContain("![A diagram](assets/1.png)");
    expect(home).toContain('::file[Policy.pdf]{src="assets/2.pdf"}');
    expect(home).toContain("Read the Terms.pdf before you start.");
    expect(home.trimEnd().endsWith('::file[Terms.pdf]{src="assets/3.pdf"}')).toBe(true);
  });

  it("leaves out a file too large to keep, says so, and does not unpack it to find out", async () => {
    const bytes = claimingSize(notionExport(), "Private & Shared/Handbook/diagram.png", 1_500_000_000);
    const { page, assets, notes } = await run(createNotionImporter(), { bytes });
    expect(assets.map(asset => asset.name)).toEqual(["Policy.pdf", "Terms.pdf"]);
    expect(notes).toContainEqual({
      file: "Handbook",
      reason: "A file is larger than 100 MiB and was left out: diagram.png"
    });
    expect(page("handbook").markdown).toContain("A diagram");
  });

  it("turns callouts and toggles into blocks here, nested ones too, and leaves code alone", async () => {
    const { page } = await run(createNotionImporter(), { bytes: notionExport() });
    const home = page("handbook").markdown;
    expect(home).toContain(":::tip\n\n💡 Keep the receipt.\n\nSecond paragraph.\n\n\n:::");
    expect(home).toContain("::::details[More  details]");
    expect(home).toContain(":::tip\n\nNested tip.\n\n:::");
    expect(home).toContain("```bash\n# not a heading, and [not](link.md) a link\n<aside>\n```");
    expect(home).toContain("`[in](code.md)` stays.");
    expect(parseDocument(home).diagnostics.filter(item => item.severity === "error")).toEqual([]);
  });

  it("takes its title from the heading, and does not say it twice", async () => {
    const { page } = await run(createNotionImporter(), { bytes: notionExport() });
    expect(page("handbook/returns").markdown.startsWith("Seven days.")).toBe(true);
    expect(page("just-a-folder/loose-page")).toMatchObject({
      title: "Loose page",
      markdown: "Has no heading of its own.\n"
    });
  });

  it("makes a table of a database, the one with every column", async () => {
    const { page } = await run(createNotionImporter(), { bytes: notionExport() });
    expect(page("orders").markdown).toBe(
      "| Name | Status | Owner |\n| --- | --- | --- |\n| A | Open | Ana |\n| B\\|C | Done | Ben |\n"
    );
  });

  it("gives a page with a title in another script an address from its id, the same each time", async () => {
    const first = await run(createNotionImporter(), { bytes: notionExport() });
    const second = await run(createNotionImporter(), { bytes: notionExport() });
    expect(first.pages.find(page => page.title === "退货说明")!.path).toBe("6123456789ab");
    expect(second.pages.map(page => page.path)).toEqual(first.pages.map(page => page.path));
  });

  it("reads a big export that comes as a zip of parts", async () => {
    const outer = zipSync({
      "Export-Part-1.zip": notionExport(),
      "Export-Part-2.zip": zipSync({ "Second part 0123456789abcdef0123456789abcdff.md": strToU8("# Second part\n") })
    });
    const { pages } = await run(createNotionImporter(), { bytes: outer });
    expect(pages.map(page => page.title)).toEqual(expect.arrayContaining(["Handbook", "Second part"]));
  });

  it("says so when given something else", async () => {
    await expect(run(createNotionImporter(), { bytes: strToU8("not a zip") })).rejects.toBeInstanceOf(
      PermanentIngestError
    );
    await expect(run(createNotionImporter(), { bytes: zipSync({ "a.txt": strToU8("x") }) })).rejects.toThrow(/Notion/u);
  });
});

describe("a Confluence export", () => {
  it("follows the tree in its index, and uses breadcrumbs for what the index leaves out", async () => {
    const { pages, expected } = await run(createConfluenceImporter(), { bytes: confluenceExport() });
    const paths = pages.map(page => page.path);
    expect(paths.slice(0, 5)).toEqual([
      "docs-home",
      "docs-home/setup",
      "docs-home/setup/linux",
      "docs-home/setup/windows",
      "docs-home/guide"
    ]);
    expect(paths).toContain("docs-home/p6");
    expect(pages.find(page => page.path === "docs-home/p6")!.title).toBe("中文页面");
    expect(pages.find(page => page.path === "docs-home/setup/windows")!.title).toBe("Windows");
    expect(expected()).toBe(6);
  });

  it("takes the page's own content and nothing around it", async () => {
    const { page } = await run(createConfluenceImporter(), { bytes: confluenceExport() });
    const home = page("docs-home").markdown;
    expect(home).not.toMatch(
      /Created by Ana|Document generated|never run|Contents to drop|Attachments:|\(image\/png\)/u
    );
  });

  it("makes blocks of its macros", async () => {
    const { page } = await run(createConfluenceImporter(), { bytes: confluenceExport() });
    const home = page("docs-home").markdown;
    expect(home).toContain(":::info[Heads up]\n\nRead this first.");
    expect(home).toContain(":::danger\n\nBack up first.\n\n:::");
    expect(home).toContain("```java\nclass Main {\n  int x = 1 < 2;\n}\n```");
    expect(home).toContain(":::details[More details]\n\nHidden text\n\n:::");
    expect(home).toMatch(/- +\[x\] +Done task/u);
    expect(home).toMatch(/- +\[ \] +Open task/u);
    expect(home).toContain("| Name | Score |\n| --- | --- |\n| Ada | 10 |");
    expect(home).toContain("All good (tick)");
    expect(parseDocument(home).diagnostics.filter(item => item.severity === "error")).toEqual([]);
  });

  it("keeps links between pages working, and drops those that lead nowhere", async () => {
    const { page } = await run(createConfluenceImporter(), { bytes: confluenceExport() });
    const home = page("docs-home").markdown;
    expect(home).toContain("[Guide](./docs-home/guide.md)");
    expect(home).toContain("[basics](./docs-home/guide.md#Guide-Basics)");
    expect(home).toContain("or the old page.");
    expect(home).toContain("asked by Ana.");
    expect(home).toContain("[site](https://example.com/x)");
    expect(page("docs-home/guide").markdown).toContain("[home](../docs-home.md)");
    expect(page("docs-home/setup/linux").markdown).toContain("[the guide](../guide.md)");
  });

  it("brings images and attachments, each once, including those only listed below the page", async () => {
    const { page, assets } = await run(createConfluenceImporter(), { bytes: confluenceExport() });
    const home = page("docs-home").markdown;
    expect(assets.map(asset => asset.name)).toEqual(["diagram.png", "Handbook.pdf", "Extra.pdf"]);
    expect(home).toContain("![diagram.png](assets/1.png)");
    expect(home).not.toContain("attachments/");
    expect(home).toContain("The handbook, asked by");
    expect(home).toContain('::file[Handbook.pdf]{src="assets/2.pdf"}');
    expect(home.trimEnd().endsWith('::file[Extra.pdf]{src="assets/3.pdf"}')).toBe(true);
  });

  it("brings attachments linked by where they download from, and says which the export left out", async () => {
    const html = `<p>As they download: the <a href="download/attachments/1/13.pdf?version=1&amp;api=v2" data-linked-resource-type="attachment">policy</a>, the <a href="https://docs.example.com/wiki/download/attachments/1/12.pdf?api=v2">extra</a> and <a href="/download/attachments/1/99.pdf">one left out</a>. <img class="confluence-embedded-image" src="/wiki/download/attachments/1/14.png?version=2&amp;api=v2" alt="Floor plan"></p>`;
    const files = { "DOCS/attachments/1/13.pdf": strToU8("%PDF-1.4\n%%EOF\n"), "DOCS/attachments/1/14.png": OTHER_PNG };
    const { page, assets, notes } = await run(createConfluenceImporter(), { bytes: confluenceExport({ html, files }) });
    const home = page("docs-home").markdown;
    expect(assets.map(asset => asset.name)).toEqual([
      "diagram.png",
      "14.png",
      "Handbook.pdf",
      "policy.pdf",
      "extra.pdf"
    ]);
    expect(home).toContain("![Floor plan](assets/2.png)");
    expect(home).toContain('::file[policy.pdf]{src="assets/4.pdf"}');
    expect(home).toContain("and one left out.");
    expect(home).not.toContain("download/attachments");
    expect(notes).toEqual([
      { file: "Docs Home", reason: "An attachment is not in the export: /download/attachments/1/99.pdf" }
    ]);
  });

  it("leaves out an attachment too large to keep, and a page too long to read for its breadcrumbs", async () => {
    let bytes = claimingSize(confluenceExport(), "DOCS/attachments/1/11.pdf", 300_000_000);
    bytes = claimingSize(bytes, "DOCS/Windows_5.html", 300_000_000);
    const { pages, assets, notes } = await run(createConfluenceImporter(), { bytes });
    expect(assets.map(asset => asset.name)).toEqual(["diagram.png", "Extra.pdf"]);
    expect(notes).toContainEqual({
      file: "Docs Home",
      reason: "A file is larger than 100 MiB and was left out: Handbook.pdf"
    });
    expect(notes).toContainEqual({ file: "Windows_5", reason: "This page is too long to import" });
    expect(pages.find(page => page.title === "Windows_5")?.markdown).toBe("");
  });

  it("says so when given something else", async () => {
    await expect(run(createConfluenceImporter(), { bytes: zipSync({ "a.txt": strToU8("x") }) })).rejects.toThrow(
      /Confluence/u
    );
  });
});

describe("a Feishu document's blocks", () => {
  const run_ = (text: string, style: object = {}) => ({ text_run: { content: text, text_element_style: style } });
  const para = (id: string, elements: object[]): FeishuBlock => ({ block_id: id, block_type: 2, text: { elements } });
  const convert = async (children: FeishuBlock[], extras: FeishuBlock[] = []) => {
    const notes: string[] = [];
    const media: string[] = [];
    const markdown = await blocksToMarkdown(
      [
        { block_id: "root", block_type: 1, children: children.map(block => block.block_id), page: { elements: [] } },
        ...children,
        ...extras
      ],
      {
        originalUrl: "https://example.feishu.cn/wiki/abc",
        note: reason => notes.push(reason),
        whiteboard: async token => (token === "drawn" ? "assets/drawn.png" : null),
        linkToPage: token => (token === "known" ? "./known.md" : null),
        media: async (token, name) => {
          media.push(`${token}:${name}`);
          return token === "broken" ? null : `assets/${token}.png`;
        }
      }
    );
    return { markdown, notes, media };
  };

  it("writes inline styles, merging what runs together and keeping spaces outside the marks", async () => {
    const { markdown } = await convert([
      para("a", [
        run_("plain "),
        run_("bo"),
        run_("ld", {}),
        run_(" strong ", { bold: true }),
        run_("slanted", { italic: true }),
        run_("gone", { strikethrough: true }),
        run_("x_y", { inline_code: true }),
        run_("both", { bold: true, italic: true })
      ])
    ]);
    expect(markdown).toBe("plain bold **strong** *slanted*~~gone~~`x_y`***both***\n");
  });

  it("escapes what would otherwise be read as Markdown, and leaves what would not", async () => {
    const { markdown } = await convert([
      para("a", [run_("2 * 3 [x] <b> $5 snake_case _lead `tick")]),
      para("b", [run_("# not a heading")]),
      para("c", [run_("1. not a list")]),
      para("d", [run_(":::tip")])
    ]);
    expect(markdown).toBe(
      "2 \\* 3 \\[x\\] \\<b> \\$5 snake_case \\_lead \\`tick\n\n\\# not a heading\n\n\\1. not a list\n\n\\:::tip\n"
    );
  });

  it("decodes links, and points those to imported pages at where they ended up", async () => {
    const { markdown } = await convert([
      para("a", [
        run_("site", { link: { url: "https%3A%2F%2Fexample.com%2Fa%3Fb%3D1" } }),
        run_(" "),
        run_("inside", { link: { url: "https%3A%2F%2Fexample.feishu.cn%2Fwiki%2Fknown" } }),
        run_(" "),
        {
          mention_doc: {
            token: "known",
            obj_type: 22,
            url: "https%3A%2F%2Fexample.feishu.cn%2Fdocx%2Fknown",
            title: "Known"
          }
        },
        run_(" "),
        {
          mention_doc: {
            token: "other",
            obj_type: 22,
            url: "https%3A%2F%2Fexample.feishu.cn%2Fdocx%2Fother",
            title: "Other"
          }
        }
      ])
    ]);
    expect(markdown).toBe(
      "[site](https://example.com/a?b=1) [inside](./known.md) [Known](./known.md) [Other](https://example.feishu.cn/docx/other)\n"
    );
  });

  it("writes formulas, mentions and dates, and ends a line where someone did", async () => {
    const { markdown } = await convert([
      para("a", [
        run_("Area "),
        { equation: { content: "\\pi r^2\n" } },
        run_(" by "),
        { mention_user: { user_id: "ou_1" } },
        run_(" on "),
        { reminder: { expire_time: "1767225600000" } },
        run_("\nnext line")
      ])
    ]);
    expect(markdown).toBe("Area $\\pi r^2$ by @someone on 2026-01-01  \nnext line\n");
  });

  it("starts headings below the page's title when the document uses the top level", async () => {
    const withTop = await convert([
      { block_id: "h", block_type: 3, heading1: { elements: [run_("One")] } },
      { block_id: "i", block_type: 4, heading2: { elements: [run_("Two")] } },
      { block_id: "j", block_type: 11, heading9: { elements: [run_("Nine")] } }
    ]);
    expect(withTop.markdown).toBe("## One\n\n### Two\n\n###### Nine\n");
    const withoutTop = await convert([{ block_id: "i", block_type: 4, heading2: { elements: [run_("Two")] } }]);
    expect(withoutTop.markdown).toBe("## Two\n");
  });

  it("writes lists with what is under each item, one after the other", async () => {
    const nested: FeishuBlock = { block_id: "n", block_type: 12, bullet: { elements: [run_("under")] } };
    const { markdown } = await convert(
      [
        { block_id: "a", block_type: 12, bullet: { elements: [run_("one")] }, children: ["n"] },
        { block_id: "b", block_type: 12, bullet: { elements: [run_("two")] } },
        { block_id: "c", block_type: 13, ordered: { elements: [run_("first")] } },
        { block_id: "d", block_type: 17, todo: { elements: [run_("done")], style: { done: true } } },
        { block_id: "e", block_type: 17, todo: { elements: [run_("not yet")], style: { done: false } } },
        para("f", [run_("after")])
      ],
      [nested]
    );
    expect(markdown).toBe("- one\n  - under\n- two\n1. first\n- [x] done\n- [ ] not yet\n\nafter\n");
  });

  it("writes code in its language, with a fence that fits", async () => {
    const code = (language: number, text: string): FeishuBlock => ({
      block_id: `c${language}`,
      block_type: 14,
      code: { elements: [run_(text)], style: { language } }
    });
    const { markdown } = await convert([code(49, "print(1)\n"), code(63, "const a = 1;"), code(1, "```\nplain")]);
    expect(markdown).toBe("```python\nprint(1)\n```\n\n```typescript\nconst a = 1;\n```\n\n````\n```\nplain\n````\n");
  });

  it("keeps every language in the documented order", async () => {
    const { markdown } = await convert([
      { block_id: "a", block_type: 14, code: { elements: [run_("x")], style: { language: 75 } } },
      { block_id: "b", block_type: 14, code: { elements: [run_("x")], style: { language: 7 } } },
      { block_id: "c", block_type: 14, code: { elements: [run_("x")], style: { language: 22 } } }
    ]);
    expect(markdown).toBe("```toml\nx\n```\n\n```bash\nx\n```\n\n```go\nx\n```\n");
  });

  it("writes quotes, callouts by colour, dividers and columns", async () => {
    const inside = para("p", [run_("Inside")]);
    const left = para("l", [run_("Left")]);
    const right = para("r", [run_("Right")]);
    const { markdown } = await convert(
      [
        { block_id: "q", block_type: 15, quote: { elements: [run_("Said")] } },
        { block_id: "qc", block_type: 34, quote_container: {}, children: ["p2"] },
        { block_id: "c", block_type: 19, callout: { background_color: 2 }, children: ["p"] },
        { block_id: "d", block_type: 22, divider: {} },
        { block_id: "g", block_type: 24, grid: { column_size: 2 }, children: ["g1", "g2"] }
      ],
      [
        inside,
        left,
        right,
        para("p2", [run_("Quoted")]),
        { block_id: "g1", block_type: 25, grid_column: { width_ratio: 40 }, children: ["l"] },
        { block_id: "g2", block_type: 25, grid_column: { width_ratio: 60 }, children: ["r"] }
      ]
    );
    expect(markdown).toBe(
      '> Said\n\n> Quoted\n\n:::warning\n\nInside\n\n:::\n\n---\n\n::::columns\n\n:::column{width="0.40"}\n\nLeft\n\n:::\n\n:::column{width="0.60"}\n\nRight\n\n:::\n\n::::\n'
    );
    expect(parseDocument(markdown).diagnostics.filter(item => item.severity === "error")).toEqual([]);
  });

  it("makes outer fences longer than what is inside them", async () => {
    const { markdown } = await convert(
      [{ block_id: "o", block_type: 19, callout: { background_color: 4 }, children: ["i"] }],
      [{ block_id: "i", block_type: 19, callout: { background_color: 1 }, children: ["p"] }, para("p", [run_("Deep")])]
    );
    expect(markdown).toBe("::::tip\n\n:::danger\n\nDeep\n\n:::\n\n::::\n");
  });

  it("writes tables with the first row as the header, whatever is in the cells", async () => {
    const cell = (id: string, children: string[]): FeishuBlock => ({
      block_id: id,
      block_type: 32,
      table_cell: {},
      children
    });
    const { markdown, notes } = await convert(
      [
        {
          block_id: "t",
          block_type: 31,
          table: {
            cells: ["c1", "c2", "c3", "c4"],
            property: {
              row_size: 2,
              column_size: 2,
              merge_info: [
                { row_span: 1, col_span: 2 },
                { row_span: 1, col_span: 1 },
                { row_span: 1, col_span: 1 },
                { row_span: 1, col_span: 1 }
              ]
            }
          }
        }
      ],
      [
        cell("c1", ["a"]),
        cell("c2", []),
        cell("c3", ["b", "b2"]),
        cell("c4", ["d"]),
        para("a", [run_("Head|er")]),
        para("b", [run_("One")]),
        para("b2", [run_("Two")]),
        para("d", [run_("x", { bold: true })])
      ]
    );
    expect(markdown).toBe("| Head\\|er |  |\n| --- | --- |\n| One<br>Two | **x** |\n");
    expect(notes).toEqual(["A table had merged cells, which Markdown cannot show"]);
  });

  it("keeps pictures and files, and says when one could not be", async () => {
    const { markdown, media, notes } = await convert(
      [
        {
          block_id: "i",
          block_type: 27,
          image: { token: "pic", width: 100, height: 100, caption: { content: "A [view]" } }
        },
        { block_id: "v", block_type: 33, view: { view_type: 1 }, children: ["f"] },
        { block_id: "b", block_type: 27, image: { token: "broken" } }
      ],
      [{ block_id: "f", block_type: 23, file: { token: "doc", name: "Report.pdf" } }]
    );
    expect(media).toEqual(["pic:pic.png", "doc:Report.pdf", "broken:broken.png"]);
    expect(markdown).toContain("![A  view ](assets/pic.png)");
    expect(markdown).toContain('::file[Report.pdf]{src="assets/doc.png"}');
    expect(markdown).toContain("A picture is not here. See the [original](https://example.feishu.cn/wiki/abc).");
    expect(notes).toEqual(["A picture was left out"]);
  });

  it("leaves a note with the way back for what cannot come over, once in the report for each kind", async () => {
    const { markdown, notes } = await convert([
      { block_id: "s", block_type: 30, sheet: { token: "a_b" } },
      { block_id: "s2", block_type: 30, sheet: { token: "c_d" } },
      { block_id: "b", block_type: 43, board: { token: "x" } },
      { block_id: "d", block_type: 43, board: { token: "drawn" } },
      { block_id: "u", block_type: 999, undefined: {} },
      { block_id: "w", block_type: 700 }
    ]);
    expect(markdown).toContain("A spreadsheet is not here. See the [original](https://example.feishu.cn/wiki/abc).");
    expect(markdown).toContain("A whiteboard is not here.");
    expect(markdown).toContain("![](assets/drawn.png)");
    expect(notes).toEqual([
      "A spreadsheet was left out",
      "A whiteboard was left out",
      "Something this version cannot read was left out"
    ]);
  });

  it("uses this site's subpage list where the document has one, and skips the empty lines it uses for spacing", async () => {
    const { markdown } = await convert([
      para("a", []),
      { block_id: "l", block_type: 51, sub_page_list: { wiki_token: "x" } },
      para("b", [run_("")]),
      para("c", [run_("End")])
    ]);
    expect(markdown).toBe("::subpages\n\nEnd\n");
  });

  it("writes an address as a link", async () => {
    const { markdown } = await convert([
      {
        block_id: "i",
        block_type: 26,
        iframe: { component: { iframe_type: 8, url: "https%3A%2F%2Fwww.figma.com%2Ffile%2Fabc" } }
      }
    ]);
    expect(markdown).toBe("[Embedded page](https://www.figma.com/file/abc)\n");
  });
});

describe("reading from Feishu", () => {
  const answer = (data: object, init: ResponseInit = {}) =>
    new Response(JSON.stringify({ code: 0, msg: "success", data }), {
      headers: { "content-type": "application/json" },
      ...init
    });
  const failure = (code: number, status = 400) =>
    new Response(JSON.stringify({ code, msg: `failed with ${code}` }), {
      status,
      headers: { "content-type": "application/json" }
    });
  const text = (content: string) => ({ elements: [{ text_run: { content } }] });
  const document = (id: string, ...children: FeishuBlock[]) => [
    { block_id: id, block_type: 1, page: text(""), children: children.map(block => block.block_id) },
    ...children
  ];
  const node = (token: string, title: string, extra: object = {}) => ({
    space_id: "sp1",
    node_token: token,
    obj_token: `doc-${token}`,
    obj_type: "docx",
    node_type: "origin",
    has_child: false,
    title,
    ...extra
  });

  /** The endpoints as documented, answering from what a test gives it. */
  function fakeApi(input: {
    nodes?: Record<string, ReturnType<typeof node>>;
    children?: Record<string, ReturnType<typeof node>[]>;
    blocks?: Record<string, FeishuBlock[]>;
    titles?: Record<string, string>;
    media?: Record<string, Uint8Array>;
  }) {
    const calls: string[] = [];
    let issued = 0;
    const overrides: ((path: string) => Response | null)[] = [];
    const fetcher: typeof fetch = async (target, init) => {
      const url = new URL(String(target));
      calls.push(`${url.pathname}${url.search}`);
      for (const override of overrides) {
        const replaced = override(url.pathname);
        if (replaced) return replaced;
      }
      if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
        const body = JSON.parse(String(init?.body)) as { app_id: string; app_secret: string };
        if (body.app_id !== "cli_test" || body.app_secret !== "secret") return failure(10003);
        issued += 1;
        return new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: `t-${issued}`, expire: 7200 }), {
          headers: { "content-type": "application/json" }
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer t-\d+$/u);
      if (url.pathname === "/open-apis/wiki/v2/spaces/get_node") {
        const found = input.nodes?.[url.searchParams.get("token")!];
        return found ? answer({ node: found }) : failure(131005, 404);
      }
      const nodes = /^\/open-apis\/wiki\/v2\/spaces\/([^/]+)\/nodes$/u.exec(url.pathname);
      if (nodes) {
        const all = input.children?.[url.searchParams.get("parent_node_token") ?? ""] ?? [];
        // A page at a time, and an empty first page is allowed.
        const start = Number(url.searchParams.get("page_token") ?? 0);
        if (start === 0 && all.length > 1) return answer({ items: [], has_more: true, page_token: "1" });
        const at = Math.max(0, start - 1);
        return answer({
          items: all.slice(at, at + 1),
          has_more: at + 1 < all.length,
          ...(at + 1 < all.length ? { page_token: String(at + 2) } : {})
        });
      }
      const blocks = /^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks$/u.exec(url.pathname);
      if (blocks) {
        const all = input.blocks?.[blocks[1]!] ?? [];
        const start = Number(url.searchParams.get("page_token") ?? 0);
        return answer({
          items: all.slice(start, start + 2),
          has_more: start + 2 < all.length,
          ...(start + 2 < all.length ? { page_token: String(start + 2) } : {})
        });
      }
      const info = /^\/open-apis\/docx\/v1\/documents\/([^/]+)$/u.exec(url.pathname);
      if (info)
        return answer({ document: { document_id: info[1], revision_id: 1, title: input.titles?.[info[1]!] ?? "" } });
      const media = /^\/open-apis\/drive\/v1\/medias\/([^/]+)\/download$/u.exec(url.pathname);
      if (media) {
        const bytes = input.media?.[media[1]!];
        return bytes
          ? new Response(bytes as BodyInit, {
              headers: { "content-type": "image/png", "content-disposition": `attachment; filename="${media[1]}.png"` }
            })
          : failure(1061004, 404);
      }
      return failure(404, 404);
    };
    return { fetcher, calls, overrides, issued: () => issued };
  }
  const importerWith = (api: ReturnType<typeof fakeApi>, slept: number[] = []) =>
    createFeishuImporter(
      { appId: "cli_test", appSecret: "secret", baseUrl: "https://open.feishu.cn" },
      {
        fetch: api.fetcher,
        sleep: async ms => {
          slept.push(ms);
        }
      }
    );

  it("knows what an address points at", () => {
    expect(parseFeishuAddress("https://example.feishu.cn/wiki/AbC123?from=x")).toEqual({
      kind: "wiki",
      token: "AbC123"
    });
    expect(parseFeishuAddress("https://example.feishu.cn/docx/AbC123#share")).toEqual({
      kind: "docx",
      token: "AbC123"
    });
    expect(parseFeishuAddress("https://example.larksuite.com/wiki/settings/712345")).toEqual({
      kind: "space",
      id: "712345"
    });
    expect(parseFeishuAddress("https://example.feishu.cn/wiki/space/712345")).toEqual({ kind: "space", id: "712345" });
    expect(() => parseFeishuAddress("https://example.feishu.cn/sheets/abc")).toThrow(PermanentIngestError);
    expect(() => parseFeishuAddress("nonsense")).toThrow(PermanentIngestError);
  });

  it("imports one document by its address, reading all its blocks", async () => {
    const api = fakeApi({
      titles: { d1: "Returns" },
      media: { pic: PNG },
      blocks: {
        d1: document(
          "d1",
          { block_id: "a", block_type: 2, text: text("Seven days.") },
          { block_id: "b", block_type: 2, text: text("Second.") },
          { block_id: "c", block_type: 27, image: { token: "pic" } }
        )
      }
    });
    const { pages, assets, expected } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(pages).toMatchObject([
      { path: "returns", title: "Returns", markdown: "Seven days.\n\nSecond.\n\n![](assets/1.png)\n" }
    ]);
    expect(assets).toMatchObject([{ name: "pic.png" }]);
    expect(expected()).toBe(1);
    expect(api.calls.filter(call => call.includes("/blocks"))).toHaveLength(2);
  });

  it("imports a page in a knowledge base and those under it, parents first, in their order, linking between them", async () => {
    const api = fakeApi({
      nodes: { root: node("root", "Handbook", { has_child: true }) },
      children: {
        root: [node("first", "第一章", { has_child: true }), node("second", "Second")],
        first: [node("deep", "Deep")]
      },
      blocks: {
        "doc-root": document("doc-root", {
          block_id: "a",
          block_type: 2,
          text: {
            elements: [
              { mention_doc: { token: "doc-deep", obj_type: 22, url: "x", title: "Deep" } },
              { text_run: { content: " and " } },
              {
                text_run: {
                  content: "second",
                  text_element_style: { link: { url: "https%3A%2F%2Fexample.feishu.cn%2Fwiki%2Fsecond" } }
                }
              }
            ]
          }
        }),
        "doc-first": document("doc-first"),
        "doc-deep": document("doc-deep", {
          block_id: "b",
          block_type: 2,
          text: {
            elements: [
              {
                text_run: {
                  content: "up",
                  text_element_style: { link: { url: "https%3A%2F%2Fexample.feishu.cn%2Fwiki%2Froot" } }
                }
              }
            ]
          }
        }),
        "doc-second": document("doc-second")
      }
    });
    const { pages } = await run(importerWith(api), {
      url: "https://example.feishu.cn/wiki/root",
      includeChildren: true
    });
    expect(pages.map(page => [page.path, page.title, page.sortOrder])).toEqual([
      ["handbook", "Handbook", 10],
      ["handbook/first", "第一章", 10],
      ["handbook/first/deep", "Deep", 10],
      ["handbook/second", "Second", 20]
    ]);
    expect(pages[0]!.markdown).toBe("[Deep](./handbook/first/deep.md) and [second](./handbook/second.md)\n");
    expect(pages[2]!.markdown).toBe("[up](../../handbook.md)\n");
  });

  it("stays on the page when not asked for what is under it", async () => {
    const api = fakeApi({
      nodes: { root: node("root", "Handbook", { has_child: true }) },
      children: { root: [node("first", "First")] },
      blocks: { "doc-root": document("doc-root") }
    });
    const { pages } = await run(importerWith(api), { url: "https://example.feishu.cn/wiki/root" });
    expect(pages.map(page => page.path)).toEqual(["handbook"]);
  });

  it("imports a whole knowledge base from its settings page", async () => {
    const api = fakeApi({
      children: { "": [node("a", "A"), node("b", "B")] },
      blocks: { "doc-a": document("doc-a"), "doc-b": document("doc-b") }
    });
    const { pages } = await run(importerWith(api), { url: "https://example.feishu.cn/wiki/settings/712345" });
    expect(pages.map(page => page.path)).toEqual(["a", "b"]);
    expect(api.calls.some(call => call.startsWith("/open-apis/wiki/v2/spaces/712345/nodes"))).toBe(true);
  });

  it("holds a place with a link for what is not a document, and goes on to what is under it", async () => {
    const api = fakeApi({
      children: {
        "": [node("s", "Numbers", { obj_type: "sheet", has_child: true }), node("o", "Old", { obj_type: "doc" })],
        s: [node("u", "Under")]
      },
      blocks: { "doc-u": document("doc-u") }
    });
    const { pages, notes } = await run(importerWith(api), { url: "https://example.feishu.cn/wiki/settings/712345" });
    expect(pages.map(page => page.path)).toEqual(["numbers", "numbers/under", "old"]);
    expect(pages[0]!.markdown).toContain(
      "A spreadsheet is not here. See the [original](https://example.feishu.cn/wiki/s)."
    );
    expect(notes.map(item => item.file)).toEqual(["Numbers", "Old"]);
    expect(notes[1]!.reason).toContain("A document in the old format");
  });

  it("does not bring the same thing twice through a shortcut", async () => {
    const api = fakeApi({
      children: {
        "": [node("a", "A"), { ...node("short", "A again", { node_type: "shortcut" }), obj_token: "doc-a" }]
      },
      blocks: { "doc-a": document("doc-a") }
    });
    const { pages } = await run(importerWith(api), { url: "https://example.feishu.cn/wiki/settings/712345" });
    expect(pages.map(page => page.title)).toEqual(["A"]);
  });

  it("asks for a new token when the old one runs out, and only then", async () => {
    const api = fakeApi({ titles: { d1: "T" }, blocks: { d1: document("d1") } });
    let refused = 0;
    api.overrides.push(path => {
      if (path.endsWith("/blocks") && refused === 0) {
        refused += 1;
        return failure(99991663);
      }
      return null;
    });
    await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(api.issued()).toBe(2);
  });

  it("slows down when told to, and goes on", async () => {
    const api = fakeApi({ titles: { d1: "T" }, blocks: { d1: document("d1") } });
    let refused = 0;
    api.overrides.push(path => {
      if (path.endsWith("/blocks") && refused < 2) {
        refused += 1;
        return refused === 1 ? failure(99991400) : new Response("", { status: 429 });
      }
      return null;
    });
    const slept: number[] = [];
    const { pages } = await run(importerWith(api, slept), { url: "https://example.feishu.cn/docx/d1" });
    expect(pages).toHaveLength(1);
    expect(slept).toEqual(expect.arrayContaining([5000, 10000]));
  });

  it("keeps to their limits without being told", async () => {
    const api = fakeApi({
      children: { "": [node("a", "A"), node("b", "B"), node("c", "C")] },
      blocks: { "doc-a": document("doc-a"), "doc-b": document("doc-b"), "doc-c": document("doc-c") }
    });
    const slept: number[] = [];
    await run(importerWith(api, slept), { url: "https://example.feishu.cn/wiki/settings/712345" });
    expect(slept.length).toBeGreaterThan(0);
  });

  it("says plainly what to do about having no access, and does not try again", async () => {
    const api = fakeApi({});
    api.overrides.push(path => (path.endsWith("/get_node") ? failure(131006, 403) : null));
    const error = await run(importerWith(api), { url: "https://example.feishu.cn/wiki/x" }).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(PermanentIngestError);
    expect((error as Error).message).toContain("The app has no access");
  });

  it("says when the app itself is not accepted", async () => {
    const api = fakeApi({});
    const importer = createFeishuImporter(
      { appId: "cli_wrong", appSecret: "secret", baseUrl: "https://open.feishu.cn" },
      { fetch: api.fetcher, sleep: async () => undefined }
    );
    await expect(run(importer, { url: "https://example.feishu.cn/docx/d1" })).rejects.toThrow(
      /did not accept the app/u
    );
  });

  it("brings a whiteboard as a picture, and leaves a note if the app may not read it", async () => {
    const api = fakeApi({
      titles: { d1: "T" },
      blocks: {
        d1: document(
          "d1",
          { block_id: "a", block_type: 43, board: { token: "good" } },
          { block_id: "b", block_type: 43, board: { token: "closed" } }
        )
      }
    });
    api.overrides.push(path => {
      if (path.endsWith("/good/download_as_image"))
        return new Response(PNG as BodyInit, { headers: { "content-type": "image/png" } });
      if (path.endsWith("/closed/download_as_image")) return failure(99991672, 403);
      return null;
    });
    const { pages, notes, assets } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(assets).toMatchObject([{ name: "good.png" }]);
    expect(pages[0]!.markdown).toContain("![](assets/1.png)");
    expect(pages[0]!.markdown).toContain("A whiteboard is not here.");
    expect(notes.map(item => item.reason)).toEqual(["A whiteboard was left out"]);
  });

  it("carries on without a picture it may not read, rather than losing the rest of the page", async () => {
    const api = fakeApi({
      titles: { d1: "T" },
      blocks: {
        d1: document(
          "d1",
          { block_id: "i", block_type: 27, image: { token: "closed" } },
          { block_id: "t", block_type: 2, text: text("Rest") }
        )
      }
    });
    api.overrides.push(path => (path.includes("/medias/") ? failure(1061004, 403) : null));
    const { pages } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(pages[0]!.markdown).toContain("Rest");
  });

  it("carries on without a picture it cannot download, and notes it", async () => {
    const api = fakeApi({
      titles: { d1: "T" },
      blocks: {
        d1: document(
          "d1",
          { block_id: "i", block_type: 27, image: { token: "missing" } },
          { block_id: "t", block_type: 2, text: text("Rest") }
        )
      }
    });
    api.overrides.push(path => (path.includes("/medias/") ? new Response("", { status: 404 }) : null));
    const { pages, notes } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(pages[0]!.markdown).toContain("Rest");
    expect(notes.map(item => item.reason)).toEqual(
      expect.arrayContaining(["A file could not be downloaded: missing.png"])
    );
  });

  it("leaves out a file bigger than the site would keep, and carries on", async () => {
    const api = fakeApi({
      titles: { d1: "T" },
      blocks: {
        d1: document(
          "d1",
          { block_id: "i", block_type: 27, image: { token: "huge" } },
          { block_id: "t", block_type: 2, text: text("Rest") }
        )
      }
    });
    // No length is declared, so the refusal has to come from watching the bytes arrive.
    api.overrides.push(path =>
      path.includes("/medias/") ? new Response(new Uint8Array(100 * 1024 * 1024 + 1) as BodyInit) : null
    );
    const { pages, notes, assets } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(pages[0]!.markdown).toContain("Rest");
    expect(assets).toEqual([]);
    expect(notes.map(item => item.reason)).toEqual(
      expect.arrayContaining(["A file is larger than 100 MiB and was left out: huge.png"])
    );
  });

  it("leaves out an oversized whiteboard before reading it", async () => {
    const api = fakeApi({
      titles: { d1: "T" },
      blocks: {
        d1: document("d1", { block_id: "a", block_type: 43, board: { token: "poster" } })
      }
    });
    api.overrides.push(path =>
      path.endsWith("/poster/download_as_image")
        ? new Response(new Uint8Array(0) as BodyInit, {
            headers: { "content-type": "image/png", "content-length": String(100 * 1024 * 1024 + 1) }
          })
        : null
    );
    const { notes } = await run(importerWith(api), { url: "https://example.feishu.cn/docx/d1" });
    expect(notes.map(item => item.reason)).toEqual(
      expect.arrayContaining(["A file is larger than 100 MiB and was left out: poster.png"])
    );
  });
});
