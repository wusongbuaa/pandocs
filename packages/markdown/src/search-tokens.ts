const WORDS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}_])+/gu;
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MAX_WORD = 64;
/** PostgreSQL limits a text search value to 1 MB; a page has far fewer distinct tokens than this unless it is not prose. */
const MAX_TOKENS = 60_000;

/**
 * Chinese and Japanese have no spaces to split on, and the databases people run do not all have a segmenter. Pairs of
 * adjacent characters need no dictionary and no extension, and find any phrase of two or more characters.
 */
function tokensOf(word: string): string[] {
  if (!CJK.test(word)) return [word.slice(0, MAX_WORD).toLowerCase()];
  const characters = [...word];
  if (characters.length === 1) return characters;
  return characters.slice(0, -1).map((character, at) => `${character}${characters[at + 1]!}`);
}

/** Distinct tokens of a text, for a search index that matches whole tokens. */
export function searchTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const [word] of text.matchAll(WORDS)) {
    for (const token of tokensOf(word)) {
      tokens.add(token);
      if (tokens.size >= MAX_TOKENS) return [...tokens];
    }
  }
  return [...tokens];
}

const MOST_QUERY_WORDS = 32;
const MOST_QUERY_TERMS = 64;
const quoted = (token: string) => `'${token.replace(/'/gu, "''").replace(/\\/gu, "\\\\")}'`;

/**
 * A PostgreSQL `tsquery` for what someone typed, or null if it holds nothing searchable. The last word may
 * still be being typed, and a lone character is the start of some pair, so those match as prefixes.
 */
export function searchQuery(text: string): string | null {
  // Nobody searches with more words than this, and a query as long as the address allows would only cost the database.
  const words = [...text.matchAll(WORDS)].map(([word]) => word).slice(0, MOST_QUERY_WORDS);
  if (words.length === 0) return null;
  const parts = words.flatMap((word, at) => {
    const tokens = tokensOf(word);
    const open = at === words.length - 1 && (!CJK.test(word) || tokens[0]!.length === 1);
    return tokens.map(token => (open ? `${quoted(token)}:*` : quoted(token)));
  });
  return parts.slice(0, MOST_QUERY_TERMS).join(" & ");
}
