import { describe, expect, it } from "vitest";
import { effectiveRole } from "../src/domain/access.js";
import type { Principal } from "../src/domain/types.js";

const person: Principal = { id: "p", kind: "user", displayName: "人", groups: [], isAdmin: false, scopes: ["read", "write"], channel: "web" };
const agentFor = (owner: { id: string; groups: string[]; isAdmin?: boolean }): Principal => ({ ...person, id: "agent:1", kind: "agent", channel: "agent", onBehalfOf: owner });

describe("what an agent can do", () => {
  const closed = { defaultRole: "none" as const, spaceMembers: [] };

  it("reads what its owner can read, and no more", () => {
    expect(effectiveRole(agentFor({ id: "stranger", groups: [] }), closed)).toBe("none");
    expect(effectiveRole(agentFor({ id: "member", groups: [] }), { defaultRole: "none", spaceMembers: [{ subject: "user:member", role: "viewer" }] })).toBe("viewer");
    expect(effectiveRole(agentFor({ id: "grouped", groups: ["team"] }), { defaultRole: "none", spaceMembers: [{ subject: "group:team", role: "editor" }] })).toBe("commenter");
  });

  it("gets at most comment rights for an administrator owner, who can see everything", () => {
    expect(effectiveRole(agentFor({ id: "root", groups: [], isAdmin: true }), closed)).toBe("commenter");
    expect(effectiveRole(agentFor({ id: "root", groups: [], isAdmin: true }), { ...closed, restricted: true, documentMembers: [] })).toBe("commenter");
  });

  it("does not take the owner's rights from a claim on a person's own identity", () => {
    expect(effectiveRole({ ...person, onBehalfOf: { id: "root", groups: [], isAdmin: true } }, closed)).toBe("none");
  });
});
