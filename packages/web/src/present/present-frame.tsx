import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useNavigate, usePage } from "@rspress/core/runtime";
import type { PandocsPage } from "../data/pages";
import { documentRoute, localePrefix } from "../data/paths";
import { app } from "../data/runtime-data";
import { t } from "../i18n";

export function usePageRoute(page: PandocsPage): string {
  const { page: themePage } = usePage();
  return documentRoute(page.space.slug, page.entry.path, localePrefix(themePage.lang, app.bootstrap.site.defaultLang));
}

/** A view that takes the whole window. Escape or the button goes back to reading the page. */
export function PresentFrame({
  page,
  label,
  children
}: {
  page: PandocsPage;
  label: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const route = usePageRoute(page);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A popover or an enlarged diagram on a slide takes Escape first. Listening ahead of them, so they can still be seen here.
      if (event.key === "Escape" && !document.querySelector(".pd-floating, .pd-zoom")) navigate(route);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [navigate, route]);
  return createPortal(
    <div className="pd-present" role="dialog" aria-label={label}>
      <button type="button" className="pd-btn pd-btn--icon pd-present__exit" onClick={() => navigate(route)}>
        <X size={14} aria-hidden="true" />
        {t("Exit {0}", label)}
      </button>
      {children}
    </div>,
    document.body
  );
}
