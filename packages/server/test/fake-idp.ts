import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface FakeProfile {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly name?: string;
  readonly groups?: readonly string[];
}

/** A real HTTP identity provider, so the login flow goes through `openid-client` the way it does in production. */
export async function startFakeIdp() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce?: string; challenge: string; profile: FakeProfile }>();
  const accessTokens = new Map<string, FakeProfile>();
  let issuer = "";
  const state = {
    profile: {
      sub: "person-1",
      email: "person@example.test",
      email_verified: true,
      name: "员工一",
      groups: ["staff"]
    } as FakeProfile
  };

  const respond = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url!, issuer);
    const send = (status: number, body: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/.well-known/openid-configuration") {
      send(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"]
      });
      return;
    }
    if (url.pathname === "/jwks") {
      send(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get("nonce") ?? undefined!,
        challenge: url.searchParams.get("code_challenge")!,
        profile: state.profile
      });
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", code);
      target.searchParams.set("state", url.searchParams.get("state")!);
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (url.pathname === "/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const entry = codes.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!entry || entry.challenge !== challenge) {
        send(400, { error: "invalid_grant" });
        return;
      }
      codes.delete(form.get("code")!);
      const accessToken = randomUUID();
      accessTokens.set(accessToken, entry.profile);
      const idToken = await new SignJWT({ ...(entry.nonce ? { nonce: entry.nonce } : {}) })
        .setProtectedHeader({ alg: "RS256", kid: "test" })
        .setIssuer(issuer)
        .setAudience("pandocs")
        .setSubject(entry.profile.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      send(200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken });
      return;
    }
    if (url.pathname === "/userinfo" || url.pathname === "/oauth/user") {
      const profile = accessTokens.get(request.headers.authorization?.replace(/^Bearer /u, "") ?? "");
      if (!profile) {
        send(401, { error: "invalid_token" });
        return;
      }
      send(
        200,
        url.pathname === "/userinfo"
          ? profile
          : { id: 4242, email: profile.email, name: profile.name, groups: profile.groups }
      );
      return;
    }
    send(404, {});
  };

  const server = createServer((request, response) => {
    respond(request, response).catch(error => {
      console.error(error);
      response.writeHead(500).end();
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    /** Who the next visitor to the provider turns out to be. */
    signInAs(profile: FakeProfile) {
      state.profile = profile;
    },
    close: () => new Promise(done => server.close(done))
  };
}
