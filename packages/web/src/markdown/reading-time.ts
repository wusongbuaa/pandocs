import type { Root, RootContent } from "hast";

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu;
const CJK_PER_MINUTE = 400;
const WORDS_PER_MINUTE = 200;

function textOf(node: Root | RootContent): string {
  if (node.type === "text") return node.value;
  return "children" in node ? (node.children as RootContent[]).map(textOf).join(" ") : "";
}

/** At least a minute; nobody needs to be told a page takes no time. */
export function readingMinutes(tree: Root): number {
  const text = textOf(tree);
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK, " ").split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  return Math.max(1, Math.round(cjk / CJK_PER_MINUTE + words / WORDS_PER_MINUTE));
}
