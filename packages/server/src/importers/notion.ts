import { posix } from "node:path";
import { PermanentIngestError, type BulkImporter, type ImportSink } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { relativeDocHref } from "@pandocs/markdown";
import { parseDelimited, toTable } from "../extract/text.js";
import { baseName, fileBlock, IMAGE_FILE, slugFor, ZipArchive } from "./zip.js";

const NAMED_ID = /^(.*?)[ -]?([0-9a-f]{32})$/iu;
/** Folders no longer carry the id. Two pages of the same name are told apart by the start and end of it. */
const PARTIAL_ID = /^(.*) ([0-9a-f]{4})-([0-9a-f]{4})$/iu;
const NOTION_PAGE_LINK = /^https?:\/\/(?:www\.)?notion\.(?:so|site)\/.*?([0-9a-f]{32})(?:[?#].*)?$/iu;
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_NESTED_BYTES = 512 * 1024 * 1024;
/** A link, or inline code, which is matched only so that what looks like a link inside it is left alone. */
const LINK = /(?<code>(`+)[^\n]*?\2)|(!?)\[((?:[^\]\\\n]|\\.)*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/gu;

interface Node {
  readonly id: string;
  readonly name: string;
  /** Null for a folder with no page of its own, which still needs somewhere to hang what is in it. */
  readonly file: string | null;
  folder: string | null;
  readonly children: Node[];
  path: string;
}

const decode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const stem = (file: string) => baseName(file).replace(/\.[^.]+$/u, "");

function parseName(file: string): { name: string; id: string } {
  const match = NAMED_ID.exec(stem(file).replace(/_all$/u, ""));
  return match ? { name: match[1]!.trim() || match[2]!, id: match[2]!.toLowerCase() } : { name: stem(file), id: stem(file) };
}

/** The tree of pages, from where the files are. A page's children are in a folder named after it, next to it. */
function buildTree(names: readonly string[]): Node[] {
  const useful = names.filter(name => !name.startsWith("__MACOSX/") && !name.endsWith(".DS_Store"));
  const pages = useful.filter(name => /\.(?:md|csv)$/iu.test(name));
  const pageSet = new Set(pages);
  // A database comes as a table of what shows and one of everything. Only the second is wanted when both are there.
  const wanted = pages.filter(name => !(/\.csv$/iu.test(name) && pageSet.has(name.replace(/\.csv$/iu, "_all.csv"))));
  const inDir = new Map<string, string[]>();
  const subdirs = new Map<string, Set<string>>();
  for (const name of wanted) {
    let dir = posix.dirname(name);
    if (dir === ".") dir = "";
    inDir.set(dir, [...(inDir.get(dir) ?? []), name]);
    for (let child = dir; child; child = posix.dirname(child) === "." ? "" : posix.dirname(child)) {
      const parent = posix.dirname(child) === "." ? "" : posix.dirname(child);
      if (!subdirs.has(parent)) subdirs.set(parent, new Set());
      subdirs.get(parent)!.add(child);
    }
  }
  const visit = (dir: string): Node[] => {
    const nodes: Node[] = (inDir.get(dir) ?? []).map(file => ({ ...parseName(file), file, folder: null, children: [], path: "" }));
    for (const folder of subdirs.get(dir) ?? []) {
      const folderName = baseName(folder);
      const partial = PARTIAL_ID.exec(folderName);
      const exact = nodes.find(node => !node.folder && `${node.name} ${node.id}` === folderName);
      const owner = exact ?? nodes.find(node => {
        if (node.folder || !node.file) return false;
        if (partial) return node.name === partial[1] && node.id.startsWith(partial[2]!.toLowerCase()) && node.id.endsWith(partial[3]!.toLowerCase());
        return node.name === folderName;
      });
      const holder = owner ?? { ...parseName(folder), file: null, folder: null, children: [], path: "" };
      holder.folder = folder;
      if (!owner) nodes.push(holder);
    }
    for (const node of nodes) if (node.folder) node.children.push(...visit(node.folder));
    return nodes.sort((a, b) => a.name.localeCompare(b.name));
  };
  let top = visit("");
  // Exports sit in a folder or two that are not pages.
  while (top.length === 1 && top[0]!.file === null) top = top[0]!.children;
  return top;
}

function assignPaths(nodes: readonly Node[], prefix: string, into: Map<string, Node>, ids: Map<string, Node>): void {
  const taken = new Set<string>();
  for (const node of nodes) {
    node.path = `${prefix}${slugFor(node.name, node.id, taken)}`;
    if (node.file) into.set(node.file, node);
    ids.set(node.id, node);
    assignPaths(node.children, `${node.path}/`, into, ids);
  }
}

const hasBlockText = (line: string) => line.trim() !== "";

/** What Notion writes as HTML in Markdown: callouts and toggles. Inner ones need the outer fences to be longer. */
function convertContainers(markdown: string): string {
  const out: string[] = [];
  const open: { at: number; depth: number; kind: string }[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const code = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (code) {
      if (fence === null) fence = code[1]!;
      else if (code[1]!.startsWith(fence)) fence = null;
      out.push(line);
      continue;
    }
    if (fence !== null) {
      out.push(line);
      continue;
    }
    const trimmed = line.trim();
    const aside = /^<aside>(.*)$/u.exec(trimmed);
    if (aside) {
      open.push({ at: out.length, depth: 0, kind: ":::tip" });
      out.push("", "");
      if (aside[1]!.trim()) out.push(aside[1]!.trim());
      continue;
    }
    if (trimmed === "<details>") {
      open.push({ at: out.length, depth: 0, kind: ":::details" });
      out.push("", "");
      continue;
    }
    const summary = /^<summary>(.*)<\/summary>$/u.exec(trimmed);
    const top = open.at(-1);
    if (summary && top?.kind === ":::details") {
      top.kind = `:::details[${summary[1]!.replace(/[[\]]/gu, " ").trim()}]`;
      continue;
    }
    if ((trimmed === "</aside>" || trimmed === "</details>") && top) {
      open.pop();
      const colons = ":".repeat(3 + top.depth);
      out[top.at] = top.kind.replace(":::", colons);
      out.push("", colons);
      const outer = open.at(-1);
      if (outer) outer.depth = Math.max(outer.depth, top.depth + 1);
      continue;
    }
    out.push(line);
  }
  // Something never closed is left as it was written rather than swallowing the rest of the page.
  for (const { at, kind } of open) out[at] = kind.startsWith(":::details") ? "<details>" : "<aside>";
  return out.join("\n");
}

function outsideCode(markdown: string): { text: string; code: boolean }[] {
  const pieces: { text: string; code: boolean }[] = [];
  let code = false;
  let buffer = "";
  for (const line of markdown.split(/(?<=\n)/u)) {
    if (/^\s*(?:`{3,}|~{3,})/u.test(line)) {
      if (!code && buffer) {
        pieces.push({ text: buffer, code: false });
        buffer = "";
      }
      if (code) {
        pieces.push({ text: `${buffer}${line}`, code: true });
        buffer = "";
        code = false;
        continue;
      }
      code = true;
    }
    buffer += line;
  }
  if (buffer) pieces.push({ text: buffer, code });
  return pieces;
}

