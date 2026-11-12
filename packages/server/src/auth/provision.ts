import type { ProviderProfile } from "./providers.js";
import type { User, UserStore } from "./users.js";

export const LONGEST_EMAIL = 320;

export const validEmail = (email: string) => /^[^@\s]+@[^@\s]+$/u.test(email) && email.length <= LONGEST_EMAIL;

/** What a site says about the people it vouches for. */
export interface ProvisionRules {
  readonly allowedDomains: readonly string[];
  /** Someone in this group administers the site, and nobody else does. Without one, the first person to arrive does. */
  readonly adminGroup?: string | undefined;
}

/**
 * The account someone has here by what another system says about them: made the first time they come, and brought up to
 * date each time after, so that names, groups and who administers the site stay that system's to decide.
 */
export async function userFromProfile(
  users: UserStore,
  rules: ProvisionRules,
  profile: ProviderProfile
): Promise<User | { error: string }> {
  const domain = profile.email?.split("@")[1]?.toLowerCase();
  if (rules.allowedDomains.length > 0 && (!domain || !rules.allowedDomains.includes(domain)))
    return { error: "domain" };
  let user = await users.findByIdentity(profile.issuer, profile.subject);
  if (!user && profile.email && profile.emailVerified) {
    user = await users.findByEmail(profile.email);
    if (user) await users.linkIdentity(profile.issuer, profile.subject, user.id);
  }
  if (!user) {
    if (!profile.email || !validEmail(profile.email)) return { error: "email" };
    // An address the provider did not vouch for cannot claim an existing account, and two accounts cannot share one.
    if (await users.findByEmail(profile.email)) return { error: "email" };
    const displayName = profile.displayName ?? profile.email.split("@")[0]!;
    const first = rules.adminGroup
      ? null
      : await users.createFirstAdmin({ email: profile.email, displayName, passwordHash: null, groups: profile.groups });
    user = first ?? (await users.create({ email: profile.email, displayName, groups: profile.groups }));
    await users.linkIdentity(profile.issuer, profile.subject, user.id);
  }
  if (user.status !== "active") return { error: "disabled" };
  return users.syncFromProvider(user.id, {
    displayName: profile.displayName,
    groups: profile.groups,
    isAdmin: rules.adminGroup ? profile.groups.includes(rules.adminGroup) : undefined
  });
}
