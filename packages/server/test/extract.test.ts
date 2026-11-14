import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractToMarkdown, UnconvertibleError } from "../src/extract/convert.js";
import { shownNumber } from "../src/extract/ooxml.js";
import {
  createExtractProcessor,
  extractWithFallback,
  extractWithService,
  type Extractor
} from "../src/extract/processor.js";
import { outlineOf, parseDocument, squashWhitespace, visibleText } from "@pandocs/markdown";
import {
  blankPdf,
  cidPdf,
  docx,
  docxNumberedAndBookmarked,
  pdf,
  pptx,
  pptxReordered,
  xlsx,
  xlsxFormats
} from "./office-files.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const convert = (bytes: Uint8Array, contentType: string, filename = "文件") =>
  extractToMarkdown({ bytes, contentType, filename });

describe("turning files into Markdown", () => {
  it("reads Word: headings, emphasis and tables, and pulls out its images", async () => {
    const { markdown, files, warnings } = await convert(docx(), DOCX);
    expect(markdown).toContain("七天内可以**无理由**退货");
    expect(markdown).toMatch(/\| *类别 *\| *期限 *\|/u);
    expect(markdown).toMatch(/\| *图书 *\| *七天 *\|/u);
    expect(files).toHaveLength(1);
    expect(files[0]!.filename).toMatch(/^[a-f0-9]{64}\.png$/u);
    expect(markdown).toContain(`assets/${files[0]!.filename}`);
    expect(warnings).toEqual([]);
  });

  it("reads Excel, each sheet under its name, and keeps a | in a cell from breaking the table", async () => {
    const { markdown } = await convert(xlsx(), XLSX);
    expect(markdown).toContain("## 库存");
    expect(markdown).toContain("## 价格");
    expect(markdown).toContain("| 书名 | 数量 |");
    expect(markdown).toContain("| 红楼梦 \\| 第一册 | 12 |");
    expect(markdown).toContain("| 红楼梦 \\| 第一册 | 39.5 |");
  });

  it("reads PowerPoint in slide order, not the order of the file", async () => {
    const { markdown } = await convert(pptx(), PPTX);
    expect(markdown.split("\n").filter(line => line.startsWith("## "))).toEqual([
      "## 季度回顾",
      "## 下一步",
      "## 附录"
    ]);
    expect(markdown).toContain("- 收入增长");
    expect(markdown).toContain("- 联系 & 跟进");
  });

  it("reads PowerPoint in the order the deck plays, which moving slides changes and file names do not", async () => {
    const { markdown } = await convert(pptxReordered(), PPTX);
    expect(markdown.split("\n").filter(line => line.startsWith("## "))).toEqual([
      "## 1. Receive the return",
      "## 2. Inspect the parcel",
      "## 3. Notify the customer"
    ]);
  });

  it("shows numbers in Excel as their cells show them: a time of day, a percentage, a date", async () => {
    const { markdown } = await convert(xlsxFormats(), XLSX);
    expect(markdown).toContain("| 09:00 | 97.5% | 2026-11-09 | 100.00% |");
    expect(markdown).toContain("| 17:30 | 100.0% | 2026-11-10 | 50.00% |");
    expect(markdown).not.toContain("1899");
  });

  it.each([
    [0.375, "h:mm AM/PM", "9:00 AM"],
    [0.75, 'h"时"mm"分"', "18时00分"],
    [0.5, "[$-804]上午/下午h:mm", "下午12:00"],
    [1.5, "[h]:mm:ss", "36:00:00"],
    [60.04 / 86400, "mm:ss.0", "01:00.0"],
    [-0.05, "0.00%;[Red]-0.00%", "-5.00%"],
    [0.125, "0%", "13%"],
    [46335.5, "yyyy-mm-dd hh:mm", undefined],
    [3, "0.00", undefined]
  ])("shows %s through %s as %s", (value, format, shown) => {
    expect(shownNumber(value, format)).toBe(shown);
  });

  it("reads a PDF in a Chinese font it does not carry", async () => {
    const { markdown, warnings } = await convert(
      cidPdf("银杏退款确认书：收到退货后两个工作日内原路退款"),
      "application/pdf"
    );
    expect(markdown).toContain("银杏退款确认书");
    expect(warnings).toEqual([]);
  });

  it("keeps where a Word list starts, and a link to a bookmark that leads to its heading", async () => {
    const { markdown } = await convert(docxNumberedAndBookmarked(), DOCX);
    expect(markdown).toMatch(/^5\. +Check the parcel\.$/mu);
    expect(markdown).toMatch(/^7\. +Hand it over\.$/mu);
    // The list goes on after the note, and the same list used again restarts where it says.
    expect(markdown).toMatch(/^8\. +File the form\.$/mu);
    expect(markdown).toMatch(/^1\. +Call the supervisor\.$/mu);
    expect(markdown).toMatch(/^2\. +Call the customer\.$/mu);
    const slug = outlineOf(parseDocument(markdown)).find(entry => entry.text === "Escalation steps")!.slug;
    expect(markdown).toContain(`[Jump to escalation steps](#${slug})`);
  });

  it("keeps a link to a part of an HTML page leading to that part", async () => {
    const html =
      '<html><body><p><a href="#return-process">Returns</a></p><h2 id="return-process">退回处理</h2><p>先登记。</p></body></html>';
    const { markdown } = await convert(strToU8(html), "text/html");
    const slug = outlineOf(parseDocument(markdown)).find(entry => entry.text === "退回处理")!.slug;
    expect(markdown).toContain(`[Returns](#${slug})`);
  });

  it("points a link at the heading a mark stands for, as the page numbers a repeated heading, and leaves other links be", async () => {
    const html =
      '<p><a href="#again">Again</a> <a href="#note">Note</a></p><h2>步骤</h2><p>一</p><p><a name="again"></a></p><h2>步骤</h2><p id="note">注意</p>';
    const { markdown } = await convert(strToU8(html), "text/html");
    const [first, second] = outlineOf(parseDocument(markdown)).map(entry => entry.slug);
    expect(second).not.toBe(first);
    expect(markdown).toContain(`[Again](#${second})`);
    expect(markdown).toContain("[Note](#note)");
    expect(markdown).not.toMatch(/[\uE000-\uE005]/u);
  });

  it("reads HTML in the encoding the page declares", async () => {
    // <meta charset="gbk"><p>退货</p>, as an older Chinese site serves it.
    const page = new Uint8Array([...strToU8('<meta charset="gbk"><p>'), 0xcd, 0xcb, 0xbb, 0xf5, ...strToU8("</p>")]);
    const { markdown, warnings } = await convert(page, "text/html");
    expect(markdown).toBe("退货");
    expect(warnings).toEqual([]);
  });

  it("reads the text of a PDF, and says so when there is none", async () => {
    const { markdown } = await convert(pdf("Return within seven days"), "application/pdf");
    expect(markdown).toContain("Return within seven days");
    const blank = await convert(blankPdf(), "application/pdf");
    expect(blank.markdown).toBe("");
    expect(blank.warnings[0]).toContain("almost no text");
  });

  it("reads HTML without its scripts, and takes the title from it", async () => {
    const page =
      "<!doctype html><html><head><title>页面标题</title><style>p{color:red}</style></head><body><script>alert(1)</script><h1>正文标题</h1><p>第一段 <a href='https://example.com'>链接</a></p><table><tr><th>甲</th></tr><tr><td>乙</td></tr></table></body></html>";
    const { markdown, title } = await convert(strToU8(page), "text/html");
    expect(title).toBe("页面标题");
    expect(markdown).toContain("# 正文标题");
    expect(markdown).toContain("[链接](https://example.com)");
    expect(markdown).toMatch(/\| *甲 *\|/u);
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("color:red");
  });

  it("does not take a page's title for its text, even when the page has no head", async () => {
    const { markdown, title } = await convert(
      strToU8("<!doctype html><title>说明</title><h1>标题</h1><p>正文</p>"),
      "text/html"
    );
    expect(title).toBe("说明");
    expect(markdown).toBe("# 标题\n\n正文");
  });

  it("turns any HTML table into a Markdown one, which needs a header row whether or not it had one", async () => {
    const page =
      "<table><tr><td colspan='2'><p>合并的表头</p></td></tr><tr><td><p>有<b>粗体</b>和 | 竖线</p></td><td><p>第一行</p><p>第二行</p></td></tr></table>";
    const { markdown } = await convert(strToU8(page), "text/html");
    expect(markdown).toBe("| 合并的表头 |  |\n| --- | --- |\n| 有**粗体**和 \\| 竖线 | 第一行<br>第二行 |");
  });

  it("reads CSV with quotes and line breaks in cells, whichever separator it uses", async () => {
    const comma = await convert(
      strToU8('书名,说明\n"红楼梦,第一册","第一行\n第二行"\n西游记,"他说""好"""\n'),
      "text/csv"
    );
    expect(comma.markdown).toBe(
      '| 书名 | 说明 |\n| --- | --- |\n| 红楼梦,第一册 | 第一行<br>第二行 |\n| 西游记 | 他说"好" |'
    );
    const tabs = await convert(strToU8("甲\t乙\n1\t2\n"), "text/csv");
    expect(tabs.markdown).toBe("| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |");
  });

  it("reads CSV in the encodings Chinese spreadsheets are saved in, and says when it had to guess", async () => {
    // 客户,金额 / 星河,1 in GB18030, as Excel saves CSV on a Chinese Windows.
    const gb18030 = new Uint8Array([
      0xbf, 0xcd, 0xbb, 0xa7, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xd0, 0xc7, 0xba, 0xd3, 0x2c, 0x31, 0x0a
    ]);
    const guessed = await convert(gb18030, "text/csv");
    expect(guessed.markdown).toContain("| 星河 | 1 |");
    expect(guessed.warnings.join()).toContain("GB18030");
    const utf16 = [..."客户,金额\nRiver,1\n"].flatMap(character => {
      const code = character.charCodeAt(0);
      return [code & 0xff, code >> 8];
    });
    expect((await convert(new Uint8Array([0xff, 0xfe, ...utf16]), "text/csv")).markdown).toContain("| River | 1 |");
    // Without the mark, as some exports write it: read the same, said to be a guess, and with no zero bytes left to refuse.
    const unmarked = await convert(new Uint8Array(utf16), "text/csv");
    expect(unmarked.markdown).toContain("| River | 1 |");
    expect(unmarked.markdown).not.toContain("\0");
    expect(unmarked.warnings.join()).toContain("UTF-16");
  });

  it("keeps what is in a CSV cell as text, whatever it would mean in Markdown", async () => {
    const cells = [
      "<PENDING>",
      "*07*",
      "<br>",
      "[登记表](./form.md)",
      "_x_",
      "`code`",
      "~~del~~",
      "$$x$$",
      "^sup^",
      "H~2~O",
      ":tag[x]",
      "# 不是标题",
      "1. 不是列表",
      "&amp;",
      "R&D 09:00"
    ];
    const csv = `值\n${cells.map(cell => `"${cell}"`).join("\n")}\n`;
    const { markdown } = await convert(strToU8(csv), "text/csv");
    const shown = squashWhitespace(visibleText(parseDocument(markdown)));
    for (const cell of cells) expect(shown, cell).toContain(squashWhitespace(cell));
  });

  it("cuts a huge table down, and says so", async () => {
    const rows = ["甲,乙", ...Array.from({ length: 6000 }, (_, index) => `${index},${index}`)].join("\n");
    const { markdown, warnings } = await convert(strToU8(rows), "text/csv");
    expect(markdown.split("\n").length).toBe(5001);
    expect(warnings[0]).toContain("only the first 5000");
  });

  describe("files it cannot do", () => {
    const refused = async (bytes: Uint8Array, contentType: string) => {
      const error = await convert(bytes, contentType).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(UnconvertibleError);
      return (error as UnconvertibleError).code;
    };

    it("says so rather than guessing", async () => {
      expect(await refused(strToU8("old"), "application/msword")).toBe("OLD_OFFICE_FORMAT");
      expect(await refused(strToU8("?"), "application/x-unknown")).toBe("CONTENT_TYPE_UNSUPPORTED");
      expect(await refused(strToU8("not a zip"), DOCX)).toBe("FILE_DAMAGED");
      expect(await refused(strToU8("%PDF-broken"), "application/pdf")).toBe("FILE_DAMAGED");
    });

    it("refuses a zip that would unpack to something enormous, before unpacking it", async () => {
      const { zipSync } = await import("fflate");
      // A real bomb takes a long time to build, so this is the same shape with the size in the header filled in.
      const bomb = zipSync({ "word/document.xml": strToU8("x") });
      const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength);
      const huge = 2 * 1024 * 1024 * 1024;
      for (let at = 0; at < bomb.length - 4; at += 1) {
        const signature = view.getUint32(at, true);
        if (signature === 0x04034b50) view.setUint32(at + 22, huge, true);
        if (signature === 0x02014b50) view.setUint32(at + 24, huge, true);
      }
      expect(await refused(bomb, DOCX)).toBe("FILE_TOO_LARGE");
    });
  });
});

