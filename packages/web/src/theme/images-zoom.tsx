import { useLocation, usePage } from "@rspress/core/runtime";
import MediumZoom from "../../vendor/rspress/static/MediumZoom";
import type { AppPage } from "../data/pages";

/** A marked screenshot and a before-and-after each do something of their own when clicked. */
const ZOOMED_IMAGES = "[data-pandocs-body] img:not(.pd-hotspots img, .pd-compare img)";

/**
 * The built-in attaches once per path. Images also come and go without the path changing, when leaving the
 * editor or after saving; and an image being edited should select, not zoom, so only the rendered body counts.
 */
export function DocumentImagesZoom() {
  const { search } = useLocation();
  const { page } = usePage();
  const data = (page as unknown as { pandocs?: AppPage }).pandocs;
  const revision = data?.kind === "document" ? data.view.revision.no : 0;
  return <MediumZoom key={`${search}:${revision}`} selector={ZOOMED_IMAGES} />;
}
