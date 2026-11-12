import { Bell, History, LoaderCircle, MessageSquare, SquarePen } from "lucide-react";
import { useFrontmatter, usePage, useSearchParams } from "@rspress/core/runtime";
import { Link } from "@rspress/core/theme";
import { useEditorShown } from "../data/editor-shown";
import { documentRoute, localePrefix, pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast } from "../types";
import { embedded } from "../embed/session";
import { CommentsButton, SuggestionsButton } from "./doc-comments";
import { FollowButton } from "./follow-button";
import { ShareButton } from "./share-button";
import { askToSignIn, isVisitor } from "../theme/sign-in";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

/** Worth saying for a long page. A page can turn it off when it says how long the task itself takes. */
const WORTH_SAYING_MINUTES = 3;

function ReadingTime({ minutes }: { minutes: number }) {
  const { frontmatter } = useFrontmatter();
  if (minutes < WORTH_SAYING_MINUTES || (frontmatter as { readingTime?: boolean }).readingTime === false) return null;
  return <span className="pd-reading-time" title={t("Based on 400 words a minute")}>{t("About {0} min read", minutes)}</span>;
}

/** What signing in offers on a page, where a visitor would look for it. Each asks them to sign in, then carries on. */
function VisitorActions({ route }: { route: string }) {
  const actions = [
    { label: t("Comments"), Icon: MessageSquare, labelled: true, reason: t("Sign in to comment on this page.") },
    { label: t("Edit"), Icon: SquarePen, labelled: true, reason: t("Sign in to edit this page or suggest changes."), next: `${pageUrl(route)}?mode=edit` },
    { label: t("History"), Icon: History, labelled: false, reason: t("Sign in to see the versions of this page."), next: `${pageUrl(route)}?view=history` },
    { label: t("Follow"), Icon: Bell, labelled: false, reason: t("Sign in to follow this page and hear when it changes.") }
  ];
  return actions.map(({ label, Icon, labelled, reason, next }) => (
    <Tip key={label} label={label}>
      <button type="button" className={labelled ? "rp-llms-button pd-action" : "rp-llms-button pd-action pd-action--icon"} aria-label={label} onClick={() => askToSignIn({ reason, next })}>
        <Icon size={16} aria-hidden="true" />{labelled ? <span className="pd-action__label">{label}</span> : null}
      </button>
    </Tip>
  ));
}

/** The buttons next to "copy Markdown": the theme's row is the natural home of what a person does with a page. */
export function DocActions() {
  const page = useAppPage();
  const { page: themePage } = usePage();
  const [params] = useSearchParams();
  const editorShown = useEditorShown();
  if (page?.kind !== "document") return null;
  const route = documentRoute(page.space.slug, page.entry.path, localePrefix(themePage.lang, app.bootstrap.site.defaultLang));
  const role = page.view.role;
  const edit = atLeast(role, "editor") ? t("Edit") : t("Suggest changes");
  // The page stays as it was read while the editor opens, and the button that was clicked says so.
  const opening = params.get("mode") === "edit" && !editorShown;
  // Discussions, suggestions and history belong to the source; a translation has none of its own.
  if (page.translation?.exists) return <ReadingTime minutes={page.rendered.readingMinutes} />;
  if (app.bootstrap.me.anonymous) return <>{isVisitor() ? <VisitorActions route={route} /> : null}<ReadingTime minutes={page.rendered.readingMinutes} /></>;
  return (
    <>
      <CommentsButton />
      <SuggestionsButton />
      {atLeast(role, "commenter") ? (
        <Tip label={edit}>
          <Link href={`${route}?mode=edit`} className="rp-llms-button pd-action" aria-label={opening ? t("Opening…") : edit} aria-busy={opening || undefined}>
            {opening ? <LoaderCircle size={16} className="pd-spin" aria-hidden="true" /> : <SquarePen size={16} aria-hidden="true" />}
            <span className="pd-action__label">{opening ? t("Opening…") : edit}</span>
          </Link>
        </Tip>
      ) : null}
      <Tip label={t("History")}><Link href={`${route}?view=history`} className="rp-llms-button pd-action pd-action--icon" aria-label={t("History")}><History size={16} aria-hidden="true" /></Link></Tip>
      {embedded ? null : <FollowButton documentId={page.entry.id} space={page.space.slug} spaceName={page.space.name} />}
      {!embedded && app.bootstrap.shareLinks && atLeast(role, "editor") && !page.entry.restricted ? <ShareButton documentId={page.entry.id} /> : null}
      <ReadingTime minutes={page.rendered.readingMinutes} />
    </>
  );
}
