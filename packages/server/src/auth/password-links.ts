import { t } from "@pandocs/i18n";
import type pg from "pg";
import type { Mailer } from "../mail.js";
import { hashToken, newToken } from "./sessions.js";
import { mapUser, type User } from "./users.js";
import { onSite } from "../config.js";

const INVITATION_HOURS = 7 * 24;
const FORGOTTEN_HOURS = 1;

export interface PasswordLink {
  readonly url: string;
  readonly expiresAt: Date;
  /** Whether it also went to their mailbox. The link is given either way, since mail can fail. */
  readonly emailed: boolean;
}

export function createPasswordLinks(input: { pool: pg.Pool; publicUrl: URL; enabled: boolean; mail: Mailer | null; siteTitle: () => Promise<string> }) {
  const { pool, publicUrl, enabled, mail, siteTitle } = input;

  /** Only the newest one works, so making another takes back the one before. */
  const create = async (userId: string, hours: number) => {
    const token = newToken();
    const { rows } = await pool.query<{ expires_at: Date }>(
      `WITH gone AS (DELETE FROM pandocs.password_links WHERE user_id = $2)
       INSERT INTO pandocs.password_links (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3)) RETURNING expires_at`,
      [hashToken(token), userId, hours]
    );
    return { url: onSite(publicUrl, `/set-password/${token}`), expiresAt: new Date(rows[0]!.expires_at) };
  };

  const deliver = async (to: string, subject: string, text: string, url: string): Promise<boolean> => {
    if (!mail) return false;
    try {
      await mail({ to, subject, text, html: `<p>${text.replace(/[&<>"']/gu, character => `&#${character.charCodeAt(0)};`).replace(url.replace(/&/gu, "&#38;"), `<a href="${url}">${url}</a>`).replace(/\n\n/gu, "</p><p>")}</p>` });
      return true;
    } catch (error) {
      console.error(JSON.stringify({ event: "mail.password_link_failed", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : "" }));
      return false;
    }
  };

  const issue = async (person: User, write: (title: string, url: string) => { subject: string; text: string }): Promise<PasswordLink> => {
    const link = await create(person.id, INVITATION_HOURS);
    const { subject, text } = write(await siteTitle(), link.url);
    return { ...link, emailed: await deliver(person.email, subject, text, link.url) };
  };

  return {
    enabled,
    /** Without mail, someone who forgot has to ask; the page says so instead of promising a message that never comes. */
    selfService: enabled && Boolean(mail),
    invite: (person: User, inviter: string) => issue(person, (title, url) => ({
      subject: t("{0} added you to {1}", inviter, title),
      text: t("{0} added you to {1}. Choose a password to sign in:\n\n{2}\n\nThe link works once, within 7 days.", inviter, title, url)
    })),
    reissue: (person: User, admin: string) => issue(person, (title, url) => ({
      subject: t("Choose a new password for {0}", title),
      text: t("{0} asked for you to choose a new password for {1}:\n\n{2}\n\nThe link works once, within 7 days.", admin, title, url)
    })),
    async forgotten(person: User): Promise<void> {
      const { url } = await create(person.id, FORGOTTEN_HOURS);
      const title = await siteTitle();
      await deliver(person.email, t("Choose a new password for {0}", title), t("Someone asked to reset the password of your account on {0}. Choose a new one here:\n\n{1}\n\nThe link works once, within an hour. If it was not you, you can ignore this.", title, url), url);
    },
    async userOf(token: string): Promise<User | null> {
      const { rows } = await pool.query(
        `SELECT u.* FROM pandocs.password_links l JOIN pandocs.users u ON u.id = l.user_id
         WHERE l.token_hash = $1 AND l.expires_at > now() AND u.status = 'active'`,
        [hashToken(token)]
      );
      return rows[0] ? mapUser(rows[0]) : null;
    },
    /** Deleting it is what decides who got there first, so two tabs cannot both set a password. Other sessions end: a reset is often because of them. */
    async use(token: string, passwordHash: string): Promise<User | null> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: links } = await client.query<{ user_id: string }>(`DELETE FROM pandocs.password_links WHERE token_hash = $1 AND expires_at > now() RETURNING user_id`, [hashToken(token)]);
        const userId = links[0]?.user_id;
        const { rows } = userId ? await client.query(`UPDATE pandocs.users SET password_hash = $1, updated_at = now() WHERE id = $2 AND status = 'active' RETURNING *`, [passwordHash, userId]) : { rows: [] };
        if (rows[0]) await client.query(`DELETE FROM pandocs.sessions WHERE user_id = $1`, [userId]);
        await client.query("COMMIT");
        return rows[0] ? mapUser(rows[0]) : null;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

export type PasswordLinks = ReturnType<typeof createPasswordLinks>;
