export interface AskSource {
  readonly n: number;
  readonly title: string;
  readonly url: string;
}

/** An address the Markdown pipeline lets through, for the answer's component to replace with the real link. */
export const CITATION_PREFIX = "#pandocs-citation-";

const NUMBER = /\s*\[(\d{1,3})\](?!\()/gu;

/**
 * Sources are numbered as the answer first uses them, the same way the server does in the end, so that nothing changes
 * under someone reading along. A number that leads nowhere is left out.
 */
export function numberCitations(
  text: string,
  known: (n: number) => { readonly title: string; readonly url: string } | undefined
): { readonly markdown: string; readonly citations: readonly AskSource[] } {
  const numbers = new Map<number, number>();
  const citations: AskSource[] = [];
  const markdown = text.replace(NUMBER, (match, digits: string) => {
    const source = known(Number(digits));
    if (!source) return "";
    let n = numbers.get(Number(digits));
    if (!n) {
      n = numbers.size + 1;
      numbers.set(Number(digits), n);
      citations.push({ n, title: source.title, url: source.url });
    }
    return ` [${n}](${CITATION_PREFIX}${n})`.slice(match.startsWith(" ") ? 0 : 1);
  });
  return { markdown, citations };
}
