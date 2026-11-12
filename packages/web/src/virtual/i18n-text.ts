import { DEFAULT_I18N_TEXT } from "../../vendor/rspress/node/runtimeModule/i18n/DEFAULT_I18N_TEXT";
import { language } from "../i18n";

/**
 * The theme picks its text by the language of the page, which here is the language of the content. Everything else on
 * the page follows the person reading it, so the theme does too, for the languages the app has text for.
 */
export default Object.fromEntries(Object.entries(DEFAULT_I18N_TEXT).map(([key, text]) => [key, { ...text, zh: text[language], en: text[language] }]));
