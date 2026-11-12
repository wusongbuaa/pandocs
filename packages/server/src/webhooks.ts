import { createHmac } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import type { WebhookEvent, WebhookMessage, WebhookSender, WebhookSendResult, WebhookTarget } from "@pandocs/core";
import { currentLanguage, t } from "@pandocs/i18n";
import { onSite } from "./config.js";

const TIMEOUT_MS = 10_000;
/** Only the first of an answer is of any interest, and whoever is answering need not be well behaved. */
const MAX_ANSWER_BYTES = 64 * 1024;
const LINES_IN_A_MESSAGE = 10;
const DETAIL_CHARS = 200;
/** Its limit is on the whole message, in bytes, and not much. */
const WECOM_MAX_BYTES = 4096;

const privateNetworks = new BlockList();
for (const [network, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) privateNetworks.addSubnet(network, bits, "ipv4");
for (const [network, bits] of [["::", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) privateNetworks.addSubnet(network, bits, "ipv6");

export const isPrivate = (address: string, family: number) => privateNetworks.check(address, family === 6 ? "ipv6" : "ipv4");

class PrivateAddressError extends Error {}

/** Checked at the moment of connecting, so a name that resolves to something else by then gets no further than one that always did. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address as string, family as number);
      return;
    }
    const found: readonly LookupAddress[] = typeof address === "string" ? [{ address, family: family as number }] : address;
    if (found.some(item => isPrivate(item.address, item.family))) {
      callback(Object.assign(new PrivateAddressError(hostname), { code: "EPRIVATE" }), address as string, family as number);
      return;
    }
    callback(null, address as string, family as number);
  });
};

interface Line {
  /** Who did what. */
  readonly summary: string;
  readonly title: string;
  readonly url: string;
  /** What they said about it. */
  readonly detail: string;
}

function urlOf(publicUrl: URL, event: WebhookEvent): string {
  if (event.changeSet && event.space) return onSite(publicUrl, `/_/spaces/${encodeURIComponent(event.space.slug)}/change-sets?id=${event.changeSet.id}`);
  if (!event.space || !event.page) return onSite(publicUrl, "");
  const path = event.page.path.split("/").map(encodeURIComponent).join("/");
  const query = event.thread ? `?thread=${event.thread.id}` : event.proposal ? `?proposal=${event.proposal.id}` : "";
  return onSite(publicUrl, `/${encodeURIComponent(event.space.slug)}/${path}${query}`);
}

function summaryOf(event: WebhookEvent): string {
  const who = event.actor?.name || t("A reader");
  switch (event.event) {
    case "page.created": return t("{0} created a page", who);
    case "page.updated": return t("{0} updated a page", who);
    case "page.moved": return t("{0} moved a page", who);
    case "page.deleted": return t("{0} deleted a page", who);
    case "page.restored": return t("{0} restored a page", who);
    case "comment.created": return t("{0} commented on a page", who);
    case "thread.resolved": return t("{0} resolved a discussion", who);
    case "proposal.created": return t("{0} suggested a change", who);
    case "proposal.decided": return event.proposal?.status === "accepted" ? t("{0} accepted a suggestion", who) : t("{0} rejected a suggestion", who);
    case "feedback.created": return t("{0} left feedback", who);
    case "change_set.created": return t("{0} started a change set", who);
    case "change_set.reviewed": return event.changeSet?.verdict === "approved" ? t("{0} approved a change set", who) : t("{0} asked for changes to a change set", who);
    case "change_set.merged": return t("{0} merged a change set", who);
    case "change_set.closed": return t("{0} closed a change set", who);
    case "ping": return t("A test message: this hook works");
  }
}

function lineOf(publicUrl: URL, event: WebhookEvent, siteTitle: string): Line {
  const detail = event.thread?.comment ?? event.feedback?.body ?? event.proposal?.rationale ?? event.message ?? "";
  return { summary: summaryOf(event), title: event.changeSet?.title ?? event.page?.title ?? siteTitle, url: urlOf(publicUrl, event), detail: detail.slice(0, DETAIL_CHARS) };
}

/** Square brackets end a link and angle brackets are how some of these mention everybody. Neither should come from a page's title. */
const wider = (character: string) => String.fromCodePoint(character.codePointAt(0)! + 0xfee0);
const inert = (text: string) => text.replace(/[<>]/gu, wider);
const linkText = (text: string) => inert(text).replace(/[[\]]/gu, wider);
const quoted = (text: string) => text.replace(/\s*\n\s*/gu, " ");
const slackText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const markdownLine = (line: Line) => `${inert(line.summary)}: [${linkText(line.title)}](${line.url})${line.detail ? `\n> ${inert(quoted(line.detail))}` : ""}`;

/** What is left out is at least counted. */
function shown(lines: readonly Line[]): { readonly lines: readonly Line[]; readonly more: string | null } {
  const kept = lines.slice(0, LINES_IN_A_MESSAGE);
  return { lines: kept, more: lines.length > kept.length ? t("… and {0} more", lines.length - kept.length) : null };
}

interface Request {
  readonly url: URL;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const hmac = (key: string, message: string) => createHmac("sha256", key).update(message).digest("base64");

const renderers: Readonly<Record<WebhookTarget["kind"], (target: WebhookTarget, lines: readonly Line[], siteTitle: string, now: number) => Request>> = {
  generic: () => { throw new Error("A generic hook is not sent as lines"); },
  slack(target, all) {
    const { lines, more } = shown(all);
    const text = lines.map(line => `${slackText(line.summary)}: <${line.url}|${slackText(line.title)}>${line.detail ? `\n> ${slackText(quoted(line.detail))}` : ""}`);
    return { url: new URL(target.url), body: { text: [...text, ...(more ? [more] : [])].join("\n") } };
  },
  feishu(target, all, siteTitle, now) {
    const { lines, more } = shown(all);
    const timestamp = String(Math.floor(now / 1000));
    const rows = lines.map(line => [
      { tag: "text", text: `${line.summary}: ` },
      { tag: "a", text: line.title, href: line.url },
      ...(line.detail ? [{ tag: "text", text: `\n${quoted(line.detail)}` }] : [])
    ]);
    const post = { title: siteTitle, content: [...rows, ...(more ? [[{ tag: "text", text: more }]] : [])] };
    return {
      url: new URL(target.url),
      body: {
        // The key is made from these two, and what gets signed is nothing at all.
        ...(target.secret ? { timestamp, sign: hmac(`${timestamp}\n${target.secret}`, "") } : {}),
        msg_type: "post",
        content: { post: { [currentLanguage() === "zh" ? "zh_cn" : "en_us"]: post } }
      }
    };
  },
  wecom(target, all) {
    const textOf = (count: number) => [...all.slice(0, count).map(markdownLine), ...(all.length > count ? [t("… and {0} more", all.length - count)] : [])].join("\n");
    let count = Math.min(all.length, LINES_IN_A_MESSAGE);
    while (count > 1 && Buffer.byteLength(textOf(count)) > WECOM_MAX_BYTES) count -= 1;
    return { url: new URL(target.url), body: { msgtype: "markdown", markdown: { content: textOf(count) } } };
  },
  dingtalk(target, all, siteTitle, now) {
    const { lines, more } = shown(all);
    const url = new URL(target.url);
    if (target.secret) {
      const timestamp = String(now);
      url.searchParams.set("timestamp", timestamp);
      url.searchParams.set("sign", hmac(target.secret, `${timestamp}\n${target.secret}`));
    }
    return { url, body: { msgtype: "markdown", markdown: { title: siteTitle, text: [...lines.map(markdownLine), ...(more ? [more] : [])].join("\n\n") } } };
  },
  teams(target, all) {
    const { lines, more } = shown(all);
    const body = lines.flatMap(line => [
      { type: "TextBlock", wrap: true, text: `${line.summary}: [${linkText(line.title)}](${line.url})` },
      ...(line.detail ? [{ type: "TextBlock", wrap: true, isSubtle: true, spacing: "None", text: quoted(line.detail) }] : [])
    ]);
    return {
      url: new URL(target.url),
      body: {
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2", body: [...body, ...(more ? [{ type: "TextBlock", wrap: true, text: more }] : [])] }
        }]
      }
    };
  }
};

/** Everything that happened, for a program. Signed over the time and the body, so an old message cannot be replayed under a new date. */
function genericRequest(target: WebhookTarget, message: WebhookMessage, publicUrl: URL, now: number): Request {
  const [event] = message.events as [WebhookEvent];
  const body = JSON.stringify({ id: message.id, site: onSite(publicUrl, ""), ...event, ...(event.page ? { page: { ...event.page, url: urlOf(publicUrl, event) } } : {}) });
  const timestamp = Math.floor(now / 1000);
  return {
    url: new URL(target.url),
    body,
    headers: {
      "X-Pandocs-Event": event.event,
      "X-Pandocs-Delivery": message.id,
      ...(target.secret ? { "X-Pandocs-Signature": `t=${timestamp},v1=${createHmac("sha256", target.secret).update(`${timestamp}.${body}`).digest("hex")}` } : {})
    }
  };
}

/** Exported for the tests: what a message looks like is the part that has to match someone else's documentation. */
export function renderWebhook(target: WebhookTarget, message: WebhookMessage, publicUrl: URL, now = Date.now()): Request {
  if (target.kind === "generic") return genericRequest(target, message, publicUrl, now);
  return renderers[target.kind](target, message.events.map(event => lineOf(publicUrl, event, message.siteTitle)), message.siteTitle, now);
}

/** Chat services answer 200 to many things that went wrong, and say so in the body. */
function answerProblem(kind: WebhookTarget["kind"], text: string): string | null {
  if (kind !== "feishu" && kind !== "wecom" && kind !== "dingtalk") return null;
  let answer: { code?: unknown; msg?: unknown; errcode?: unknown; errmsg?: unknown };
  try {
    answer = JSON.parse(text) as typeof answer;
  } catch {
    return null;
  }
  const code = kind === "feishu" ? answer.code : answer.errcode;
  if (code === undefined || code === 0) return null;
  return `${String(code)}: ${String((kind === "feishu" ? answer.msg : answer.errmsg) ?? "")}`.slice(0, 300);
}

export function createWebhookSender(deps: { readonly publicUrl: URL; readonly allowPrivate: boolean; readonly timeoutMs?: number }): WebhookSender {
  const { publicUrl, allowPrivate, timeoutMs = TIMEOUT_MS } = deps;

  const post = (request: Request) => new Promise<{ status: number; text: string }>((resolve, reject) => {
    const { url } = request;
    const host = url.hostname.replace(/^\[|\]$/gu, "");
    // No name to look up, so the check on names would not see it.
    if (!allowPrivate && isIP(host) && isPrivate(host, isIP(host))) {
      reject(new PrivateAddressError(host));
      return;
    }
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const outgoing = (url.protocol === "https:" ? https : http).request(url, {
      method: "POST",
      agent: false,
      ...(allowPrivate ? {} : { lookup: guardedLookup }),
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "User-Agent": "Pandocs-Webhook", ...request.headers }
    }, incoming => {
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
        else incoming.destroy();
      });
      const finish = () => resolve({ status: incoming.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      incoming.on("end", finish);
      incoming.on("close", finish);
      incoming.on("error", finish);
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });

  return {
    async send(target, message): Promise<WebhookSendResult> {
      try {
        const { status, text } = await post(renderWebhook(target, message, publicUrl));
        // Following a redirect would go somewhere nobody checked, so one counts as a failure like anything else that is not a yes.
        if (status < 200 || status >= 300) return { ok: false, status, error: t("The other side answered {0}", status) };
        const problem = answerProblem(target.kind, text);
        return problem ? { ok: false, status, error: t("The other side refused it: {0}", problem) } : { ok: true, status, error: null };
      } catch (error) {
        if (error instanceof PrivateAddressError || (error as { cause?: unknown }).cause instanceof PrivateAddressError) return { ok: false, status: null, error: t("This address is on a private network, which hooks cannot reach unless the server allows it") };
        const reason = error instanceof Error ? (error.name === "TimeoutError" || error.name === "AbortError" ? t("No answer in time") : error.message) : String(error);
        return { ok: false, status: null, error: reason.slice(0, 300) };
      }
    }
  };
}
