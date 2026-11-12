import { X } from "lucide-react";
import { Link } from "@rspress/core/theme";
import { CodeBlockRuntime } from "@rspress/core/theme";
import { usePage } from "@rspress/core/runtime";
import type { PandocsPage } from "../data/pages";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { t } from "../i18n";

/** The Markdown as stored, for reading and copying; changing it happens through the editor. */
export default function SourceView({ page }: { page: PandocsPage }) {
  const { page: themePage } = usePage();
  const route = documentRoute(page.space.slug, page.entry.path, localePrefix(themePage.lang, app.bootstrap.site.defaultLang));
  return (
    <>
      <p className="pd-source-head"><span>{t("Markdown source, version {0}", page.view.revision.no)}</span><Link href={route} className="pd-btn pd-source-head__close"><X size={14} aria-hidden="true" />{t("Back to reading")}</Link></p>
      <CodeBlockRuntime lang="markdown" title={`${page.entry.path}.md`} code={page.view.markdown ?? ""} />
    </>
  );
}
