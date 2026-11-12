import { PermanentIngestError } from "@pandocs/core";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { extractWithService } from "../src/extract/processor.js";
import { docx, pdf, xlsx } from "./office-files.js";

/**
 * Pandocs against the converter in deploy/converter, running on its own:
 * PANDOCS_CONVERTER_URL=http://127.0.0.1:8090/convert, with PANDOCS_CONVERTER_TOKEN if it was given one.
 * The converter's workflow runs this. Without the address it is skipped.
 */
const url = process.env.PANDOCS_CONVERTER_URL;
const token = process.env.PANDOCS_CONVERTER_TOKEN;

describe.skipIf(!url)("the converter in deploy/converter", () => {
  const extract = extractWithService({ url: url!, token });

  it("reads Word, and any pictures come back as files named the way Pandocs keeps them", async () => {
    const result = await extract({
      bytes: docx(),
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "退货 流程.docx"
    });
    expect(result.markdown).toContain("退货流程");
    expect(result.markdown).toContain("无理由");
    for (const file of result.files) expect(result.markdown).toContain(`assets/${file.filename}`);
  });

  it("reads Excel, CSV, HTML and the text of a PDF", async () => {
    const read = (bytes: Uint8Array, contentType: string, filename: string) =>
      extract({ bytes, contentType, filename }).then(result => result.markdown);
    expect(
      await read(xlsx(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "书单.xlsx")
    ).toContain("红楼梦");
    expect(await read(strToU8("名称,数量\n红楼梦,3\n"), "text/csv", "表.csv")).toMatch(/\|\s*红楼梦\s*\|\s*3\s*\|/u);
    expect(await read(strToU8("<html><body><h1>欢迎</h1><p>正文</p></body></html>"), "text/html", "页.html")).toContain(
      "欢迎"
    );
    expect(await read(pdf("Quarterly report for the third quarter"), "application/pdf", "report.pdf")).toContain(
      "Quarterly report"
    );
  });

  it.skipIf(!token)("refuses a caller without its token, for good", async () => {
    await expect(
      extractWithService({ url: url!, token: "not-the-token" })({
        bytes: strToU8("a,b"),
        contentType: "text/csv",
        filename: "a.csv"
      })
    ).rejects.toBeInstanceOf(PermanentIngestError);
  });
});
