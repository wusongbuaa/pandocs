/** Same logic as `extractTextAndId` in @rspress/shared/node-utils, whose module also pulls in Node-only code. */
export function extractTextAndId(title?: string): [string, string] {
  if (!title) return ["", ""];
  const customId = /\\?\{#.*\}/u;
  if (!customId.test(title)) return [title, ""];
  return [title.replace(customId, "").trimEnd(), title.match(customId)?.[0]?.slice(2, -1) ?? ""];
}
