import { posix } from "node:path";
import { PermanentIngestError, type BulkImporter, type ImportSink } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { relativeDocHref } from "@pandocs/markdown";
import domino from "@mixmark-io/domino";
import { createHtmlConverter } from "../extract/text.js";
import { baseName, fileBlock, IMAGE_FILE, slugFor, ZipArchive } from "./zip.js";

/** The parser the HTML conversion already uses. It says it has types, but they are not a module. */
const { createDocument } = domino as unknown as { createDocument(html: string): Document };

const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const CALLOUTS: readonly (readonly [string, string])[] = [["information", "info"], ["note", "warning"], ["warning", "danger"], ["tip", "tip"]];
/** What the code macro calls a language that a highlighter calls something else. */
const LANGUAGES: Readonly<Record<string, string>> = { js: "javascript", py: "python", sh: "bash", shell: "bash", ps: "powershell", cs: "csharp", rb: "ruby", none: "", text: "", plain: "" };

interface Page {
  readonly file: string;
  readonly title: string;
  readonly children: Page[];
  path: string;
}

const listOf = <T>(list: ArrayLike<unknown>): T[] => Array.from({ length: list.length }, (_, at) => list[at] as T);
const elements = (root: ParentNode, selector: string) => listOf<HTMLElement>(root.querySelectorAll(selector));
const hasClass = (element: Element, name: string) => element.classList.contains(name);
const idOf = (file: string) => /(\d+)\.html$/u.exec(file)?.[1] ?? baseName(file).replace(/\.html$/u, "");

function unwrap(element: Element): void {
  while (element.firstChild) element.parentNode!.insertBefore(element.firstChild, element);
  element.remove();
}

function replaceWithText(element: Element, text: string): void {
  element.parentNode!.replaceChild(element.ownerDocument.createTextNode(text), element);
}

const ELSEWHERE = /^[a-z][a-z0-9+.-]*:|^\/\//iu;

/**
 * Where the export keeps a file a page refers to, or nothing for somewhere else on the web. Confluence also refers to
 * an attachment by where it downloads from, `download/attachments/…`, from the site's root, under /wiki or with the
 * site's address, and the export keeps it at `attachments/…`.
 */
