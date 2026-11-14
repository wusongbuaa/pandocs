import { t } from "@pandocs/i18n";

/** The part of a document block this reads. Each block has one more key, named after its type, with what is in it. */
export interface FeishuBlock {
  readonly block_id: string;
  readonly block_type: number;
  readonly parent_id?: string;
  readonly children?: readonly string[];
  readonly [content: string]: unknown;
}

interface TextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly inline_code?: boolean;
  readonly link?: { readonly url?: string };
}

interface TextElement {
  readonly text_run?: { readonly content?: string; readonly text_element_style?: TextStyle };
  readonly mention_user?: { readonly user_id?: string };
  readonly mention_doc?: { readonly token?: string; readonly url?: string; readonly title?: string };
  readonly reminder?: { readonly expire_time?: string | number };
  readonly equation?: { readonly content?: string; readonly text_element_style?: TextStyle };
}

interface TextContent {
  readonly elements?: readonly TextElement[];
  readonly style?: { readonly done?: boolean; readonly language?: number };
}

export interface BlockHooks {
  /** Keeps a picture or file from the document, and says how a page refers to it. */
  media(token: string, name: string): Promise<string | null>;
  /** A whiteboard as a picture, which is the most of it that can come over. */
  whiteboard(token: string): Promise<string | null>;
  /** Where another page in this import ended up, if it is one. */
  linkToPage(token: string): string | null;
  /** The original, for what cannot come over. */
  readonly originalUrl: string;
  note(reason: string): void;
}

const CODE_LANGUAGES: readonly string[] = [
  "",
  "abap",
  "ada",
  "apache",
  "apex",
  "asm",
  "bash",
  "csharp",
  "cpp",
  "c",
  "cobol",
  "css",
  "coffeescript",
  "d",
  "dart",
  "delphi",
  "django",
  "dockerfile",
  "erlang",
  "fortran",
  "foxpro",
  "go",
  "groovy",
  "html",
  "handlebars",
  "http",
  "haskell",
  "json",
  "java",
  "javascript",
  "julia",
  "kotlin",
  "latex",
  "lisp",
  "logo",
  "lua",
  "matlab",
  "makefile",
  "markdown",
  "nginx",
  "objectivec",
  "openedge",
  "php",
  "perl",
  "postscript",
  "powershell",
  "prolog",
  "protobuf",
  "python",
  "r",
  "rpg",
  "ruby",
  "rust",
  "sas",
  "scss",
  "sql",
  "scala",
  "scheme",
  "scratch",
  "shell",
  "swift",
  "thrift",
  "typescript",
  "vbscript",
  "vb",
  "xml",
  "yaml",
  "cmake",
  "diff",
  "gherkin",
  "graphql",
  "glsl",
  "properties",
  "solidity",
  "toml"
];
const CALLOUT_COLOURS: Readonly<Record<number, string>> = {
  1: "danger",
  8: "danger",
  2: "warning",
  9: "warning",
  3: "warning",
  10: "warning",
  4: "tip",
  11: "tip",
  5: "info",
  12: "info",
  6: "note",
  13: "note"
};
const WIKI_TOKEN = /\/(?:wiki|docx|docs)\/([A-Za-z0-9]+)/u;

const LEFT_OUT: Readonly<Record<number, () => string>> = {
  18: () => t("A multidimensional table"),
  20: () => t("A group card"),
  21: () => t("A diagram"),
  28: () => t("A widget"),
  29: () => t("A mind map"),
  30: () => t("A spreadsheet"),
  35: () => t("A task"),
  36: () => t("An OKR"),
  40: () => t("A widget"),
  41: () => t("A Jira issue"),
  50: () => t("A synced block"),
  52: () => t("An AI template"),
  999: () => t("Something this version cannot read")
};

