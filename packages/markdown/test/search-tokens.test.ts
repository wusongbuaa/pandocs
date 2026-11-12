import { describe, expect, it } from "vitest";
import { searchQuery, searchTokens } from "@pandocs/markdown";

describe("search tokens", () => {
  it("splits Chinese into adjacent pairs and keeps other words whole", () => {
    expect(searchTokens("权限管理 API-Token 第3步")).toEqual(["权限", "限管", "管理", "api", "token", "第", "3", "步"]);
  });

  it("does not repeat itself", () => {
    expect(searchTokens("书店书店 Book book")).toEqual(["书店", "店书", "book"]);
  });

  it("stops before a page of random text could outgrow what the database takes", () => {
    const noise = Array.from({ length: 80_000 }, (_, at) => `w${at}`).join(" ");
    expect(searchTokens(noise)).toHaveLength(60_000);
  });
});

describe("what someone types", () => {
  it("requires every pair of a phrase", () => {
    expect(searchQuery("权限管理")).toBe("'权限' & '限管' & '管理'");
  });

  it("treats the last Latin word as still being typed", () => {
    expect(searchQuery("API tok")).toBe("'api' & 'tok':*");
  });

  it("finds pairs starting with a lone character", () => {
    expect(searchQuery("权")).toBe("'权':*");
  });

  it("has nothing to look for in punctuation", () => {
    expect(searchQuery("%")).toBeNull();
    // As much as fits in an address, and no more terms than anyone types.
    expect(searchQuery("word ".repeat(5000))!.split(" & ")).toHaveLength(32);
    expect(searchQuery("汉字".repeat(5000))!.split(" & ")).toHaveLength(64);
    expect(searchQuery("  ")).toBeNull();
  });

  it("cannot break out of the query syntax", () => {
    expect(searchQuery("a' | 'b")).toBe("'a' & 'b':*");
  });
});
