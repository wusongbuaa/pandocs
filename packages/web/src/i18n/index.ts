import {
  addMessages,
  isLanguage,
  LANGUAGE_COOKIE,
  pickLanguage,
  setLanguageScope,
  t,
  type Language
} from "@pandocs/i18n";
// By its own path, so that the first thing a page loads does not take in the rest of the package.
import { issueMessage } from "@pandocs/markdown/issue-message";
import { config } from "zod";
import { embedOption } from "../embed/session";
import { insideSite, SITE_BASE } from "../data/site-base";

export { t };

const CHOICE_SECONDS = 365 * 24 * 60 * 60;
const CHOICE = new RegExp(`(?:^|;\\s*)${LANGUAGE_COOKIE}=(\\w+)`, "u");

/** Cookies throw in a frame the browser has cut off from them, which is one of the places this runs. */
export function chosenLanguage(): Language | null {
  try {
    const chosen = CHOICE.exec(document.cookie)?.[1];
    return isLanguage(chosen) ? chosen : null;
  } catch {
    return null;
  }
}

/** What someone picked, then the language an address is in, then what their browser asks for. */
export function resolveLanguage(): Language {
  const asked = pickLanguage(navigator.languages.join(","));
  // The text pipeline's tests run without a page.
  if (typeof location === "undefined") return asked;
  const given = embedOption("lang");
  if (isLanguage(given)) return given;
  const chosen = chosenLanguage();
  if (chosen) return chosen;
  // No space can be called `zh` or `en`, so an address starting with one is in that language.
  const prefix = insideSite(location.pathname).split("/")[1];
  return isLanguage(prefix) ? prefix : asked;
}

/** A page a server rendered has to start out in that language, whatever this browser would have asked for. A thread doing the rendering has its own. */
function renderedLanguage(): Language | null {
  const rendered =
    (globalThis as { pandocsRenderLanguage?: unknown }).pandocsRenderLanguage ??
    (typeof document === "undefined" ? null : document.documentElement.dataset.language);
  return isLanguage(rendered) ? rendered : null;
}

export const language = renderedLanguage() ?? resolveLanguage();
setLanguageScope({ current: () => language, run: (_language, work) => work() });
// What a schema rejects is said in this language too, as it is on the server.
config({ customError: issueMessage });

/**
 * The first thing the app waits for, so that the code it loads afterwards finds its text. If this fails the page is in
 * English. Whatever is in the first chunk runs before this, so it cannot look up text while it loads.
 */
export async function loadMessages(): Promise<void> {
  if (language !== "zh") return;
  await Promise.all([import("./zh"), import("@pandocs/markdown/zh")])
    .then(([web, markdown]) => {
      addMessages("zh", markdown.zh);
      addMessages("zh", web.zh);
    })
    .catch(() => undefined);
}

/** Text is fixed when a page loads, so changing it means loading the page again. */
export function chooseLanguage(choice: Language | null): void {
  document.cookie = `${LANGUAGE_COOKIE}=${choice ?? ""}; Path=${SITE_BASE || "/"}; SameSite=Lax; Max-Age=${choice ? CHOICE_SECONDS : 0}`;
  location.reload();
}