export function createNotionImporter(): BulkImporter {
  const importOne = async (archive: ZipArchive, nodes: readonly Node[], sink: ImportSink): Promise<void> => {
    const byFile = new Map<string, Node>();
    const byId = new Map<string, Node>();
    assignPaths(nodes, "", byFile, byId);
    const links = async (markdown: string, node: Node, trailing: string[]): Promise<string> => {
      const dir = node.file ? posix.dirname(node.file) : "";
      const hrefTo = (target: Node) => relativeDocHref(node.path, target.path);
      let output = "";
      for (const piece of outsideCode(markdown)) {
        if (piece.code) {
          output += piece.text;
          continue;
        }
        let at = 0;
        for (const match of piece.text.matchAll(LINK)) {
          const [whole, , , bang, text = "", rawTarget = ""] = match;
          output += piece.text.slice(at, match.index);
          at = match.index + whole.length;
          if (match.groups?.code) {
            output += whole;
            continue;
          }
          const external = NOTION_PAGE_LINK.exec(rawTarget);
          if (external) {
            const known = byId.get(external[1]!.toLowerCase());
            output += known ? `[${text}](${hrefTo(known)})` : whole;
            continue;
          }
          if (/^[a-z][a-z0-9+.-]*:|^#/iu.test(rawTarget)) {
            output += whole;
            continue;
          }
          const [target = "", hash] = decode(rawTarget).split("#", 2);
          const file = posix.normalize(posix.join(dir === "." ? "" : dir, target));
          const page = byFile.get(file) ?? byFile.get(file.replace(/\.csv$/iu, "_all.csv"));
          if (page) {
            output += `[${text}](${hrefTo(page)}${hash ? `#${hash}` : ""})`;
            continue;
          }
          if (!archive.has(file)) {
            // A page that was not part of this export. Its words are all that can be kept.
            if (bang) sink.note(node.name, t("An image is not in the export: {0}", target));
            output += bang ? (text ? `*${text}*` : "") : text;
            continue;
          }
          if (!archive.fits(file)) {
            sink.note(node.name, t("A file is larger than 100 MiB and was left out: {0}", baseName(file)));
            output += text;
            continue;
          }
          const stored = await sink.asset(archive.read(file), baseName(file));
          if (!stored) {
            output += text;
            continue;
          }
          if (bang || IMAGE_FILE.test(file)) {
            output += `${bang ? "!" : ""}[${text || (bang ? "" : baseName(file))}](${stored})`;
            continue;
          }
          // Only a block can hold a file. If this is not one on a line of its own, the file goes at the end of the page.
          const line = /(^|\n)([^\n]*)$/u.exec(output)?.[2] ?? "";
          const after = piece.text.slice(at).split("\n", 1)[0] ?? "";
          if (!hasBlockText(line) && !hasBlockText(after)) output += fileBlock(text || baseName(file), stored);
          else {
            output += text || baseName(file);
            trailing.push(fileBlock(text || baseName(file), stored));
          }
        }
        output += piece.text.slice(at);
      }
      return output;
    };

    const emit = async (list: readonly Node[]): Promise<void> => {
      for (const [index, node] of list.entries()) {
        let title = node.name;
        let body = "";
        if (node.file && archive.size(node.file) > MAX_TEXT_BYTES) {
          sink.note(node.name, t("This page is too long to import"));
        } else if (node.file && /\.csv$/iu.test(node.file)) {
          body = toTable(parseDelimited(archive.text(node.file)));
        } else if (node.file) {
          const text = archive.text(node.file).replace(/\r\n/gu, "\n");
          const heading = /^# +(.+?) *(?:\n+|$)/u.exec(text);
          if (heading) title = heading[1]!;
          const trailing: string[] = [];
          body = await links(convertContainers(heading ? text.slice(heading[0].length) : text), node, trailing);
          if (trailing.length > 0) body = `${body.trimEnd()}\n\n${trailing.join("\n\n")}\n`;
        }
        await sink.page({ path: node.path, title, markdown: body.endsWith("\n") || !body ? body : `${body}\n`, sortOrder: (index + 1) * 10 });
        await emit(node.children);
      }
    };
    await emit(nodes);
  };

  return {
    source: "notion",
    input: "file",
    label: () => "Notion",
    async run({ bytes }, sink) {
      if (!bytes) throw new PermanentIngestError("INGEST_EMPTY", t("There is no file to import"));
      const outer = new ZipArchive(bytes);
      const files = outer.names.filter(name => !name.startsWith("__MACOSX/") && !name.endsWith(".DS_Store"));
      // A big export is a zip of zips, one for each part.
      const nested = files.length > 0 && files.every(name => /\.zip$/iu.test(name)) ? files.sort() : [];
      const archives = nested.length > 0
        ? nested.map(name => {
          if (outer.size(name) > MAX_NESTED_BYTES) throw new PermanentIngestError("ARCHIVE_TOO_LARGE", t("The archive is too large once unpacked"));
          return new ZipArchive(outer.read(name, MAX_NESTED_BYTES));
        })
        : [outer];
      if (!archives.some(archive => archive.names.some(name => /\.(?:md|csv)$/iu.test(name)))) throw new PermanentIngestError("IMPORT_WRONG_FORMAT", t("This does not look like a Notion export. Export as Markdown & CSV."));
      const trees = archives.map(archive => buildTree(archive.names));
      const count = (nodes: readonly Node[]): number => nodes.reduce((sum, node) => sum + 1 + count(node.children), 0);
      sink.expect(trees.reduce((sum, tree) => sum + count(tree), 0));
      for (const [at, archive] of archives.entries()) await importOne(archive, trees[at]!, sink);
    }
  };
}
