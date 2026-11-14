import { createHmac, timingSafeEqual } from "node:crypto";
import * as client from "openid-client";
import type { LoginProvider } from "../config.js";

export interface ProviderProfile {
  /** Identifies the provider in the identities table, so the same subject elsewhere is a different person. */
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string | undefined;
  readonly emailVerified: boolean;
  readonly displayName?: string | undefined;
  readonly groups: readonly string[];
}

interface LoginState {
  readonly verifier: string;
  readonly state: string;
  readonly nonce?: string | undefined;
  readonly next: string;
  readonly expires: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** The login in progress lives in a signed cookie, so whichever replica gets the callback can finish it. */
export function sealLoginState(secret: string, state: LoginState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function openLoginState(secret: string, sealed: string | undefined): LoginState | null {
  if (!sealed) return null;
  const [body, signature] = sealed.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const state = JSON.parse(Buffer.from(body, "base64url").toString()) as LoginState;
  return state.expires > Date.now() ? state : null;
}

const stringClaim = (claims: Record<string, unknown>, name: string) => {
  const value = claims[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  return typeof value === "number" ? String(value) : undefined;
};

function groupsFrom(claims: Record<string, unknown>, name: string): string[] {
  const value = claims[name];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return typeof value === "string" && value.trim() ? value.split(/[\s,]+/u).filter(Boolean) : [];
}

export function createLoginFlow(provider: LoginProvider, callbackUrl: string, secret: string) {
  const insecure = provider.allowHttp ? { execute: [client.allowInsecureRequests] } : undefined;
  let configuration: Promise<client.Configuration> | null = null;
  const configure = () => {
    configuration ??= (async () => {
      const { protocol } = provider;
      if (protocol.kind === "oidc")
        return client.discovery(
          new URL(protocol.issuer),
          provider.clientId,
          provider.clientSecret,
          undefined,
          insecure
        );
      const manual = new client.Configuration(
        {
          issuer: new URL(protocol.authorizationUrl).origin,
          authorization_endpoint: protocol.authorizationUrl,
          token_endpoint: protocol.tokenUrl,
          userinfo_endpoint: protocol.userinfoUrl
        },
        provider.clientId,
        provider.clientSecret
      );
      if (provider.allowHttp) client.allowInsecureRequests(manual);
      return manual;
    })().catch(error => {
      // A provider that was down at the first login should work at the next one.
      configuration = null;
      throw error;
    });
    return configuration;
  };
  return {
    provider,
    async start(next: string): Promise<{ url: URL; cookie: string }> {
      const config = await configure();
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = provider.protocol.kind === "oidc" ? client.randomNonce() : undefined;
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: callbackUrl,
        scope: provider.scopes,
        code_challenge: await client.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        ...(nonce ? { nonce } : {})
      });
      return {
        url,
        cookie: sealLoginState(secret, { verifier, state, nonce, next, expires: Date.now() + STATE_TTL_MS })
      };
    },
    async finish(currentUrl: URL, login: LoginState): Promise<ProviderProfile> {
      const config = await configure();
      const { protocol } = provider;
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: login.verifier,
        expectedState: login.state,
        ...(login.nonce ? { expectedNonce: login.nonce } : {}),
        idTokenExpected: protocol.kind === "oidc"
      });
      if (protocol.kind === "oidc") {
        const claims = tokens.claims()!;
        // Groups and names are often only in the userinfo response. A provider without that endpoint still logs in on the ID token.
        const info = config.serverMetadata().userinfo_endpoint
          ? await client.fetchUserInfo(config, tokens.access_token, claims.sub).catch(() => null)
          : null;
        const merged: Record<string, unknown> = { ...claims, ...info };
        return {
          issuer: config.serverMetadata().issuer,
          subject: claims.sub,
          email: stringClaim(merged, "email"),
          emailVerified: merged.email_verified === true,
          displayName: stringClaim(merged, "name") ?? stringClaim(merged, "preferred_username"),
          groups: groupsFrom(merged, provider.groupsClaim)
        };
      }
      const response = await client.fetchProtectedResource(
        config,
        tokens.access_token,
        new URL(protocol.userinfoUrl),
        "GET"
      );
      if (!response.ok) throw new Error(`userinfo answered ${response.status}`);
      const info = (await response.json()) as Record<string, unknown>;
      const subject = stringClaim(info, protocol.subjectClaim);
      if (!subject) throw new Error(`userinfo has no ${protocol.subjectClaim}`);
      return {
        issuer: `oauth2:${new URL(protocol.authorizationUrl).origin}`,
        subject,
        email: stringClaim(info, protocol.emailClaim),
        // Plain OAuth2 gives no statement about the address, so an existing account is never taken over through it.
        emailVerified: false,
        displayName: stringClaim(info, protocol.nameClaim),
        groups: groupsFrom(info, provider.groupsClaim)
      };
    }
  };
}

export type LoginFlow = ReturnType<typeof createLoginFlow>;
