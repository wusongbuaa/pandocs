import copy from "copy-to-clipboard";
import type { SiteAction } from "../types";
import { toast } from "../ui/toast";
import { t } from "../i18n";

export interface ActionValues {
  readonly url: string;
  readonly title: string;
  readonly text: string;
}

/** Addresses have a size limit, and each Chinese character takes nine bytes in one. */
const MAX_TEXT_IN_ADDRESS = 600;

const fill = (template: string, values: ActionValues, encode: (value: string) => string) =>
  template.replace(/\{(url|title|text)\}/gu, (_, key: keyof ActionValues) => encode(values[key]));

/** What the host offers on a selection or a page, such as handing it to its own agents. */
export function runHostAction(action: SiteAction, values: ActionValues): void {
  if (action.copy) {
    copy(fill(action.copy, values, value => value).trim());
    toast(t("Copied. Paste it into the page that opened."));
  }
  window.open(fill(action.href, { ...values, text: values.text.slice(0, MAX_TEXT_IN_ADDRESS) }, encodeURIComponent), "_blank", "noopener,noreferrer");
}