function escapeText(text: string): string {
  return text.replace(/[\\`*[\]<$~]/gu, "\\$&").replace(/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\_");
}

/** Something at the start of a line that would otherwise be read as Markdown of its own. */
const escapeLineStart = (text: string) => text.replace(/^(\s*)(#{1,6}\s|>|[-+]\s|\d+[.)]\s|:::|::[a-z])/u, "$1\\$2");

const decoded = (url: string) => {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
};

const sameStyle = (a: TextStyle | undefined, b: TextStyle | undefined) =>
  Boolean(a?.bold) === Boolean(b?.bold) &&
  Boolean(a?.italic) === Boolean(b?.italic) &&
  Boolean(a?.strikethrough) === Boolean(b?.strikethrough) &&
  Boolean(a?.inline_code) === Boolean(b?.inline_code) &&
  a?.link?.url === b?.link?.url;

/** Marks only work up against words, so the spaces go outside them. */
function marked(raw: string, style: TextStyle | undefined, hooks: BlockHooks): string {
  if (!raw) return "";
  const [, before = "", middle = "", after = ""] = /^(\s*)([\s\S]*?)(\s*)$/u.exec(raw) ?? [];
  if (!middle) return raw;
  let text: string;
  if (style?.inline_code) {
    const ticks = "`".repeat(Math.max(0, ...[...middle.matchAll(/`+/gu)].map(run => run[0].length)) + 1);
    text = ticks.length > 1 ? `${ticks} ${middle} ${ticks}` : `\`${middle}\``;
  } else text = escapeText(middle);
  if (style?.strikethrough) text = `~~${text}~~`;
  if (style?.italic) text = `*${text}*`;
  if (style?.bold) text = `**${text}**`;
  if (style?.link?.url) {
    const url = decoded(style.link.url);
    const page = WIKI_TOKEN.exec(url)?.[1];
    text = `[${text}](${(page && hooks.linkToPage(page)) ?? url.replace(/[()\s]/gu, encodeURIComponent)})`;
  }
  return `${before}${text}${after}`;
}

function inline(elements: readonly TextElement[], hooks: BlockHooks): string {
  let out = "";
  let pending = "";
  let style: TextStyle | undefined;
  const flush = () => {
    out += marked(pending, style, hooks);
    pending = "";
  };
  for (const element of elements) {
    const run = element.text_run;
    if (run) {
      if (pending && !sameStyle(style, run.text_element_style)) flush();
      style = run.text_element_style;
      pending += run.content ?? "";
      continue;
    }
    flush();
    if (element.equation) out += `$${(element.equation.content ?? "").trim()}$`;
    else if (element.mention_doc) {
      const title = escapeText(element.mention_doc.title ?? t("A document"));
      const inside = element.mention_doc.token ? hooks.linkToPage(element.mention_doc.token) : null;
      const url = element.mention_doc.url ? decoded(element.mention_doc.url) : null;
      out += (inside ?? url) ? `[${title}](${inside ?? url!.replace(/[()\s]/gu, encodeURIComponent)})` : title;
    } else if (element.mention_user) out += t("@someone");
    else if (element.reminder?.expire_time)
      out += new Date(Number(element.reminder.expire_time)).toISOString().slice(0, 10);
  }
  flush();
  // Hard line breaks, which is what someone pressing Shift+Enter there means.
  return escapeLineStart(out).replace(/ *\n/gu, "  \n").trimEnd();
}

const longestFence = (text: string) =>
  Math.max(2, ...[...text.matchAll(/^\s*(:{3,})/gmu)].map(match => match[1]!.length));

const indented = (text: string, by: string) =>
  text
    .split("\n")
    .map((line, at) => (at === 0 || !line ? line : `${by}${line}`))
    .join("\n");
const quoted = (text: string) =>
  text
    .split("\n")
    .map(line => (line ? `> ${line}` : ">"))
    .join("\n");

/** Converts one document. What cannot come over leaves a note in the page saying so, with a link back. */
export async function blocksToMarkdown(blocks: readonly FeishuBlock[], hooks: BlockHooks): Promise<string> {
  const byId = new Map(blocks.map(block => [block.block_id, block]));
  const root = blocks.find(block => block.block_type === 1) ?? blocks[0];
  if (!root) return "";
  // Documents there have a title of their own, so headings often start at one here. On a page here, that level is the title.
  const shift = blocks.some(block => block.block_type === 3) ? 1 : 0;
  const leftOut = new Set<string>();

  const childrenOf = (block: FeishuBlock) => (block.children ?? []).flatMap(id => byId.get(id) ?? []);
  const textOf = (block: FeishuBlock, key: string) => inline(((block[key] ?? {}) as TextContent).elements ?? [], hooks);

  const placeholder = (what: string) => {
    if (!leftOut.has(what)) {
      leftOut.add(what);
      hooks.note(t("{0} was left out", what));
    }
    return `:::note\n\n${t("{0} is not here. See the [original]({1}).", what, hooks.originalUrl)}\n\n:::`;
  };

  const listItem = async (block: FeishuBlock, marker: string, text: string) => {
    const nested = await render(childrenOf(block));
    return `${marker}${indented(`${text}${nested ? `\n${nested.replace(/^/u, "")}` : ""}`, " ".repeat(marker.length))}`;
  };

  const table = async (block: FeishuBlock) => {
    const { cells = [], property } = (block.table ?? {}) as {
      cells?: readonly string[];
      property?: { column_size?: number; merge_info?: readonly { row_span?: number; col_span?: number }[] };
    };
    const columns = property?.column_size ?? 1;
    if ((property?.merge_info ?? []).some(cell => (cell.row_span ?? 1) > 1 || (cell.col_span ?? 1) > 1))
      hooks.note(t("A table had merged cells, which Markdown cannot show"));
    const rows: string[][] = [];
    for (let at = 0; at < cells.length; at += columns) {
      const row: string[] = [];
      for (const id of cells.slice(at, at + columns)) {
        const cell = byId.get(id);
        row.push(cell ? (await render(childrenOf(cell))).replace(/\s*\n+\s*/gu, "<br>").replaceAll("|", "\\|") : "");
      }
      rows.push(row);
    }
    if (rows.length === 0) return "";
    const line = (row: readonly string[]) =>
      `| ${Array.from({ length: columns }, (_, at) => row[at] ?? "").join(" | ")} |`;
    return [
      line(rows[0]!),
      `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
      ...rows.slice(1).map(line)
    ].join("\n");
  };

  const one = async (block: FeishuBlock): Promise<string> => {
    const type = block.block_type;
    if (type === 2) return textOf(block, "text");
    if (type >= 3 && type <= 11) {
      const heading = textOf(block, `heading${type - 2}`);
      return heading ? `${"#".repeat(Math.min(type - 2 + shift, 6))} ${heading}` : "";
    }
    if (type === 14) {
      const content = (block.code ?? {}) as TextContent;
      const text = (content.elements ?? []).map(element => element.text_run?.content ?? "").join("");
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(run => run[0].length + 1)));
      return `${fence}${CODE_LANGUAGES[(content.style?.language ?? 1) - 1] ?? ""}\n${text.replace(/\n$/u, "")}\n${fence}`;
    }
    if (type === 15) return quoted(textOf(block, "quote"));
    if (type === 16)
      return `$$\n${((block.equation ?? {}) as TextContent).elements?.map(element => element.text_run?.content ?? element.equation?.content ?? "").join("") ?? ""}\n$$`;
    if (type === 34) return quoted(await render(childrenOf(block)));
    if (type === 19) {
      const body = await render(childrenOf(block));
      const fence = ":".repeat(longestFence(body) + 1);
      return `${fence}${CALLOUT_COLOURS[((block.callout ?? {}) as { background_color?: number }).background_color ?? 0] ?? "info"}\n\n${body}\n\n${fence}`;
    }
    if (type === 22) return "---";
    if (type === 23) {
      const { token, name } = (block.file ?? {}) as { token?: string; name?: string };
      const path = token ? await hooks.media(token, name ?? token) : null;
      return path
        ? `::file[${(name ?? token!).replace(/[[\]\r\n]/gu, " ")}]{src="${path}"}`
        : placeholder(name ?? t("A file"));
    }
    if (type === 24) {
      const columns = childrenOf(block).filter(child => child.block_type === 25);
      const rendered = await Promise.all(
        columns.map(async column => ({
          width: ((column.grid_column ?? {}) as { width_ratio?: number }).width_ratio,
          body: await render(childrenOf(column))
        }))
      );
      const inner = ":".repeat(Math.max(2, ...rendered.map(column => longestFence(column.body))) + 1);
      const parts = rendered.map(
        ({ width, body }) =>
          `${inner}column${width ? `{width="${(width / 100).toFixed(2)}"}` : ""}\n\n${body}\n\n${inner}`
      );
      const outer = `${inner}:`;
      return `${outer}columns\n\n${parts.join("\n\n")}\n\n${outer}`;
    }
    if (type === 26) {
      const url = ((block.iframe ?? {}) as { component?: { url?: string } }).component?.url;
      return url ? `[${t("Embedded page")}](${decoded(url).replace(/[()\s]/gu, encodeURIComponent)})` : "";
    }
    if (type === 27) {
      const { token, caption } = (block.image ?? {}) as { token?: string; caption?: { content?: string } };
      const path = token ? await hooks.media(token, `${token}.png`) : null;
      return path ? `![${(caption?.content ?? "").replace(/[[\]\r\n]/gu, " ")}](${path})` : placeholder(t("A picture"));
    }
    if (type === 31) return table(block);
    if (type === 43) {
      const { token } = (block.board ?? {}) as { token?: string };
      const path = token ? await hooks.whiteboard(token) : null;
      return path ? `![](${path})` : placeholder(t("A whiteboard"));
    }
    // These only hold other blocks, in a place of their own.
    if (type === 33 || type === 44 || type === 45 || type === 47 || type === 49 || type === 25 || type === 32)
      return render(childrenOf(block));
    if (type === 46) {
      const title = textOf(block, "agenda_item_title");
      return title ? `**${title}**` : "";
    }
    if (type === 42 || type === 51) return "::subpages";
    if (type === 48 || type === 37 || type === 38 || type === 39) return "";
    return placeholder(LEFT_OUT[type]?.() ?? LEFT_OUT[999]!());
  };

  const LIST_TYPES = new Set([12, 13, 17]);
  const render = async (list: readonly FeishuBlock[]): Promise<string> => {
    const parts: { text: string; list: boolean }[] = [];
    for (const block of list) {
      const type = block.block_type;
      if (LIST_TYPES.has(type)) {
        const key = type === 12 ? "bullet" : type === 13 ? "ordered" : "todo";
        const marker =
          type === 12
            ? "- "
            : type === 13
              ? "1. "
              : `- [${((block.todo ?? {}) as TextContent).style?.done ? "x" : " "}] `;
        parts.push({ text: await listItem(block, marker, textOf(block, key)), list: true });
        continue;
      }
      const text = await one(block);
      // Documents there are full of empty lines kept for spacing.
      if (text) parts.push({ text, list: false });
    }
    return parts.reduce(
      (all, part, at) => all + (at === 0 ? "" : part.list && parts[at - 1]!.list ? "\n" : "\n\n") + part.text,
      ""
    );
  };

  const body = await render(childrenOf(root));
  return body ? `${body}\n` : "";
}
