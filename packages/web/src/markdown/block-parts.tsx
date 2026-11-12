import { Callout } from "@rspress/core/theme";
import { api } from "../api/client";
import { t } from "../i18n";
import { SAFE_URL } from "./pipeline";

/** One renderer per block. A block without one falls back to its source, so nothing is ever hidden. */
export interface BlockProps {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly source?: string | undefined;
  readonly body?: unknown;
  readonly children?: React.ReactNode;
  /** Shown inside the editor, where a click means going to the source. */
  readonly preview?: boolean | undefined;
}

/**
 * A block's own attributes do not go through the pipeline that cleans links, so an address that could run script, or
 * open something other than a page or a file, leads nowhere instead.
 */
export function assetSource(space: string, src: string): string {
  if (src.startsWith("assets/")) return api.assetUrl(space, src);
  return SAFE_URL.test(src) ? src : "about:blank";
}

export function BlockError({ title, source }: { title: string; source: string }) {
  return (
    <div data-pandocs-nontext="">
      <Callout type="warning" title={title}>
        <details><summary>{t("View source")}</summary><pre className="pd-source">{source}</pre></details>
      </Callout>
    </div>
  );
}
