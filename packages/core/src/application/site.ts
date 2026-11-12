import { t } from "@pandocs/i18n";
import { z } from "zod";
import { canChangeSite } from "../domain/access.js";
import { forbidden, invalid } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import { audit, type AppContext } from "./context.js";

/** Goes into links on every page, so it cannot carry a script even for an administrator's typo or a copied snippet. */
const url = z
  .string()
  .min(1)
  .max(2000)
  .refine(value => !/^(?:javascript|vbscript|data):/iu.test(value.replace(/[\p{Cc}\s]/gu, "")), {
    error: () => t("A link cannot start with a script protocol")
  });
/** The languages the theme has interface text for. */
const language = z.enum(["zh", "en", "ja", "ko", "ru", "ta"]);

/**
 * A favicon goes into every page as it is, so it is an address or a small uploaded image, and nothing else: a data URL
 * of any other kind could be a document rather than an image.
 */
const FAVICON =
  /^(?:https?:\/\/\S+|\/(?!\/)\S*|data:image\/(?:png|svg\+xml|x-icon|vnd\.microsoft\.icon|gif|webp);base64,[A-Za-z0-9+/]+=*)$/u;

/** Pandocs' own green, a shade deeper than the logo's, so that links and the white text on buttons stay readable. */
export const DEFAULT_BRAND_COLOR = "#159c5d";

const navItem = z
  .object({
    text: z.string().min(1).max(60),
    link: url.optional(),
    items: z
      .array(z.object({ text: z.string().min(1).max(60), link: url }))
      .max(20)
      .optional()
  })
  .strict();

export const siteSettingsSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(500),
    /** A URL, or an uploaded image kept as a data URL: the site has no space to keep an asset in. */
    logo: z.string().max(150_000),
    /** The icon in browser tabs, empty for Pandocs' own. Every page carries it, which is why it is kept small. */
    favicon: z
      .string()
      .max(24_000)
      .refine(value => value === "" || FAVICON.test(value), {
        error: () => t("A favicon is an image's address, or an uploaded PNG, SVG or ICO file")
      }),
    footer: z.string().max(2000),
    defaultLang: language,
    /** One locale hides the language switch; the routes, sidebars and interface text follow this list. */
    locales: z
      .array(z.object({ lang: language, label: z.string().min(1).max(30) }).strict())
      .min(1)
      .max(6),
    /** `null` lists the spaces a person can see. */
    nav: z.array(navItem).max(20).nullable(),
    socialLinks: z.array(z.object({ icon: z.string().min(1).max(30), link: url }).strict()).max(10),
    /** Other applications next to this one, shown in the switcher left of the logo. */
    appLinks: z.array(z.object({ text: z.string().min(1).max(60), link: url }).strict()).max(20),
    /** Host actions on the selection toolbar and the page menu. `{url}`, `{title}` and `{text}` are filled in; `copy` goes to the clipboard first. */
    actions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(40),
            label: z.string().min(1).max(40),
            href: url,
            copy: z.string().max(2000).optional()
          })
          .strict()
      )
      .max(10),
    /** How long deleted pages stay in the trash; `null` keeps them until someone removes them. */
    trashRetentionDays: z.number().int().min(1).max(3650).nullable(),
    /** The host's sign-out endpoint, which takes a POST. Empty when the host has no such thing. */
    logoutUrl: z.string().max(2000),
    /** Whether someone with no login can ask the site's AI, which the site pays for. */
    askForVisitors: z.boolean(),
    /** The brand colour, as `#rrggbb`, or empty for Pandocs' green. */
    brandColor: z.string().regex(/^(?:#[0-9a-f]{6})?$/iu, { error: () => t("A brand colour is written like #0095ff") }),
    /** Loaded last on every page. Only administrators can write it, and it can do no more than style a page: it goes out as a stylesheet, under the page's policy. */
    customCss: z.string().max(100_000)
  })
  .strict();

export type SiteSettings = z.infer<typeof siteSettingsSchema>;

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  title: "Pandocs",
  description: "",
  logo: "",
  favicon: "",
  footer: "",
  defaultLang: "en",
  locales: [{ lang: "en", label: "English" }],
  nav: null,
  socialLinks: [],
  appLinks: [],
  actions: [],
  trashRetentionDays: null,
  logoutUrl: "",
  askForVisitors: false,
  brandColor: "",
  customCss: ""
};

/** Handing out a field an older version stored would make the settings page's next save fail validation. */
function currentFields(stored: Partial<SiteSettings> | undefined): Partial<SiteSettings> {
  return Object.fromEntries(Object.entries(stored ?? {}).filter(([key]) => key in siteSettingsSchema.shape));
}

