import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { WebhookEvent, WebhookMessage, WebhookTarget } from "@pandocs/core";
import { addMessages, inLanguage } from "@pandocs/i18n";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zh } from "../src/i18n/zh.js";
import "../src/language.js";
import { createWebhookSender, isPrivate, renderWebhook } from "../src/webhooks.js";

const PUBLIC_URL = new URL("https://docs.example.com");
const NOW = 1_700_000_000_123;

const update = (title = "Returns", message = "Longer window"): WebhookEvent => ({
  event: "page.updated",
  occurredAt: "2026-11-07T00:00:00.000Z",
  space: { slug: "shop", name: "Shop" },
  page: { id: "11111111-1111-4111-8111-111111111111", title, path: "guides/returns", restricted: false },
  actor: { name: "Ben", kind: "user" },
  revision: 3,
  message
});
const messageOf = (...events: WebhookEvent[]): WebhookMessage => ({ id: "delivery-1", siteTitle: "Handbook", events });
const render = (target: Omit<WebhookTarget, "secret"> & { secret?: string }, ...events: WebhookEvent[]) => renderWebhook({ secret: "", ...target }, messageOf(...events), PUBLIC_URL, NOW);
const bodyOf = (target: Omit<WebhookTarget, "secret"> & { secret?: string }, ...events: WebhookEvent[]) => render(target, ...events).body as any;

