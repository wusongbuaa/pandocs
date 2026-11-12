export type Language = "en" | "zh";

export const DEFAULT_LANGUAGE: Language = "en";

/** Someone's own choice of language. A cookie, because the server renders their pages. */
export const LANGUAGE_COOKIE = "pandocs_language";

/** Whose language it is depends on where this runs: the one person using a page, or the request being handled on a server. */
export interface LanguageScope {
  current(): Language;
  run<T>(language: Language, work: () => T): T;
}

let scope: LanguageScope = { current: () => DEFAULT_LANGUAGE, run: (_language, work) => work() };
const dictionaries = new Map<Language, Map<string, string>>();

export function setLanguageScope(next: LanguageScope): void {
  scope = next;
}

export const currentLanguage = (): Language => scope.current();

export const inLanguage = <T>(language: Language, work: () => T): T => scope.run(language, work);

export function addMessages(language: Language, messages: Readonly<Record<string, string>>): void {
  const dictionary = dictionaries.get(language) ?? new Map<string, string>();
  for (const [source, translated] of Object.entries(messages)) dictionary.set(source, translated);
  dictionaries.set(language, dictionary);
}

export const isLanguage = (value: unknown): value is Language => value === "en" || value === "zh";

/**
 * The text is the English itself, so a missing translation shows English rather than a key. `{0}` is an argument, and
 * `{0|page|pages}` picks a word by whether that argument is 1, which is all English asks of a plural.
 */
export function t(message: string, ...args: readonly (string | number)[]): string {
  const text = dictionaries.get(scope.current())?.get(message) ?? message;
  return text.replace(/\{(\d+)(?:\|([^|}]*)\|([^}]*))?\}/gu, (_match, index: string, one: string | undefined, other: string | undefined) => {
    const value = args[Number(index)];
    return one === undefined ? String(value ?? "") : value === 1 ? one : other!;
  });
}

/** Reads a browser's `Accept-Language`, or its list of languages joined with commas. */
export function pickLanguage(accepted: string | null | undefined): Language {
  const ranked = (accepted ?? "").split(",").map(part => {
    const [tag = "", ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.map(parameter => /^\s*q=([\d.]+)/u.exec(parameter)?.[1]).find(Boolean);
    return { language: tag.split("-")[0], weight: quality === undefined ? 1 : Number(quality) };
  }).filter(({ weight }) => weight > 0).sort((a, b) => b.weight - a.weight);
  return ranked.find(({ language }) => isLanguage(language))?.language as Language | undefined ?? DEFAULT_LANGUAGE;
}