const toHex = (channels: readonly number[]) =>
  `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
const mixed = (from: readonly number[], to: number, amount: number) =>
  from.map(channel => channel + (to - channel) * amount);

/**
 * The theme's front page fades from its blue to purple. With the green, it fades to teal, and its background glows green.
 * A site with a colour of its own keeps the theme's, which was made for blue.
 */
const GREEN_FRONT_PAGE = `html:not(.rp-dark) {
  --rp-home-hero-secondary-color: #14b8a6;
  --rp-home-background-bg:
    radial-gradient(42.12% 56.13% at 100% 0%, rgba(20, 184, 166, 0.1) 0%, rgba(255, 255, 255, 0) 100%),
    radial-gradient(42.01% 79.63% at 52.86% 0%, rgba(34, 181, 115, 0.18) 0%, rgba(255, 255, 255, 0) 100%),
    radial-gradient(79.67% 58.09% at 0% 0%, rgba(95, 211, 154, 0.2) 0%, rgba(255, 255, 255, 0) 100%),
    #fff;
}
html.rp-dark {
  --rp-home-hero-secondary-color: #2dd4bf;
  --rp-home-background-bg:
    radial-gradient(42.12% 56.13% at 100% 0%, #0a3326 0%, rgba(18, 18, 18, 0) 100%),
    radial-gradient(55.81% 87.78% at 48.37% 0%, #000000 0%, rgba(18, 18, 18, 0) 89.55%),
    radial-gradient(122.65% 88.24% at 0% 0%, #0f3d33 0%, rgba(18, 18, 18, 0) 100%),
    #121212;
}`;

/**
 * The theme works out everything from these variables: its links use the dark shade on a light page and the light shade
 * on a dark one. The sign-in pages, which are not the theme's, use the same ones.
 */
export function brandStyles(brandColor: string): string {
  const brand = brandColor || DEFAULT_BRAND_COLOR;
  const channels = [1, 3, 5].map(at => Number.parseInt(brand.slice(at, at + 2), 16));
  return `:root {
  --rp-c-brand: ${brand};
  --rp-c-brand-light: ${toHex(mixed(channels, 255, 0.2))};
  --rp-c-brand-lighter: ${toHex(mixed(channels, 255, 0.75))};
  --rp-c-brand-dark: ${toHex(mixed(channels, 0, 0.1))};
  --rp-c-brand-darker: ${toHex(mixed(channels, 0, 0.25))};
  --rp-c-brand-tint: rgba(${channels.join(", ")}, 0.16);
}`;
}

/** The site's own look, as the stylesheet every page loads after the theme's. */
export function siteStyles({ brandColor, customCss }: Pick<SiteSettings, "brandColor" | "customCss">): string {
  const parts = [brandStyles(brandColor)];
  if (!brandColor) parts.push(GREEN_FRONT_PAGE);
  if (customCss.trim()) parts.push(customCss);
  return `${parts.join("\n\n")}\n`;
}

export class SiteService {
  constructor(private readonly context: AppContext) {}

  private get defaults(): SiteSettings {
    return { ...DEFAULT_SITE_SETTINGS, ...this.context.ports.siteDefaults };
  }

  /** Stored fields win over the host's defaults, so an environment works before anyone opens the settings page. */
  async get(): Promise<SiteSettings> {
    const { rows } = await this.context.db.query<{ settings: Partial<SiteSettings> }>(
      `SELECT settings FROM pandocs.site_settings`
    );
    return { ...this.defaults, ...currentFields(rows[0]?.settings) };
  }

  /** For what the host looks after around the site, such as accounts, which belongs on the same record. */
  async record(principal: Principal, action: string, target: string, detail: object): Promise<void> {
    await audit(this.context.db, principal, action, "site", target, detail);
  }

  async update(
    principal: Principal,
    patch: { readonly [Key in keyof SiteSettings]?: SiteSettings[Key] | undefined }
  ): Promise<SiteSettings> {
    if (!canChangeSite(principal)) throw forbidden(t("Only administrators can change site settings"));
    return this.context.db.transaction(async tx => {
      await tx.query(
        `INSERT INTO pandocs.site_settings (id, settings, updated_by) VALUES (true, $1, $2)
         ON CONFLICT (id) DO UPDATE SET settings = pandocs.site_settings.settings || EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(patch), principal.id]
      );
      await audit(tx, principal, "site.update", "site", "site", { fields: Object.keys(patch) });
      const { rows } = await tx.query<{ settings: Partial<SiteSettings> }>(
        `SELECT settings FROM pandocs.site_settings`
      );
      const settings = { ...this.defaults, ...currentFields(rows[0]?.settings) };
      // No page can be rendered in a language the site does not have.
      if (!settings.locales.some(locale => locale.lang === settings.defaultLang))
        throw invalid("SITE_LANGUAGE_INVALID", t("The default language has to be one of the site's languages"));
      return settings;
    });
  }
}
