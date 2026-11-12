import type { MemberRecord, Principal, Role, SpaceDefaultRole } from "./types.js";

const RANK: Readonly<Record<SpaceDefaultRole, number>> = { none: 0, viewer: 1, commenter: 2, editor: 3, admin: 4 };

export function atLeast(role: SpaceDefaultRole, required: Role): boolean {
  return RANK[role] >= RANK[required];
}

function highest(roles: readonly SpaceDefaultRole[]): SpaceDefaultRole {
  return roles.reduce((best, role) => (RANK[role] > RANK[best] ? role : best), "none");
}

/**
 * Someone with no login. It holds no rights of its own: as a guest it gets neither a space's default role nor what
 * "everyone" gets, so all it can read is what a space was opened to the public for. The HTTP handler also keeps it to the
 * routes for reading pages, so that comments, history and anything added later stay closed until someone decides otherwise.
 */
export const ANONYMOUS_PRINCIPAL: Principal = {
  id: "anonymous",
  kind: "user",
  displayName: "Visitor",
  groups: [],
  isAdmin: false,
  guest: true,
  anonymous: true,
  scopes: ["read"],
  channel: "web"
};

/** What only a site administrator can change. A read-only token of theirs sees everything and changes nothing, the same as in a space. */
export const canChangeSite = (principal: Principal): boolean => principal.isAdmin && principal.scopes.includes("write");

export function subjectsOf(principal: Principal): Set<string> {
  // An agent reads as the person who started it, so it never sees more than they can.
  const identity = principal.kind === "agent" && principal.onBehalfOf ? principal.onBehalfOf : principal;
  return new Set([`user:${identity.id}`, ...identity.groups.map(group => `group:${group}`), ...(principal.guest ? [] : ["everyone"])]);
}

export interface AccessContext {
  readonly defaultRole: SpaceDefaultRole;
  readonly publicRead?: boolean;
  readonly spaceMembers: readonly MemberRecord[];
  readonly restricted?: boolean;
  readonly documentMembers?: readonly MemberRecord[];
}

/** The role in a space before the caps on agents and read-only tokens, which is what decides whether restricted pages open up. */
export function spaceRoleOf(principal: Principal, context: Pick<AccessContext, "defaultRole" | "publicRead" | "spaceMembers">): SpaceDefaultRole {
  // An agent working for an administrator sees what they see; `capRole` still keeps it to comments and proposals.
  const siteAdmin = principal.isAdmin || (principal.kind === "agent" && principal.onBehalfOf?.isAdmin === true);
  if (siteAdmin) return "admin";
  const subjects = subjectsOf(principal);
  return highest([principal.guest ? "none" : context.defaultRole, context.publicRead ? "viewer" : "none", ...context.spaceMembers.filter(member => subjects.has(member.subject)).map(member => member.role)]);
}

export function effectiveRole(principal: Principal, context: AccessContext): SpaceDefaultRole {
  const subjects = subjectsOf(principal);
  const spaceRole = spaceRoleOf(principal, context);
  const role = context.restricted && !atLeast(spaceRole, "admin")
    ? highest((context.documentMembers ?? []).filter(member => subjects.has(member.subject)).map(member => member.role))
    : spaceRole;
  return capRole(principal, role);
}

/** Write authority follows identity and role, not channel; only agents and read-only credentials are capped. */
function capRole(principal: Principal, role: SpaceDefaultRole): SpaceDefaultRole {
  let capped = role;
  if (principal.kind === "agent" && RANK[capped] > RANK.commenter) capped = "commenter";
  if (!principal.scopes.includes("write") && RANK[capped] > RANK.viewer) capped = "viewer";
  return capped;
}
