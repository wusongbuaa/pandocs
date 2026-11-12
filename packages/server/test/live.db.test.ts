import type { Server } from "node:http";
import { connect as openSocket, type AddressInfo } from "node:net";
import { createLiveCodec, LIVE_FIELD, LIVE_META } from "@pandocs/editor-model";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { usePostgresFixture } from "../../core/test/postgres.js";
import { hashPassword } from "../src/auth/passwords.js";
import { createChangeListener } from "../src/change-listener.js";
import { createLiveHub, LIVE_PATH, type LiveHub } from "../src/live/hub.js";
import { listen } from "../src/listen.js";
import { PUBLIC_URL, signInFirstAdmin, startServer, type Client, type TestServer } from "./support.js";

const fixture = usePostgresFixture();
const codec = createLiveCodec();
const BASE = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
const PASSWORD = "correct horse battery";

interface Replica {
  readonly hub: LiveHub;
  readonly port: number;
  readonly http: Server;
}

interface Connection {
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;
  /** What the draft says as this person sees it. */
  text(): string;
  typeInto(block: number, at: number, text: string): void;
  failed: string[];
  closed: string[];
}

describe("people connected to a shared draft", () => {
  let server: TestServer;
  let admin: Client;
  let first: Replica;
  let second: Replica;
  let listener: ReturnType<typeof createChangeListener>;
  let pageNo = 0;
  let id = "";
  let name = "";
  const connections: Connection[] = [];

  const replica = async (options: { listenUrl?: string; recheckMs?: number; lookAroundMs?: number; admittedWithinMs?: number } = {}): Promise<Replica> => {
    const hub = createLiveHub({
      services: server.runtime.services,
      authenticate: request => server.runtime.identity.authenticate(request),
      publicOrigin: new URL(PUBLIC_URL).origin,
      listenUrl: options.listenUrl ?? fixture.getConnectionString(),
      publish: (channel, payload) => server.pool.query("SELECT pg_notify($1, $2)", [channel, payload]),
      recheckMs: options.recheckMs ?? 30_000,
      ...(options.lookAroundMs === undefined ? {} : { lookAroundMs: options.lookAroundMs }),
      ...(options.admittedWithinMs === undefined ? {} : { admittedWithinMs: options.admittedWithinMs })
    });
    const http = await new Promise<Server>(done => {
      const started = listen(server.app, { hostname: "127.0.0.1", port: 0 }, () => done(started));
    });
    http.on("upgrade", hub.handleUpgrade);
    return { hub, http, port: (http.address() as AddressInfo).port };
  };
  const stopReplica = async ({ hub, http }: Replica) => {
    await hub.stop();
    await new Promise(done => http.close(done));
  };

  const cookieOf = (client: Client) => [...client.cookies].map(([key, value]) => `${key}=${value}`).join("; ");

  const connect = (at: Replica, as: Client | null, documentName = name, headers: Record<string, string> = {}): Connection => {
    const cookie = as ? cookieOf(as) : "";
    const socket = class extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { ...(cookie ? { cookie } : {}), ...headers } });
      }
    };
    const doc = new Y.Doc();
    const failed: string[] = [];
    const closed: string[] = [];
    const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${at.port}${LIVE_PATH}`, WebSocketPolyfill: socket as never, delay: 100, minDelay: 100, maxDelay: 500 });
    const provider = new HocuspocusProvider({
      websocketProvider,
      name: documentName,
      document: doc,
      token: "",
      onAuthenticationFailed: ({ reason }) => { failed.push(reason); },
      onClose: ({ event }) => { closed.push(event.reason); }
    });
    provider.attach();
    const connection: Connection = {
      doc,
      provider,
      failed,
      closed,
      text: () => codec.markdownOf(Y.encodeStateAsUpdate(doc), BASE),
      typeInto: (block, at, text) => ((doc.getXmlFragment(LIVE_FIELD).get(block) as Y.XmlElement).get(0) as Y.XmlText).insert(at, text)
    };
    connections.push(connection);
    return connection;
  };
  const synced = (connection: Connection) => expect.poll(() => connection.provider.isSynced, { timeout: 10_000 }).toBe(true);
  const says = (connection: Connection, text: string) => expect.poll(() => connection.text(), { timeout: 10_000, interval: 25 }).toBe(text);
  const person = async (name_: string, role: string) => {
    const email = `${name_}-${crypto.randomUUID()}@example.test`;
    const user = await server.runtime.users.create({ email, displayName: name_, passwordHash: await hashPassword(PASSWORD) });
    const client = server.client();
    await client.form("/login", { email, password: PASSWORD, next: "/" });
    await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${user.id}`, role });
    return { client, user };
  };
  const save = async (markdown: string, more: object = {}, as: Client = admin) => {
    const { data: view } = await as.json("GET", `/api/v1/documents/${id}`);
    const saved = await as.json("PUT", `/api/v1/documents/${id}/content`, { markdown, expectedRevision: view.revision.no, ...more }, { "idempotency-key": crypto.randomUUID() });
    expect(saved.error).toBeUndefined();
  };

  beforeAll(async () => {
    server = await startServer(fixture.getConnectionString());
    admin = await signInFirstAdmin(server);
    await admin.json("POST", "/api/v1/spaces", { slug: "shop", name: "Shop", defaultRole: "viewer" });
    first = await replica();
    second = await replica();
    listener = createChangeListener(fixture.getConnectionString(), () => {
      first.hub.wake();
      second.hub.wake();
    });
  });
  afterAll(async () => {
    listener.stop();
    await stopReplica(first);
    await stopReplica(second);
    await server.close();
  });
  beforeEach(async () => {
    pageNo += 1;
    const made = await admin.json("POST", "/api/v1/spaces/shop/documents", { title: "Guide", slug: `guide-${pageNo}`, markdown: BASE });
    expect(made.error).toBeUndefined();
    id = made.data.document.id;
    const opened = await admin.json("POST", `/api/v1/documents/${id}/live`);
    expect(opened.data.available).toBe(true);
    name = opened.data.name;
  });
  afterEach(() => {
    for (const connection of connections.splice(0)) {
      connection.provider.destroy();
      connection.provider.configuration.websocketProvider.destroy();
      connection.doc.destroy();
    }
  });

  it("shows each what the other types", async () => {
    const one = connect(first, admin);
    const other = connect(first, admin);
    await synced(one);
    await synced(other);
    expect(one.text()).toBe(BASE);
    one.typeInto(1, 5, " typed");
    await says(other, BASE.replace("First", "First typed"));
    other.typeInto(2, 0, "Now ");
    await says(one, "# Title\n\nFirst typed paragraph.\n\nNow Second paragraph.\n");
  });

  it("does the same when they reached different replicas", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    one.typeInto(1, 5, " typed");
    await says(other, BASE.replace("First", "First typed"));
    other.typeInto(2, 0, "Now ");
    await says(one, "# Title\n\nFirst typed paragraph.\n\nNow Second paragraph.\n");
  });

  it("gets something too long for the relay across replicas as well", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    const long = "A long paste. ".repeat(2000);
    one.typeInto(1, 0, long);
    await says(other, BASE.replace("First", `${long}First`));
  });

  it("shows who is here and where, across replicas too", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    one.provider.setAwarenessField("user", { name: "One", color: "#f00" });
    other.provider.setAwarenessField("user", { name: "Other", color: "#00f" });
    const names = (connection: Connection) => [...connection.provider.awareness!.getStates().values()].map(state => (state as { user?: { name: string } }).user?.name).filter(Boolean).sort();
    await expect.poll(() => names(one), { timeout: 10_000 }).toEqual(["One", "Other"]);
    await expect.poll(() => names(other), { timeout: 10_000 }).toEqual(["One", "Other"]);
    other.provider.destroy();
    await expect.poll(() => names(one), { timeout: 10_000 }).toEqual(["One"]);
  });

  it("shows everyone already here to someone arriving on another replica, more than one message holds", async () => {
    const here = [connect(first, admin), connect(first, admin), connect(first, admin)];
    for (const connection of here) await synced(connection);
    // Together far more than the relay carries at once, each well under it.
    here.forEach((connection, at) => connection.provider.setAwarenessField("user", { name: `${at}`.padEnd(3000, "-"), color: "#f00" }));
    const names = (connection: Connection) => [...connection.provider.awareness!.getStates().values()].filter(state => (state as { user?: unknown }).user).length;
    await expect.poll(() => names(here[0]!), { timeout: 10_000 }).toBe(3);
    const arriving = connect(second, admin);
    await synced(arriving);
    await expect.poll(() => names(arriving), { timeout: 10_000 }).toBe(3);
  });

  it("merges both ways when someone comes back after losing the connection", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    const socket = one.provider.configuration.websocketProvider;
    socket.disconnect();
    await expect.poll(() => first.hub.connections, { timeout: 10_000 }).toBe(0);
    one.typeInto(1, 5, " while away");
    other.typeInto(2, 0, "Here: ");
    await says(other, "# Title\n\nFirst paragraph.\n\nHere: Second paragraph.\n");
    await socket.connect();
    const merged = "# Title\n\nFirst while away paragraph.\n\nHere: Second paragraph.\n";
    await says(one, merged);
    await says(other, merged);
  });

  it("gets someone joining on another replica what was typed a moment ago", async () => {
    const one = connect(first, admin);
    await synced(one);
    one.typeInto(1, 5, " just typed");
    await says(one, BASE.replace("First", "First just typed"));
    // Sooner than it would have been written down, and the other replica has no reason to be listening yet.
    const other = connect(second, admin);
    await synced(other);
    await expect.poll(() => other.text(), { timeout: 3000, interval: 25 }).toBe(BASE.replace("First", "First just typed"));
  });

  it("keeps what was typed after everyone has gone", async () => {
    const one = connect(first, admin);
    await synced(one);
    one.typeInto(1, 5, " typed");
    await expect.poll(async () => first.hub.drafts, { timeout: 10_000 }).toBe(1);
    one.provider.destroy();
    await expect.poll(() => first.hub.drafts, { timeout: 15_000 }).toBe(0);
    const stored = await server.runtime.services.live.read(id);
    expect(codec.markdownOf(stored!.state, BASE)).toBe(BASE.replace("First", "First typed"));
    const later = connect(second, admin);
    await synced(later);
    await says(later, BASE.replace("First", "First typed"));
    const { data } = await admin.json("GET", `/api/v1/documents/${id}/live`);
    expect(data.unsaved.contributors).toHaveLength(1);
  });

  it("keeps what was typed just before a replica stops", async () => {
    const temporary = await replica();
    const one = connect(temporary, admin);
    await synced(one);
    one.typeInto(1, 5, " typed");
    await says(one, BASE.replace("First", "First typed"));
    await expect.poll(() => temporary.hub.connections).toBe(1);
    await new Promise(done => { setTimeout(done, 100); });
    await stopReplica(temporary);
    const stored = await server.runtime.services.live.read(id);
    expect(codec.markdownOf(stored!.state, BASE)).toBe(BASE.replace("First", "First typed"));
  });

  it("brings a version made elsewhere straight into what people are typing, on every replica", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    one.typeInto(1, 5, " typed");
    await says(other, BASE.replace("First", "First typed"));
    // As an agent or another tool would, through the API.
    await save(BASE.replace("Second", "Changed second"));
    const merged = "# Title\n\nFirst typed paragraph.\n\nChanged second paragraph.\n";
    await says(one, merged);
    await says(other, merged);
    await expect.poll(() => one.doc.getMap(LIVE_META).get("baseRevision"), { timeout: 10_000 }).toBe(2);
    await expect.poll(() => other.doc.getMap(LIVE_META).get("baseRevision"), { timeout: 10_000 }).toBe(2);
    await new Promise(done => { setTimeout(done, 300); });
    expect(one.text()).toBe(merged);
    expect(other.text()).toBe(merged);
  });

  it("goes back to following the page once someone saves what is there", async () => {
    const one = connect(first, admin);
    await synced(one);
    one.typeInto(1, 5, " typed");
    const text = BASE.replace("First", "First typed");
    await says(one, text);
    await save(text, { fromLiveDraft: true });
    await expect.poll(() => one.doc.getMap(LIVE_META).get("baseRevision"), { timeout: 10_000 }).toBe(2);
    expect(one.text()).toBe(text);
    await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved, { timeout: 10_000 }).toBeNull();
  });

  it("takes everyone back when someone discards the draft", async () => {
    const one = connect(first, admin);
    const other = connect(second, admin);
    await synced(one);
    await synced(other);
    one.typeInto(1, 5, " typed");
    await says(other, BASE.replace("First", "First typed"));
    await new Promise(done => { setTimeout(done, 2000); });
    expect((await admin.json("DELETE", `/api/v1/documents/${id}/live`)).status).toBe(200);
    await says(one, BASE);
    await says(other, BASE);
  });

  describe("who may come in", () => {
    const refusedWith = (connection: Connection, reason: string) => expect.poll(() => connection.failed.at(-1), { timeout: 10_000 }).toBe(reason);

    it("not someone who is not signed in", async () => {
      const stranger = connect(first, null);
      await refusedWith(stranger, "signed-out");
      expect(stranger.provider.isSynced).toBe(false);
    });

    it("not someone who cannot edit the page", async () => {
      const { client } = await person("Viewer", "viewer");
      await refusedWith(connect(first, client), "forbidden");
    });

    it("someone who can", async () => {
      const { client } = await person("Editor", "editor");
      const editor = connect(first, client);
      await synced(editor);
      editor.typeInto(1, 0, "Edited: ");
      await expect.poll(async () => (await admin.json("GET", `/api/v1/documents/${id}/live`)).data.unsaved?.contributors, { timeout: 10_000 }).toEqual(["Editor"]);
    });

    it("not a tab from before a draft was started again", async () => {
      const old = connect(first, admin, `${id}.something-older`);
      await refusedWith(old, "stale");
    });

    it("not to a draft that does not exist", async () => {
      const made = connect(first, admin, "not-a-draft");
      await refusedWith(made, "forbidden");
    });

    const upgrade = (at: Replica, path: string, headers: Record<string, string>) => new Promise<number>(done => {
      const socket = new WebSocket(`ws://127.0.0.1:${at.port}${path}`, { headers });
      socket.on("unexpected-response", (_request, response) => done(response.statusCode ?? 0));
      socket.on("open", () => {
        socket.close();
        done(101);
      });
      socket.on("error", () => done(0));
    });

    it("not from a page on another site, which a browser would bring the cookie along for", async () => {
      expect(await upgrade(first, LIVE_PATH, { origin: "https://evil.example.com", cookie: cookieOf(admin) })).toBe(403);
      expect(await upgrade(first, LIVE_PATH, { origin: new URL(PUBLIC_URL).origin, cookie: cookieOf(admin) })).toBe(101);
      expect(await upgrade(first, LIVE_PATH, { "sec-fetch-site": "cross-site", cookie: cookieOf(admin) })).toBe(403);
    });

    it("nothing on any other address", async () => {
      expect(await upgrade(first, "/api/v1/somewhere", {})).toBe(404);
    });
  });

  describe("once someone is in", () => {
    let strict: Replica;
    beforeAll(async () => {
      strict = await replica({ recheckMs: 0, lookAroundMs: 100 });
    });
    afterAll(() => stopReplica(strict));

    it("sends them away when they can no longer edit, and takes nothing more from them", async () => {
      const { client, user } = await person("Editor", "editor");
      const editor = connect(strict, client);
      await synced(editor);
      editor.typeInto(1, 0, "Before: ");
      await expect.poll(async () => codec.markdownOf((await server.runtime.services.live.read(id))!.state, BASE), { timeout: 10_000 }).toContain("Before: ");
      await admin.json("PUT", "/api/v1/spaces/shop/members", { subject: `user:${user.id}`, role: "viewer" });
      editor.typeInto(1, 0, "After: ");
      await expect.poll(() => editor.closed.at(0), { timeout: 10_000 }).toBe("forbidden");
      await new Promise(done => { setTimeout(done, 2500); });
      expect(codec.markdownOf((await server.runtime.services.live.read(id))!.state, BASE)).not.toContain("After: ");
    });

    it("sends them away when they sign out", async () => {
      const { client } = await person("Editor", "editor");
      const cookie = cookieOf(client);
      const editor = connect(strict, client);
      await synced(editor);
      await client.form("/logout", {});
      expect(cookieOf(client)).not.toBe(cookie);
      editor.typeInto(1, 0, "After: ");
      await expect.poll(() => editor.closed.at(0), { timeout: 10_000 }).toBe("signed-out");
    });

    it("tells them when the draft is no longer there", async () => {
      const one = connect(strict, admin);
      await synced(one);
      await server.pool.query(`DELETE FROM pandocs.live_drafts WHERE document_id = $1`, [id]);
      await expect.poll(() => one.closed.at(0), { timeout: 10_000 }).toBe("stale");
    });

    it("sends them away when the page is deleted", async () => {
      const one = connect(strict, admin);
      await synced(one);
      await admin.json("DELETE", `/api/v1/documents/${id}`);
      one.typeInto(1, 0, "After: ");
      await expect.poll(() => one.closed.at(0), { timeout: 10_000 }).toBe("forbidden");
    });
  });

  it("still works without the relay, only more slowly", async () => {
    const options = { listenUrl: "postgres://postgres:postgres@127.0.0.1:1/nothing", lookAroundMs: 200 };
    const one = await replica(options);
    const other = await replica(options);
    try {
      const here = connect(one, admin);
      const there = connect(other, admin);
      await synced(here);
      await synced(there);
      here.typeInto(1, 5, " typed");
      await says(there, BASE.replace("First", "First typed"));
    } finally {
      for (const connection of connections.splice(0)) connection.provider.destroy();
      await stopReplica(one);
      await stopReplica(other);
    }
  });

  it("ends up the same for everyone, with nothing lost, however much happens at once", async () => {
    const people = [connect(first, admin), connect(second, admin), connect(first, admin), connect(second, admin), connect(first, admin), connect(second, admin)];
    await Promise.all(people.map(synced));
    const typed: string[] = [];
    const arrivals: Promise<unknown>[] = [];
    // Each person types at their own pace, somewhere in one of the paragraphs, while the page changes from elsewhere too.
    await Promise.all(people.map(async (somebody, who) => {
      for (let round = 0; round < 40; round += 1) {
        const token = `zq${who}x${round}qz`;
        typed.push(token);
        const block = 1 + (round % 2);
        const text = (somebody.doc.getXmlFragment(LIVE_FIELD).get(block) as Y.XmlElement).get(0) as Y.XmlText;
        // At either end, so that nobody's word gets split by someone else's and can still be looked for afterwards.
        text.insert(Math.random() < 0.5 ? 0 : text.length, token);
        const watcher = people[(who + 1) % people.length]!;
        if (round % 10 === 0) arrivals.push(expect.poll(() => watcher.text().includes(token), { timeout: 5000, interval: 10 }).toBe(true));
        await new Promise(done => { setTimeout(done, 5 + Math.random() * 30); });
      }
    }));
    await Promise.all(arrivals);
    await save(BASE.replace("# Title", "# Title from elsewhere"));
    await expect.poll(() => people[0]!.text(), { timeout: 15_000, interval: 100 }).toContain("# Title from elsewhere");
    await expect.poll(() => new Set(people.map(somebody => somebody.text())).size, { timeout: 15_000, interval: 100 }).toBe(1);
    const final = people[0]!.text();
    for (const token of typed) expect(final).toContain(token);
    expect(final).toContain("# Title from elsewhere");
    // And what is stored comes to say the same.
    await expect.poll(async () => codec.markdownOf((await server.runtime.services.live.read(id))!.state, BASE), { timeout: 15_000, interval: 200 }).toBe(final);
  }, 120_000);

  it("stays up whatever someone with no login sends", async () => {
    const answered = async () => (await fetch(`http://127.0.0.1:${first.port}/healthz`)).status;
    // An address the URL parser refuses, on the way to becoming a WebSocket.
    for (const address of ["//", "//[", "http://[", "/\\", "/%", "*"]) {
      await new Promise<void>(done => {
        const raw = openSocket(first.port, "127.0.0.1", () => raw.write(`GET ${address} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
        raw.on("data", () => raw.destroy());
        raw.on("close", () => done());
        raw.on("error", () => done());
        setTimeout(() => raw.destroy(), 1000).unref();
      });
      await new Promise(done => setTimeout(done, 20));
    }
    expect(await answered()).toBe(200);
    // Bytes that are not a message at all, with no login. No connection is kept for them.
    for (const bytes of [Buffer.from([0xff]), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.from([]), Buffer.from("not binary at all"), Buffer.from([0x05, 0x61, 0x62]), Buffer.from([0x01, 0x61, 0xff, 0xff, 0xff, 0xff, 0xff])]) {
      await new Promise<void>(done => {
        const socket = new WebSocket(`ws://127.0.0.1:${first.port}${LIVE_PATH}`);
        socket.on("open", () => {
          socket.send(bytes);
          setTimeout(() => socket.terminate(), 60);
        });
        socket.on("close", () => done());
        socket.on("error", () => done());
      });
    }
    expect(await answered()).toBe(200);
  });

  it("stays up when whoever is asking goes away at the worst moment", async () => {
    const upgrade = (address: string, extra = "") => `GET ${address} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;
    for (let round = 0; round < 200; round += 1) {
      for (const request of [upgrade("/nowhere"), upgrade(LIVE_PATH, "Origin: https://evil.example\r\n"), upgrade(LIVE_PATH)]) {
        const raw = openSocket(first.port, "127.0.0.1");
        raw.on("error", () => undefined);
        raw.on("connect", () => raw.write(request, () => raw.resetAndDestroy()));
      }
    }
    await new Promise(done => setTimeout(done, 500));
    expect((await fetch(`http://127.0.0.1:${first.port}/healthz`)).status).toBe(200);
  }, 30_000);

  it("closes a connection nobody has been let into, and leaves alone one somebody has", async () => {
    const strict = await replica({ admittedWithinMs: 300 });
    try {
      const started = Date.now();
      await new Promise<void>(done => {
        const socket = new WebSocket(`ws://127.0.0.1:${strict.port}${LIVE_PATH}`);
        socket.on("close", () => done());
        socket.on("error", () => done());
      });
      expect(Date.now() - started).toBeLessThan(3000);
      const one = connect(strict, admin);
      await synced(one);
      await new Promise(done => setTimeout(done, 600));
      expect(one.closed).toEqual([]);
      one.typeInto(0, 0, "still here ");
      await expect.poll(() => one.text().includes("still here")).toBe(true);
    } finally {
      await strict.hub.stop();
      strict.http.closeAllConnections();
      await new Promise(done => strict.http.close(done));
    }
  });

  it("does not care about nonsense", async () => {
    await new Promise<void>(done => {
      const socket = new WebSocket(`ws://127.0.0.1:${first.port}${LIVE_PATH}`, { headers: { cookie: cookieOf(admin) } });
      socket.on("open", () => socket.send(new Uint8Array([255, 255, 255, 1, 2, 3])));
      socket.on("close", () => done());
      socket.on("error", () => done());
    });
    const one = connect(first, admin);
    await synced(one);
  });
});
