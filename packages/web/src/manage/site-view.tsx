import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CheckboxField,
  ColorField,
  FieldShell,
  Form,
  NumberInput,
  SelectField,
  SwitchField,
  TextField,
  TextareaField
} from "../ui/form";
import { api } from "../api/client";
import { app } from "../data/runtime-data";
import type { SiteSettings } from "../types";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { LoadedContent, ManageHead, RowsEditor } from "./parts";
import { t } from "../i18n";
import { sitePath } from "../data/site-base";

const MAX_LOGO_BYTES = 100 * 1024;
/** Every page carries the favicon, so it is kept small; the server allows a little more for the data URL around it. */
const MAX_FAVICON_BYTES = 16 * 1024;
/** The same as DEFAULT_BRAND_COLOR in @pandocs/core, which the pages use when this is left empty. */
const DEFAULT_BRAND = "#159c5d";
const BRAND_COLOR = /^#[0-9a-f]{6}$/iu;
const LANGUAGES = [
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "ru", label: "Русский" },
  { value: "ta", label: "தமிழ்" }
] as const;
const SOCIAL_ICONS = [
  "lark",
  "github",
  "gitlab",
  "x",
  "discord",
  "wechat",
  "bilibili",
  "juejin",
  "zhihu",
  "youtube",
  "npm",
  "linkedin",
  "slack"
];

