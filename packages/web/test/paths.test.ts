import { describe, expect, it } from "vitest";
import { documentRoute } from "../src/data/paths";
import { matchPath } from "../vendor/rspress/runtime/route";

describe("the address of a page", () => {
  it("can be read back by the site whatever the page is called, and leaves readable names readable", () => {
    expect(documentRoute("cg", "discount-50%")).toBe("/cg/discount-50%25");
    expect(documentRoute("cg", "a#b")).toBe("/cg/a%23b");
    expect(documentRoute("cg", "指南/开始")).toBe("/cg/指南/开始");
    // Every link in the sidebar is checked against the address being read, so one that cannot be read took every page down.
    expect(() => matchPath(documentRoute("cg", "discount-50%"), "/cg/faq")).not.toThrow();
    expect(matchPath(documentRoute("cg", "discount-50%"), "/cg/discount-50%25")).not.toBeNull();
  });
});
