import { Link } from "@rspress/core/theme";
import { usePage } from "@rspress/core/runtime";
import { recentPages } from "../data/pages";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { LocalTime } from "../ui/local-time";
import { t } from "../i18n";

/** Below the spaces on the site's front page: what changed lately, wherever it is. */
export function RecentPages() {
  const data = useAppPage();
  const { page } = usePage();
  if (data?.kind !== "home" || !data.site) return null;
  const recent = recentPages(app.bootstrap.spaces);
  if (recent.length === 0) return null;
  const prefix = localePrefix(page.lang, app.bootstrap.site.defaultLang);
  return (
    <section className="pd-home-recent" aria-labelledby="pd-home-recent">
      <h2 id="pd-home-recent">{t("Recently updated")}</h2>
      <ul>
        {recent.map(({ space, entry }) => (
          <li key={entry.id}>
            <Link href={documentRoute(space.slug, entry.path, prefix)}>{entry.titles?.[page.lang] ?? entry.title}</Link>
            <span>{space.name}</span>
            <LocalTime at={entry.updatedAt} />
          </li>
        ))}
      </ul>
    </section>
  );
}
