/**
 * The theme expects its text to come from the people who build the site, so it renders anything that looks like HTML
 * as HTML. Here titles and headings come from anyone who can write a page, agents and imported files included. These
 * replace its two functions: every component reaches them through the theme's entry, so this is the only place text
 * can turn into markup, and all it can turn into is the four tags below.
 */

const STRONG = /\*{2}(?!\*)(.*?)\*{2}(?!\*)/gu;
const EMPHASIS = /\*(?!\*)(.*?)\*(?!\*)/gu;
const DELETED = /~{2}(.*?)~{2}/gu;
/** A backslash escape, or a code span closed by a run of exactly as many backticks as opened it. */
const LITERAL = /\\([!-/:-@[-`{-~])|(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\2(?!`)/gu;
const MARKER = "\u0000";

const escapeHtml = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

function codeOf(value: string): string {
  const code = value.replace(/\r\n?|\n/gu, " ");
  // The space that lets a code span start or end with a backtick is not part of the code.
  return code.startsWith(" ") && code.endsWith(" ") && /[^ ]/u.test(code) ? code.slice(1, -1) : code;
}

/** Everything is escaped first, so a `<` in the result can only have come from these replacements. */
export function renderInlineMarkdown(text: string): { dangerouslySetInnerHTML: { __html: string } } {
  const literals: string[] = [];
  const keep = (html: string) => `${MARKER}${literals.push(html) - 1}${MARKER}`;
  const marked = text
    .replaceAll(MARKER, "")
    .replace(LITERAL, (_, escaped: string | undefined, _ticks: string, code: string) =>
      keep(escaped ? escapeHtml(escaped) : `<code>${escapeHtml(codeOf(code))}</code>`)
    );
  const __html = escapeHtml(marked)
    .replace(STRONG, "<strong>$1</strong>")
    .replace(EMPHASIS, "<em>$1</em>")
    .replace(DELETED, "<del>$1</del>")
    .replace(new RegExp(`${MARKER}(\\d+)${MARKER}`, "gu"), (_, index: string) => literals[Number(index)]!);
  return { dangerouslySetInnerHTML: { __html } };
}

export function renderHtmlOrText(text?: string | number | null): { children: string | null } {
  return { children: text === undefined || text === null || text === "" ? null : String(text) };
}
