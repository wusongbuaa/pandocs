import { describe, expect, it } from "vitest";
import { z } from "zod";
import { issueMessage } from "../src/issue-message.js";

const said = (schema: z.ZodType, value: unknown) =>
  schema.safeParse(value, { error: issueMessage }).error?.issues[0]?.message;

describe("what a rejected value says", () => {
  it("covers what the schemas here reject", () => {
    expect(said(z.object({ name: z.string() }), {})).toBe("Required");
    expect(said(z.string(), 1)).toBe("Expected string");
    expect(said(z.string().min(1), "")).toBe("Required");
    expect(said(z.string().min(3), "ab")).toBe("At least 3 characters");
    expect(said(z.string().max(1), "ab")).toBe("At most 1 character");
    expect(said(z.array(z.string()).min(1), [])).toBe("At least 1 item");
    expect(said(z.array(z.string()).max(2), ["a", "b", "c"])).toBe("At most 2 items");
    expect(said(z.number().int().min(1), 0)).toBe("At least 1");
    expect(said(z.number().positive(), 0)).toBe("More than 0");
    expect(said(z.number().max(10), 11)).toBe("At most 10");
    expect(said(z.number().lt(10), 10)).toBe("Less than 10");
    expect(said(z.number().multipleOf(5), 7)).toBe("Must be a multiple of 5");
    expect(said(z.email(), "nobody")).toBe("Not an email address");
    expect(said(z.url(), "nowhere")).toBe("Not a web address");
    expect(said(z.uuid(), "1")).toBe("Not a valid ID");
    expect(said(z.iso.datetime(), "yesterday")).toBe("Not a valid date or time");
    expect(said(z.string().regex(/^a/u), "b")).toBe("Not in the right format");
    expect(said(z.enum(["a", "b"]), "c")).toBe("Must be one of: a, b");
    expect(said(z.object({}).strict(), { x: 1, y: 2 })).toBe("Unknown fields: x, y");
    expect(said(z.union([z.string(), z.number()]), true)).toBe("Not valid");
  });

  it("leaves a schema's own words alone", () => {
    expect(said(z.string().min(1, { error: "Give it a name" }), "")).toBe("Give it a name");
  });
});