describe("what each service gets", () => {
  it("signs for Feishu the way its documentation says: the time and secret make the key, and nothing is signed", () => {
    const body = bodyOf({ kind: "feishu", url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc", secret: "s3cret" }, update());
    expect(body.timestamp).toBe("1700000000");
    expect(body.sign).toBe(createHmac("sha256", "1700000000\ns3cret").update(Buffer.alloc(0)).digest("base64"));
    expect(body.msg_type).toBe("post");
    expect(body.content.post.en_us.title).toBe("Handbook");
    expect(body.content.post.en_us.content[0]).toEqual([
      { tag: "text", text: "Ben updated a page: " },
      { tag: "a", text: "Returns", href: "https://docs.example.com/shop/guides/returns" },
      { tag: "text", text: "\nLonger window" }
    ]);
  });

  it("leaves the signature out for a Feishu bot with none, and writes in the site's language", () => {
    addMessages("zh", zh);
    const body = inLanguage("zh", () => bodyOf({ kind: "feishu", url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" }, update()));
    expect(body).not.toHaveProperty("sign");
    expect(body).not.toHaveProperty("timestamp");
    expect(body.content.post.zh_cn.content[0][0].text).toBe("Ben 更新了页面: ");
  });

  it("signs for DingTalk in the address, with the time in milliseconds", () => {
    const { url, body } = render({ kind: "dingtalk", url: "https://oapi.dingtalk.com/robot/send?access_token=abc", secret: "s3cret" }, update()) as { url: URL; body: any };
    expect(url.searchParams.get("access_token")).toBe("abc");
    expect(url.searchParams.get("timestamp")).toBe(String(NOW));
    expect(url.searchParams.get("sign")).toBe(createHmac("sha256", "s3cret").update(`${NOW}\ns3cret`).digest("base64"));
    expect(url.search).toContain("sign=");
    expect(url.search).not.toMatch(/sign=[^&]*\+/u);
    expect(body).toEqual({ msgtype: "markdown", markdown: { title: "Handbook", text: "Ben updated a page: [Returns](https://docs.example.com/shop/guides/returns)\n> Longer window" } });
  });

  it("writes Markdown for WeCom, inside its limit however much happened", () => {
    const body = bodyOf({ kind: "wecom", url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" }, update());
    expect(body).toEqual({ msgtype: "markdown", markdown: { content: "Ben updated a page: [Returns](https://docs.example.com/shop/guides/returns)\n> Longer window" } });
    const many = Array.from({ length: 30 }, (_, at) => update(`${"页".repeat(190)}${at}`, "说".repeat(200)));
    const { content } = bodyOf({ kind: "wecom", url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" }, ...many).markdown;
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
    expect(content).toMatch(/… and \d+ more$/u);
  });

  it("writes links the way Slack does, and does not let a title mention anyone", () => {
    const body = bodyOf({ kind: "slack", url: "https://hooks.slack.com/services/x" }, update("<!channel> & <b>", "a\nb"));
    expect(body).toEqual({ text: "Ben updated a page: <https://docs.example.com/shop/guides/returns|&lt;!channel&gt; &amp; &lt;b&gt;>\n> a b" });
  });

  it("keeps a title from mentioning people or ending a link in Markdown", () => {
    const { content } = bodyOf({ kind: "wecom", url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" }, update("<@all> [x](https://evil.example)", "<@all>")).markdown;
    expect(content).not.toContain("<@all>");
    expect(content).toContain("[＜@all＞ ［x］(https://evil.example)](https://docs.example.com/shop/guides/returns)");
  });

  it("sends Teams an Adaptive Card in the wrapper it needs", () => {
    const body = bodyOf({ kind: "teams", url: "https://example.logic.azure.com/workflows/abc" }, update());
    expect(body.type).toBe("message");
    expect(body.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(body.attachments[0].content).toMatchObject({ type: "AdaptiveCard", version: "1.2", $schema: "http://adaptivecards.io/schemas/adaptive-card.json" });
    expect(body.attachments[0].content.body[0]).toMatchObject({ type: "TextBlock", wrap: true, text: "Ben updated a page: [Returns](https://docs.example.com/shop/guides/returns)" });
  });

  it("gives a chat ten lines and a count", () => {
    const events = Array.from({ length: 13 }, (_, at) => update(`Page ${at}`, ""));
    const { text } = bodyOf({ kind: "slack", url: "https://hooks.slack.com/services/x" }, ...events);
    expect(text.split("\n")).toHaveLength(11);
    expect(text.endsWith("… and 3 more")).toBe(true);
  });

  it("gives a program the whole event, signed over the time and the body", () => {
    const request = render({ kind: "generic", url: "https://example.com/in", secret: "s3cret" }, update());
    const body = request.body as string;
    expect(JSON.parse(body)).toMatchObject({ id: "delivery-1", site: "https://docs.example.com", event: "page.updated", revision: 3, page: { title: "Returns", url: "https://docs.example.com/shop/guides/returns" }, actor: { name: "Ben" } });
    expect(request.headers!["X-Pandocs-Event"]).toBe("page.updated");
    expect(request.headers!["X-Pandocs-Delivery"]).toBe("delivery-1");
    expect(request.headers!["X-Pandocs-Signature"]).toBe(`t=1700000000,v1=${createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex")}`);
    expect(render({ kind: "generic", url: "https://example.com/in" }, update()).headers).not.toHaveProperty("X-Pandocs-Signature");
  });

  it("links a comment to its discussion and a suggestion to the suggestion", () => {
    const { thread: _thread, ...base } = { ...update(), thread: undefined };
    const comment = bodyOf({ kind: "slack", url: "https://hooks.slack.com/services/x" }, { ...base, event: "comment.created", thread: { id: "t1", comment: "Is this right?" } });
    expect(comment.text).toBe("Ben commented on a page: <https://docs.example.com/shop/guides/returns?thread=t1|Returns>\n> Is this right?");
    const decided = bodyOf({ kind: "slack", url: "https://hooks.slack.com/services/x" }, { ...base, event: "proposal.decided", proposal: { id: "p1", status: "rejected", rationale: "" } });
    expect(decided.text).toContain("Ben rejected a suggestion: <https://docs.example.com/shop/guides/returns?proposal=p1|Returns>");
    const anonymous = bodyOf({ kind: "slack", url: "https://hooks.slack.com/services/x" }, { ...base, event: "feedback.created", actor: { name: "", kind: "user" }, feedback: { kind: "report", body: "Wrong", quote: "" } });
    expect(anonymous.text).toContain("A reader left feedback");
  });
});

describe("what counts as a private network", () => {
  it("covers every way of writing one", () => {
    for (const [address, family] of [["127.0.0.1", 4], ["169.254.169.254", 4], ["10.1.2.3", 4], ["100.64.0.1", 4], ["0.0.0.0", 4], ["::1", 6], ["::", 6], ["::ffff:127.0.0.1", 6], ["::ffff:a9fe:a9fe", 6], ["::127.0.0.1", 6], ["fe80::1", 6], ["fec0::1", 6], ["fd00::1", 6], ["64:ff9b::7f00:1", 6], ["64:ff9b:1::1", 6], ["2002:7f00:1::", 6], ["2001:0:4136:e378::1", 6]] as const) expect(isPrivate(address, family), address).toBe(true);
    for (const [address, family] of [["8.8.8.8", 4], ["2606:4700:4700::1111", 6], ["::ffff:8.8.8.8", 6]] as const) expect(isPrivate(address, family), address).toBe(false);
  });
});

describe("sending", () => {
  let server: Server;
  let origin = "";
  let reply: (request: IncomingMessage, body: string) => { status?: number; body?: string; headers?: Record<string, string> } = () => ({});
  const received: { url: string; body: string; headers: IncomingMessage["headers"] }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        received.push({ url: request.url!, body, headers: request.headers });
        const answer = reply(request, body);
        response.writeHead(answer.status ?? 200, answer.headers).end(answer.body ?? "ok");
      });
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    received.length = 0;
    reply = () => ({});
  });
  afterAll(() => new Promise(done => server.close(done)));

  const inside = () => createWebhookSender({ publicUrl: PUBLIC_URL, allowPrivate: true });
  const outside = () => createWebhookSender({ publicUrl: PUBLIC_URL, allowPrivate: false });

  it("posts JSON and says it worked", async () => {
    const result = await inside().send({ kind: "generic", url: `${origin}/in`, secret: "" }, messageOf(update()));
    expect(result).toEqual({ ok: true, status: 200, error: null });
    expect(received[0]!.url).toBe("/in");
    expect(received[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(received[0]!.headers["user-agent"]).toBe("Pandocs-Webhook");
    expect(JSON.parse(received[0]!.body).event).toBe("page.updated");
  });

  it("does not take a chat service's word for it when the status says yes and the body says no", async () => {
    reply = () => ({ body: JSON.stringify({ code: 19021, msg: "sign match fail or timestamp is not within one hour from current time" }) });
    const feishu = await inside().send({ kind: "feishu", url: `${origin}/f`, secret: "s" }, messageOf(update()));
    expect(feishu).toMatchObject({ ok: false, status: 200 });
    expect(feishu.error).toContain("19021");
    reply = () => ({ body: JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }) });
    expect((await inside().send({ kind: "wecom", url: `${origin}/w`, secret: "" }, messageOf(update()))).error).toContain("93000");
    expect((await inside().send({ kind: "dingtalk", url: `${origin}/d`, secret: "" }, messageOf(update()))).error).toContain("93000");
    reply = () => ({ body: JSON.stringify({ code: 0, msg: "success", data: {} }) });
    expect((await inside().send({ kind: "feishu", url: `${origin}/f`, secret: "s" }, messageOf(update()))).ok).toBe(true);
    reply = () => ({ body: JSON.stringify({ errcode: 0, errmsg: "ok" }) });
    expect((await inside().send({ kind: "wecom", url: `${origin}/w`, secret: "" }, messageOf(update()))).ok).toBe(true);
    reply = () => ({ status: 202, body: "" });
    expect((await inside().send({ kind: "teams", url: `${origin}/t`, secret: "" }, messageOf(update()))).ok).toBe(true);
  });

  it("counts anything but a yes as a failure, without saying what the other side answered", async () => {
    reply = () => ({ status: 500, body: "internal details of that system" });
    const result = await inside().send({ kind: "generic", url: `${origin}/in`, secret: "" }, messageOf(update()));
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result.error).not.toContain("internal details");
  });

  it("does not follow a redirect, which could lead anywhere", async () => {
    reply = request => (request.url === "/in" ? { status: 302, headers: { location: `${origin}/elsewhere` } } : {});
    const result = await inside().send({ kind: "generic", url: `${origin}/in`, secret: "" }, messageOf(update()));
    expect(result).toMatchObject({ ok: false, status: 302 });
    expect(received.map(item => item.url)).toEqual(["/in"]);
  });

  it("gives up on an answer that does not come", async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>(done => silent.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/`;
    const result = await createWebhookSender({ publicUrl: PUBLIC_URL, allowPrivate: true, timeoutMs: 100 }).send({ kind: "generic", url, secret: "" }, messageOf(update()));
    expect(result).toEqual({ ok: false, status: null, error: "No answer in time" });
    silent.closeAllConnections();
    await new Promise(done => silent.close(done));
  });

  it("stops reading an answer that goes on and on", async () => {
    reply = () => ({ body: "x".repeat(1024 * 1024) });
    const result = await inside().send({ kind: "generic", url: `${origin}/in`, secret: "" }, messageOf(update()));
    expect(result).toEqual({ ok: true, status: 200, error: null });
  });

  it.each([
    "http://127.0.0.1:1/",
    "http://localhost:1/",
    "http://[::1]:1/",
    "http://[::ffff:127.0.0.1]:1/",
    "http://10.0.0.1:1/",
    "http://172.16.0.1:1/",
    "http://192.168.0.1:1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1:1/",
    "http://0.0.0.0:1/",
    "http://[fd00::1]:1/",
    "http://[fe80::1]:1/",
    "http://2130706433:1/",
    "http://0x7f.0.0.1:1/"
  ])("will not reach into the network it runs in: %s", async url => {
    const result = await outside().send({ kind: "generic", url, secret: "" }, messageOf(update()));
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("This address is on a private network, which hooks cannot reach unless the server allows it");
  });

  it("can be told private networks are fine", async () => {
    expect((await outside().send({ kind: "generic", url: `${origin}/in`, secret: "" }, messageOf(update()))).ok).toBe(false);
    expect(received).toEqual([]);
    expect((await inside().send({ kind: "generic", url: `${origin.replace("127.0.0.1", "localhost")}/in`, secret: "" }, messageOf(update()))).ok).toBe(true);
    expect(received).toHaveLength(1);
  });
});
