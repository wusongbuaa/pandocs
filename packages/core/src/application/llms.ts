import { splitFrontMatter } from "@pandocs/markdown";
import type { Principal } from "../domain/types.js";
import { requireSpace, type AppContext } from "./context.js";
import type { DocumentService, TreeNode } from "./documents.js";
import { loadRevision } from "./revisions.js";
import type { TranslationService } from "./translations.js";
import type { SiteService } from "./site.js";
import type { SpaceService } from "./spaces.js";

export interface LlmsOptions {
  /** Where the site is, for links that work from anywhere. */
  readonly origin?: string | undefined;
  /** One of the site's languages other than the one its pages are written in. */
  readonly lang?: string | undefined;
}

/** The order a person reads them in: each page, then what is under it. */
function readingOrder(tree: readonly TreeNode[]): TreeNode[] {
  const visible = new Set(tree.map(node => node.id));
  const walk = (parentId: string | null): TreeNode[] => tree.filter(node => node.parentId === parentId).flatMap(node => [node, ...walk(node.id)]);
  // A page whose parent this person cannot see still belongs in the list.
  return [...walk(null), ...tree.filter(node => node.parentId !== null && !visible.has(node.parentId)).flatMap(node => [node, ...walk(node.id)])];
}

/**
 * The convention from llmstxt.org: an index of what is here, and everything in one file, for agents that a person
 * points at this site. Only what that person can read. Where this is served from decides the links: with no `origin`
 * they are relative, which is all a copy of the file can count on.
 */
export class LlmsService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly spaces: SpaceService,
    private readonly site: SiteService,
    private readonly translations: TranslationService
  ) {}

  private async scope(principal: Principal, slug: string | undefined) {
    const spaces = slug ? [(await requireSpace(this.context.db, principal, slug)).space] : await this.spaces.list(principal);
    return Promise.all(spaces.map(async space => ({ ...space, tree: readingOrder(await this.documents.tree(principal, space.slug)) })));
  }

  private async heading(slug: string | undefined, spaces: readonly { readonly name: string; readonly description: string }[]) {
    if (slug) return { title: spaces[0]!.name, description: spaces[0]!.description };
    return this.site.get();
  }

  async index(principal: Principal, slug?: string, options: LlmsOptions = {}): Promise<string> {
    const { origin, lang } = options;
    const spaces = await this.scope(principal, slug);
    const { title, description } = await this.heading(slug, spaces);
    const link = (space: string, node: TreeNode) => origin === undefined
      ? `${slug ? "" : `${space}/`}${node.path}.md`
      : `${origin}${lang ? `/${lang}` : ""}/${encodeURIComponent(space)}/${node.path.split("/").map(encodeURIComponent).join("/")}.md`;
    const lines = [`# ${title}`, "", ...(description ? [`> ${description}`, ""] : [])];
    for (const space of spaces) {
      // A page that only holds others has nothing to read.
      lines.push(`## ${space.name}`, "", ...space.tree.filter(node => node.hasContent).map(node => `- [${(lang ? node.titles?.[lang] : undefined) ?? node.title}](${link(space.slug, node)})`), "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  async full(principal: Principal, slug?: string, options: LlmsOptions = {}): Promise<string> {
    const { lang } = options;
    const spaces = await this.scope(principal, slug);
    const parts: string[] = [];
    for (const space of spaces) {
      for (const node of space.tree) {
        // A page nobody has translated is read in its own language, the same as on the site.
        const translated = lang && node.titles?.[lang] !== undefined ? await this.translations.get(principal, node.id, lang) : null;
        const title = translated?.title ?? node.title;
        const { body } = splitFrontMatter(translated?.markdown ?? (await loadRevision(this.context.db, node.id, node.currentRevisionNo)).markdown);
        parts.push(body.trimStart().startsWith(`# ${title}\n`) ? body.trim() : `# ${title}\n\n${body.trim()}`.trim());
      }
    }
    return `${parts.join("\n\n---\n\n")}\n`;
  }
}