function exportedFile(archive: ZipArchive, prefix: string, reference: string): string | undefined {
  const path = reference.split(/[?#]/u, 1)[0]!;
  const download = /(?:^|\/)download\/(attachments\/.+)$/u.exec(path)?.[1];
  let file: string;
  try {
    file = posix.normalize(`${prefix}${decodeURI(download ?? path)}`);
  } catch {
    return undefined;
  }
  return ELSEWHERE.test(path) && !(download !== undefined && archive.has(file)) ? undefined : file;
}

/** The page tree the export draws in its index: the list that holds links to pages. */
function treeFromIndex(indexHtml: string, prefix: string, known: ReadonlySet<string>): Page[] {
  const document = createDocument(indexHtml);
  const fromList = (list: Element): Page[] => listOf<Element>(list.children).filter(item => item.nodeName === "LI").flatMap(item => {
    const link = listOf<Element>(item.children).find(child => child.nodeName === "A") ?? item.querySelector("a");
    const nested = listOf<Element>(item.children).find(child => child.nodeName === "UL");
    const children = nested ? fromList(nested) : [];
    const file = link ? `${prefix}${link.getAttribute("href") ?? ""}` : "";
    return known.has(file) ? [{ file, title: (link!.textContent ?? "").trim(), children, path: "" }] : children;
  });
  for (const list of elements(document, "ul")) {
    if (list.parentElement?.closest("ul")) continue;
    const found = fromList(list);
    if (found.length > 0) return found;
  }
  return [];
}

function titleFromPage(document: Document, file: string): string {
  const shown = (document.querySelector("#title-text")?.textContent ?? document.querySelector("title")?.textContent ?? "").trim();
  // It says "Space : Title".
  return shown.slice(shown.indexOf(" : ") + 3).trim() || shown || baseName(file).replace(/\.html$/u, "");
}

function languageOf(pre: Element): string {
  const brush = /brush:\s*([\w+#-]+)/u.exec(pre.getAttribute("data-syntaxhighlighter-params") ?? "")?.[1]?.toLowerCase() ?? "";
  return LANGUAGES[brush] ?? brush;
}

export function createConfluenceImporter(): BulkImporter {
  const service = createHtmlConverter();
  service.addRule("callout", {
    filter: node => node.nodeName === "DIV" && (node as unknown as Element).hasAttribute("data-pandocs-callout"),
    replacement(content, node) {
      const element = node as unknown as Element;
      const title = element.getAttribute("data-pandocs-title");
      return `\n\n:::${element.getAttribute("data-pandocs-callout")!}${title ? `[${title}]` : ""}\n\n${content.trim()}\n\n:::\n\n`;
    }
  });

  const convert = async (html: string, page: Page, context: { archive: ZipArchive; prefix: string; pathOf: ReadonlyMap<string, string>; sink: ImportSink }): Promise<{ markdown: string; title: string }> => {
    const { archive, prefix, pathOf, sink } = context;
    const document = createDocument(html);
    const main = document.querySelector("#main-content");
    const title = page.title || titleFromPage(document, page.file);
    if (!main) return { markdown: "", title };
    const stored = new Map<string, string | null>();
    const keep = async (file: string, name: string) => {
      if (!stored.has(file) && !archive.fits(file)) {
        sink.note(title, t("A file is larger than 100 MiB and was left out: {0}", name));
        stored.set(file, null);
      }
      if (!stored.has(file)) stored.set(file, await sink.asset(archive.read(file), name));
      return stored.get(file) ?? null;
    };
    const trailing: string[] = [];
    const placed = new Set<string>();

    for (const element of elements(main, ".toc-macro, .confluence-information-macro-icon, .aui-icon, .expand-control-icon, script, style")) element.remove();
    for (const macro of elements(main, ".confluence-information-macro")) {
      const kind = CALLOUTS.find(([name]) => hasClass(macro, `confluence-information-macro-${name}`))?.[1] ?? "info";
      macro.setAttribute("data-pandocs-callout", kind);
      const heading = macro.querySelector("p.title");
      if (heading) {
        macro.setAttribute("data-pandocs-title", (heading.textContent ?? "").replace(/[[\]]/gu, " ").trim());
        heading.remove();
      }
    }
    for (const expand of elements(main, ".expand-container")) {
      expand.setAttribute("data-pandocs-callout", "details");
      const label = expand.querySelector(".expand-control");
      expand.setAttribute("data-pandocs-title", (label?.textContent ?? "").replace(/[[\]]/gu, " ").trim());
      label?.remove();
    }
    for (const header of elements(main, ".codeHeader")) header.remove();
    for (const pre of elements(main, "pre")) {
      const language = languageOf(pre);
      const code = document.createElement("code");
      if (language) code.setAttribute("class", `language-${language}`);
      code.textContent = pre.textContent ?? "";
      pre.textContent = "";
      pre.appendChild(code);
    }
    for (const item of elements(main, ".inline-task-list > li")) {
      const box = document.createElement("input");
      box.setAttribute("type", "checkbox");
      if (hasClass(item, "checked")) box.setAttribute("checked", "");
      item.insertBefore(box, item.firstChild);
    }
    for (const image of elements(main, "img")) {
      if (hasClass(image, "emoticon")) {
        replaceWithText(image, image.getAttribute("alt") ?? "");
        continue;
      }
      const source = image.getAttribute("src") ?? "";
      const file = exportedFile(archive, prefix, source);
      if (file === undefined) continue;
      if (!archive.has(file)) {
        sink.note(title, t("An image is not in the export: {0}", source));
        image.remove();
        continue;
      }
      const name = image.getAttribute("data-linked-resource-default-alias") ?? baseName(file);
      const path = await keep(file, name);
      if (!path) {
        image.remove();
        continue;
      }
      placed.add(file);
      image.setAttribute("src", path);
      image.setAttribute("alt", image.getAttribute("alt") || name);
      const link = image.closest("a");
      if (link) unwrap(link);
    }
    for (const link of elements(main, "a")) {
      const href = link.getAttribute("href") ?? "";
      if (hasClass(link, "confluence-userlink") || hasClass(link, "user-mention")) {
        replaceWithText(link, link.textContent ?? "");
        continue;
      }
      const file = href.startsWith("#") ? undefined : exportedFile(archive, prefix, href);
      if (file === undefined || !href) continue;
      const hash = href.split("#", 2)[1];
      const known = pathOf.get(file);
      if (known) {
        link.setAttribute("href", `${relativeDocHref(page.path, known)}${hash ? `#${hash}` : ""}`);
        continue;
      }
      if (!file.startsWith(`${prefix}attachments/`) || !archive.has(file)) {
        // Somewhere that was not exported, so nowhere a link could lead.
        if (file.startsWith(`${prefix}attachments/`)) sink.note(title, t("An attachment is not in the export: {0}", href));
        replaceWithText(link, link.textContent ?? "");
        continue;
      }
      const label = link.getAttribute("data-linked-resource-default-alias") ?? (link.textContent ?? "").trim();
      // Named as the link reads, with the kind of file it is when the words do not say.
      const name = !label ? baseName(file) : /\.[a-z0-9]{1,8}$/iu.test(label) ? label : `${label}${posix.extname(file)}`;
      const path = await keep(file, name);
      replaceWithText(link, link.textContent ?? "");
      if (path && !placed.has(file)) {
        placed.add(file);
        trailing.push(fileBlock(name, path));
      }
    }
    // Whatever is attached to the page and not shown in its text. Confluence lists them below it.
    for (const link of elements(document, "#attachments ~ * a, .pageSection a")) {
      const file = exportedFile(archive, prefix, link.getAttribute("href") ?? "");
      if (file === undefined || !file.startsWith(`${prefix}attachments/`) || placed.has(file) || !archive.has(file)) continue;
      const name = (link.textContent ?? "").trim() || baseName(file);
      const path = await keep(file, name);
      if (!path) continue;
      placed.add(file);
      trailing.push(IMAGE_FILE.test(file) ? `![${name.replace(/[[\]]/gu, " ")}](${path})` : fileBlock(name, path));
    }
    const body = service.turndown(main as unknown as HTMLElement).trim();
    return { title, markdown: `${[body, ...trailing].filter(Boolean).join("\n\n")}\n` };
  };

  return {
    source: "confluence",
    input: "file",
    label: () => "Confluence",
    async run({ bytes }, sink) {
      if (!bytes) throw new PermanentIngestError("INGEST_EMPTY", t("There is no file to import"));
      const archive = new ZipArchive(bytes);
      const index = archive.names.filter(name => baseName(name) === "index.html").sort((a, b) => a.split("/").length - b.split("/").length)[0];
      if (!index) throw new PermanentIngestError("IMPORT_WRONG_FORMAT", t("This does not look like a Confluence export. Export the space as HTML."));
      const prefix = index.slice(0, -"index.html".length);
      const files = new Set(archive.names.filter(name => name.startsWith(prefix) && name.endsWith(".html") && name !== index && !name.slice(prefix.length).includes("/")));
      const roots = treeFromIndex(archive.text(index), prefix, files);
      const placed = new Map<string, Page>();
      const remember = (pages: readonly Page[]) => {
        for (const page of pages) {
          placed.set(page.file, page);
          remember(page.children);
        }
      };
      remember(roots);
      // Pages the index leaves out are placed by their breadcrumbs, or else at the top.
      const crumbs = new Map<string, string | null>();
      for (const file of files) {
        if (placed.has(file)) continue;
        // One too long to import still gets its place, so it is only its breadcrumbs that are not read.
        const document = createDocument(archive.size(file) > MAX_PAGE_BYTES ? "" : archive.text(file));
        const trail = elements(document, "#breadcrumbs a").map(link => `${prefix}${link.getAttribute("href") ?? ""}`).filter(item => files.has(item) && item !== file);
        crumbs.set(file, trail.at(-1) ?? null);
        placed.set(file, { file, title: titleFromPage(document, file), children: [], path: "" });
      }
      for (const [file, parent] of crumbs) {
        const page = placed.get(file)!;
        if (parent && placed.has(parent)) placed.get(parent)!.children.push(page);
        else roots.push(page);
      }
      const pathOf = new Map<string, string>();
      const assign = (pages: readonly Page[], base: string) => {
        const taken = new Set<string>();
        for (const page of pages) {
          page.path = `${base}${slugFor(page.title, `p${idOf(page.file)}`, taken)}`;
          pathOf.set(page.file, page.path);
          assign(page.children, `${page.path}/`);
        }
      };
      assign(roots, "");
      sink.expect(pathOf.size);
      const emit = async (pages: readonly Page[]) => {
        for (const [order, page] of pages.entries()) {
          if (archive.size(page.file) > MAX_PAGE_BYTES) {
            sink.note(page.title, t("This page is too long to import"));
            await sink.page({ path: page.path, title: page.title, markdown: "", sortOrder: (order + 1) * 10 });
          } else {
            const { title, markdown } = await convert(archive.text(page.file), page, { archive, prefix, pathOf, sink });
            await sink.page({ path: page.path, title, markdown, sortOrder: (order + 1) * 10 });
          }
          await emit(page.children);
        }
      };
      await emit(roots);
    }
  };
}