describe("a conversion service", () => {
  const withService = async (
    respond: (request: Request) => Response | Promise<Response>,
    work: (url: string, seen: Request[]) => Promise<void>
  ) => {
    const seen: Request[] = [];
    const { createServer } = await import("node:http");
    const { Readable } = await import("node:stream");
    const server = createServer((incoming, outgoing) => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(chunk as Buffer));
      incoming.on("end", () => {
        const request = new Request("http://service.test/", {
          method: incoming.method!,
          headers: incoming.headers as Record<string, string>,
          body: Buffer.concat(chunks)
        });
        seen.push(request.clone());
        void Promise.resolve(respond(request)).then(response => {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) Readable.fromWeb(response.body as never).pipe(outgoing);
          else outgoing.end();
        });
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    try {
      await work(`http://127.0.0.1:${(server.address() as { port: number }).port}/convert`, seen);
    } finally {
      await new Promise(done => server.close(done));
    }
  };

  it("gets the file, and can answer with plain Markdown or JSON", async () => {
    await withService(
      () => new Response("# 转好了\n", { headers: { "content-type": "text/markdown" } }),
      async (url, seen) => {
        const extract = extractWithService({ url, token: "secret-token" });
        const result = await extract({
          bytes: strToU8("字节"),
          contentType: "application/pdf",
          filename: "季度 报告.pdf"
        });
        expect(result.markdown).toBe("# 转好了\n");
        const request = seen[0]!;
        expect(request.headers.get("authorization")).toBe("Bearer secret-token");
        expect(request.headers.get("content-type")).toBe("application/pdf");
        expect(decodeURIComponent(request.headers.get("x-filename")!)).toBe("季度 报告.pdf");
        expect(request.headers.get("accept-language")).toBe("en");
        expect(await request.text()).toBe("字节");
      }
    );
    await withService(
      () => Response.json({ markdown: "正文", title: "标题", warnings: ["注意"] }),
      async url => {
        expect(
          await extractWithService({ url })({ bytes: strToU8("x"), contentType: "text/csv", filename: "a" })
        ).toEqual({ markdown: "正文", title: "标题", warnings: ["注意"], files: [] });
      }
    );
  });

  it("keeps the images the service took out, when each is what its name says", async () => {
    const image = new Uint8Array(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
        "base64"
      )
    );
    const sha256 = createHash("sha256").update(image).digest("hex");
    const data = Buffer.from(image).toString("base64");
    await withService(
      () =>
        Response.json({
          markdown: `![示意图](assets/${sha256}.png)`,
          files: [
            { path: `assets/${sha256}.png`, data },
            { path: `assets/${"0".repeat(64)}.png`, data },
            { path: "../outside.png", data },
            "not an image"
          ]
        }),
      async url => {
        const result = await extractWithService({ url })({
          bytes: strToU8("x"),
          contentType: "application/pdf",
          filename: "a.pdf"
        });
        expect(result.files).toEqual([{ bytes: image, filename: `${sha256}.png` }]);
        expect(result.warnings).toEqual(["3 images from the conversion service could not be kept"]);
      }
    );
  });

  it("treats a refusal as final, and anything else as worth another try", async () => {
    const { PermanentIngestError } = await import("@pandocs/core");
    await withService(
      () => new Response("no", { status: 415 }),
      async url => {
        await expect(
          extractWithService({ url })({ bytes: strToU8("x"), contentType: "a", filename: "a" })
        ).rejects.toBeInstanceOf(PermanentIngestError);
      }
    );
    await withService(
      () => Response.json({ error: "Old Office formats need LibreOffice" }, { status: 415 }),
      async url => {
        await expect(
          extractWithService({ url })({ bytes: strToU8("x"), contentType: "a", filename: "a" })
        ).rejects.toMatchObject({
          message: "The conversion service could not convert the file: Old Office formats need LibreOffice"
        });
      }
    );
    await withService(
      () => new Response("down", { status: 503 }),
      async url => {
        const failure = await extractWithService({ url })({
          bytes: strToU8("x"),
          contentType: "a",
          filename: "a"
        }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(PermanentIngestError);
      }
    );
  });

  describe("only for what the built-in conversion cannot read", () => {
    const input = { bytes: strToU8("x"), contentType: "application/pdf", filename: "a.pdf" };
    const fromService = { markdown: "服务认出的文字", warnings: [], files: [] };
    const counting = (answer: Extractor) => {
      const calls: string[] = [];
      return {
        calls,
        extract: (async received => {
          calls.push(received.filename);
          return answer(received);
        }) as Extractor
      };
    };

    it("keeps what the built-in conversion read, and asks the service about a scan", async () => {
      const service = counting(async () => fromService);
      expect(
        await extractWithFallback(async () => ({ markdown: "正文", warnings: [], files: [] }), service.extract)(input)
      ).toEqual({ markdown: "正文", warnings: [], files: [] });
      expect(service.calls).toEqual([]);
      const scan = { markdown: "", warnings: ["可能是扫描件"], files: [], scanned: true };
      expect(await extractWithFallback(async () => scan, service.extract)(input)).toEqual(fromService);
      expect(service.calls).toEqual(["a.pdf"]);
    });

    it("asks the service about an old Office format, and passes on anything else wrong with the file", async () => {
      const { PermanentIngestError } = await import("@pandocs/core");
      const service = counting(async () => fromService);
      const refusing =
        (code: string): Extractor =>
        async () => {
          throw new PermanentIngestError(code, code);
        };
      expect(await extractWithFallback(refusing("OLD_OFFICE_FORMAT"), service.extract)(input)).toEqual(fromService);
      expect(
        await extractWithFallback(async () => {
          throw new UnconvertibleError("OLD_OFFICE_FORMAT", "旧格式");
        }, service.extract)(input)
      ).toEqual(fromService);
      await expect(extractWithFallback(refusing("FILE_DAMAGED"), service.extract)(input)).rejects.toMatchObject({
        code: "FILE_DAMAGED"
      });
      expect(service.calls).toHaveLength(2);
    });

    it("leaves a scan as it was when the service says no, and tries again when it is down", async () => {
      const { PermanentIngestError } = await import("@pandocs/core");
      const scan = { markdown: "", warnings: ["可能是扫描件"], files: [], scanned: true };
      expect(
        await extractWithFallback(
          async () => scan,
          async () => {
            throw new PermanentIngestError("EXTRACT_REFUSED", "no");
          }
        )(input)
      ).toEqual(scan);
      const down = await extractWithFallback(
        async () => scan,
        async () => {
          throw new Error("The conversion service returned 503");
        }
      )(input).catch((error: unknown) => error);
      expect(down).toBeInstanceOf(Error);
      expect(down).not.toBeInstanceOf(PermanentIngestError);
    });

    it("is turned on with PANDOCS_EXTRACT_FALLBACK", async () => {
      const { readConfig } = await import("../src/config.js");
      const env = {
        DATABASE_URL: "postgres://x",
        PANDOCS_URL: "http://x.test",
        PANDOCS_EXTRACT_URL: "http://converter:8090/convert"
      };
      expect(readConfig(env).extract).toEqual({
        url: "http://converter:8090/convert",
        token: undefined,
        fallback: false
      });
      expect(readConfig({ ...env, PANDOCS_EXTRACT_FALLBACK: "true" }).extract?.fallback).toBe(true);
    });
  });

  it("marks a PDF with no text as a scan", async () => {
    expect((await convert(blankPdf(), "application/pdf")).scanned).toBe(true);
    expect(
      (await convert(pdf("Quarterly report with enough text to count"), "application/pdf")).scanned
    ).toBeUndefined();
  });

  it("passes on what it was told through the processor", async () => {
    const processor = createExtractProcessor(async () => ({
      markdown: "文字",
      title: "标题",
      warnings: ["注意"],
      files: []
    }));
    expect(
      await processor.run({ bytes: strToU8("x"), contentType: "text/csv", filename: "a", metadata: {}, jobId: "1" })
    ).toEqual({ markdown: "文字", title: "标题", warnings: ["注意"], files: [], detail: "text/csv" });
    await expect(processor.run({ contentType: "text/csv", filename: "a", metadata: {}, jobId: "1" })).rejects.toThrow(
      "There is no original file"
    );
  });
});