function SiteForm({ initial }: { initial: SiteSettings }) {
  const [site, setSite] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const logoInput = React.useRef<HTMLInputElement>(null);
  const faviconInput = React.useRef<HTMLInputElement>(null);
  const set = <Key extends keyof SiteSettings>(key: Key, value: SiteSettings[Key]) =>
    setSite(current => ({ ...current, [key]: value }));
  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      toast(t("A logo can be at most 100 KB"), "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set("logo", String(reader.result));
    reader.readAsDataURL(file);
  };
  const pickFavicon = (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FAVICON_BYTES) {
      toast(t("A favicon can be at most 16 KB"), "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => set("favicon", String(reader.result));
    reader.readAsDataURL(file);
  };
  const save = async () => {
    const nav = site.nav?.filter(item => item.text.trim()) ?? null;
    await api.send("PATCH", "site", { body: { ...site, nav } });
    // Everything here shapes the theme's data, which is built when the app loads.
    location.reload();
  };
  return (
    <Form className="pd-form pd-form--wide" onSubmit={save} onBusyChange={setBusy}>
      <h2>{t("General")}</h2>
      <TextField
        name="title"
        label={t("Site name")}
        required
        value={site.title}
        onChange={event => set("title", event.target.value)}
      />
      <TextField
        label={t("Description")}
        description={t("Shown on the site's front page.")}
        value={site.description}
        onChange={event => set("description", event.target.value)}
      />
      <FieldShell label="Logo">
        <div className="pd-logo">
          {site.logo ? <img src={site.logo} alt="" /> : null}
          <Input
            aria-label={t("Logo address")}
            value={site.logo.startsWith("data:") ? t("(uploaded image)") : site.logo}
            disabled={site.logo.startsWith("data:")}
            placeholder={t("Image address")}
            onChange={event => set("logo", event.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => logoInput.current?.click()}>
            {t("Upload")}
          </Button>
          {site.logo ? (
            <Button type="button" variant="ghost" onClick={() => set("logo", "")}>
              {t("Clear")}
            </Button>
          ) : null}
          <input
            ref={logoInput}
            type="file"
            accept="image/*"
            hidden
            onChange={event => {
              pickLogo(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </FieldShell>
      <FieldShell
        label={t("Favicon")}
        description={t(
          "The icon in browser tabs and bookmarks: square, as PNG, SVG or ICO, at most 16 KB. Without one, pages show the Pandocs icon."
        )}
      >
        <div className="pd-logo">
          <img src={site.favicon || sitePath("/favicon.svg")} alt="" />
          <Input
            aria-label={t("Favicon address")}
            value={site.favicon.startsWith("data:") ? t("(uploaded image)") : site.favicon}
            disabled={site.favicon.startsWith("data:")}
            placeholder={t("Image address")}
            onChange={event => set("favicon", event.target.value)}
          />
          <Button type="button" variant="outline" onClick={() => faviconInput.current?.click()}>
            {t("Upload")}
          </Button>
          {site.favicon ? (
            <Button type="button" variant="ghost" onClick={() => set("favicon", "")}>
              {t("Clear")}
            </Button>
          ) : null}
          <input
            ref={faviconInput}
            type="file"
            accept="image/png,image/svg+xml,image/x-icon,image/vnd.microsoft.icon,.ico"
            hidden
            onChange={event => {
              pickFavicon(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
      </FieldShell>
      <TextField label={t("Footer")} value={site.footer} onChange={event => set("footer", event.target.value)} />

      <h2>{t("Top navigation")}</h2>
      <SwitchField
        label={t("List the spaces each person can see")}
        checked={site.nav === null}
        onChange={on => set("nav", on ? null : [])}
      />
      {site.nav !== null ? (
        <RowsEditor
          rows={site.nav.map(item => ({ text: item.text, link: item.link ?? "" }))}
          columns={[
            { key: "text", label: t("Text shown") },
            { key: "link", label: t("Link"), placeholder: t("/manual/ or https://…") }
          ]}
          blank={{ text: "", link: "" }}
          addLabel={t("Add a navigation item")}
          onChange={rows => set("nav", rows)}
        />
      ) : null}

      <h2>{t("Appearance")}</h2>
      <ColorField
        label={t("Brand colour")}
        description={t("Links, buttons and what is selected use it, in a lighter shade on a dark page.")}
        error={
          site.brandColor && !BRAND_COLOR.test(site.brandColor)
            ? t("A colour looks like {0}", DEFAULT_BRAND)
            : undefined
        }
        value={site.brandColor}
        placeholder={DEFAULT_BRAND}
        onChange={value => set("brandColor", value)}
      >
        {site.brandColor ? (
          <Button type="button" variant="ghost" onClick={() => set("brandColor", "")}>
            {t("Use the default")}
          </Button>
        ) : null}
      </ColorField>
      <TextareaField
        label={t("Custom CSS")}
        description={t(
          "Loaded after the theme's styles on every page, for visitors too. Rules can refer to the theme's variables, such as {0}. A later version of the product can rename what they refer to.",
          "--rp-c-brand"
        )}
        mono
        rows={8}
        spellCheck={false}
        maxLength={100_000}
        value={site.customCss}
        onChange={event => set("customCss", event.target.value)}
      />

      <h2>{t("External links")}</h2>
      <p className="pd-muted">{t("Icons on the right of the top bar.")}</p>
      <RowsEditor
        rows={site.socialLinks}
        columns={[
          { key: "icon", label: t("Icon"), options: SOCIAL_ICONS },
          { key: "link", label: t("Link"), placeholder: "https://…" }
        ]}
        blank={{ icon: "", link: "" }}
        addLabel={t("Add a link")}
        onChange={rows => set("socialLinks", rows)}
      />

      <h2>{t("App switcher")}</h2>
      <p className="pd-muted">{t("The grid menu left of the logo, for jumping to your organization's other apps.")}</p>
      <RowsEditor
        rows={site.appLinks}
        columns={[
          { key: "text", label: t("Name") },
          { key: "link", label: t("Link") }
        ]}
        blank={{ text: "", link: "" }}
        addLabel={t("Add an app")}
        onChange={rows => set("appLinks", rows)}
      />

      <h2>{t("Toolbar and page menu")}</h2>
      <p className="pd-muted">
        {t(
          'These appear under "More" in the selection toolbar and in the page menu. Links and copied text can use {0}, {1} and {2}.',
          "{url}",
          "{title}",
          "{text}"
        )}
      </p>
      <RowsEditor
        rows={site.actions.map(action => ({
          id: action.id,
          label: action.label,
          href: action.href,
          copy: action.copy ?? ""
        }))}
        columns={[
          { key: "id", label: t("Identifier") },
          { key: "label", label: t("Name") },
          { key: "href", label: t("Link") },
          { key: "copy", label: t("Text to copy first (optional)") }
        ]}
        blank={{ id: "", label: "", href: "", copy: "" }}
        addLabel={t("Add an action")}
        onChange={rows =>
          set(
            "actions",
            rows.map(({ copy, ...rest }) => ({ ...rest, ...(copy ? { copy } : {}) }))
          )
        }
      />

      <h2>{t("Languages")}</h2>
      <p className="pd-muted">
        {t("The language switch only shows with more than one language. Each language has its own address prefix.")}
      </p>
      <SelectField
        label={t("Default language")}
        value={site.defaultLang}
        onChange={value => set("defaultLang", value)}
        choices={site.locales.map(locale => ({ value: locale.lang, label: locale.label }))}
      />
      <div className="pd-rows">
        {LANGUAGES.map(language => {
          const on = site.locales.some(locale => locale.lang === language.value);
          return (
            <CheckboxField
              key={language.value}
              label={language.label}
              checked={on}
              disabled={on && (site.locales.length === 1 || site.defaultLang === language.value)}
              onChange={checked =>
                set(
                  "locales",
                  checked
                    ? [...site.locales, { lang: language.value, label: language.label }]
                    : site.locales.filter(locale => locale.lang !== language.value)
                )
              }
            />
          );
        })}
      </div>

      <h2>{t("Trash")}</h2>
      <NumberInput
        label={t("Days to keep (empty keeps them until removed)")}
        min={1}
        max={3650}
        value={site.trashRetentionDays ?? null}
        onChange={value => set("trashRetentionDays", value)}
      />

      {app.bootstrap.ai?.configured ? (
        <>
          <h2>{t("Ask AI")}</h2>
          <SwitchField
            label={t(
              "People with no login can ask the AI about public pages. Each question is a call to the model, on this site's account."
            )}
            checked={site.askForVisitors}
            onChange={on => set("askForVisitors", on)}
          />
        </>
      ) : null}

      <div className="pd-form__foot">
        <Button
          type="submit"
          disabled={busy || !site.title.trim() || (site.brandColor !== "" && !BRAND_COLOR.test(site.brandColor))}
        >
          {t("Save")}
        </Button>
      </div>
    </Form>
  );
}

export function SiteView() {
  const site = useLoaded(() => api.get<SiteSettings>("site"), []);
  return (
    <>
      <ManageHead
        title={t("Site settings")}
        description={t("Applies to every space. The page refreshes after saving.")}
      />
      <LoadedContent loaded={site}>{data => <SiteForm initial={data} />}</LoadedContent>
    </>
  );
}
