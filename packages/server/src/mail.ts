import { randomUUID } from "node:crypto";
import type { NotificationEvent, Notifier } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { UserStore } from "./auth/users.js";
import { onSite, type SmtpConfig } from "./config.js";

const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`);

type Send = (message: SendMailOptions) => Promise<unknown>;
export type Mailer = (message: {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}) => Promise<unknown>;

const transportOf = (smtp: SmtpConfig) =>
  nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    // Someone may be waiting on this, and the defaults are minutes.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.password ?? "" } } : {})
  });

/** For a message to one person about their own account. */
export function createMailer(smtp: SmtpConfig, publicUrl: URL): Mailer {
  const transport = transportOf(smtp);
  return message =>
    transport.sendMail({ ...message, messageId: `<pandocs-${randomUUID()}@${publicUrl.hostname}>`, from: smtp.from });
}

function subjectOf({ kind, actorName, documentTitle, alsoUpdated = [] }: NotificationEvent): string {
  switch (kind) {
    case "mention":
      return t('{0} mentioned you in "{1}"', actorName, documentTitle);
    case "reply":
      return t('{0} replied in "{1}"', actorName, documentTitle);
    case "proposal_decided":
      return t('{0} decided on a suggestion for "{1}"', actorName, documentTitle);
    case "page_updated":
      return alsoUpdated.length > 0
        ? t('"{0}" and {1} more pages were updated', documentTitle, alsoUpdated.length)
        : t('{0} updated "{1}"', actorName, documentTitle);
  }
}

/** People learn they were mentioned from the bell in the app; mail reaches them when the tab is closed. */
export function createMailNotifier(input: {
  smtp: SmtpConfig;
  publicUrl: URL;
  users: UserStore;
  send?: Send;
}): Notifier {
  const { smtp, publicUrl, users } = input;
  const transport = input.send ? null : transportOf(smtp);
  const send: Send = input.send ?? (message => transport!.sendMail(message));
  return {
    async notify(event) {
      const recipient = await users.findById(event.recipientId);
      // A host that vouches for someone without their address leaves one that is plainly no mailbox.
      if (!recipient || recipient.status !== "active" || recipient.email.endsWith(".invalid")) return;
      const urlOf = (location: string) => {
        const [path = "", query] = location.split("?");
        return onSite(publicUrl, `/${path.split("/").map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`);
      };
      const url = urlOf(event.location);
      const others = (event.alsoUpdated ?? []).map(page => ({ title: page.documentTitle, url: urlOf(page.location) }));
      await send({
        messageId: `<pandocs-${randomUUID()}@${publicUrl.hostname}>`,
        from: smtp.from,
        to: recipient.email,
        subject: subjectOf(event),
        text: [
          t("{0}\n\nOpen the document: {1}", event.summary, url),
          ...others.map(page => `${page.title}: ${page.url}`)
        ]
          .join("\n")
          .trimStart(),
        html: `${event.summary ? `<p>${escapeHtml(event.summary)}</p>` : ""}<p><a href="${escapeHtml(url)}">${t("Open the document")}</a></p>${others.length > 0 ? `<ul>${others.map(page => `<li><a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a></li>`).join("")}</ul>` : ""}`
      });
    }
  };
}
