import { t } from "@pandocs/i18n";
import { invalid } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { AppContext } from "./context.js";
import type { DocumentService, TreeNode } from "./documents.js";
import { loadRevision } from "./revisions.js";

const MAX_TITLE_CHARS = 200;

export interface PageToWrite {
  /** Below the space. The page above it has to come first. */
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly sortOrder?: number | undefined;
  readonly labels?: readonly string[] | undefined;
}

export type WriteOutcome = "created" | "updated" | "unchanged";

/**
 * Writing pages from elsewhere. A page at the same address gets a new version when its text differs, so nothing is lost
 * and doing it twice changes nothing. Each page commits on its own: one that cannot come in does not undo the others.
 */
export class PageWriter {
  private constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly principal: Principal,
    private readonly space: string,
    private readonly message: string,
    private readonly existing: Map<string, TreeNode>,
    private readonly known: Set<string>
  ) {}

  static async open(context: AppContext, documents: DocumentService, principal: Principal, space: string, message: string): Promise<PageWriter> {
    const tree = await documents.tree(principal, space);
    return new PageWriter(context, documents, principal, space, message, new Map(tree.map(node => [node.path, node])), new Set(tree.map(node => node.path)));
  }

  async write(page: PageToWrite): Promise<WriteOutcome> {
    const title = page.title.slice(0, MAX_TITLE_CHARS);
    const current = this.existing.get(page.path);
    if (current) {
      const { markdown } = await loadRevision(this.context.db, current.id, current.currentRevisionNo);
      const retitled = title !== current.title;
      if (page.labels && page.labels.join() !== current.labels.join()) await this.documents.setLabels(this.principal, current.id, page.labels);
      if (markdown === page.markdown && !retitled) return "unchanged";
      await this.documents.saveContent(this.principal, current.id, { markdown: page.markdown, expectedRevision: current.currentRevisionNo, message: this.message, ...(retitled ? { title } : {}) });
      return "updated";
    }
    const segments = page.path.split("/");
    const parentPath = segments.slice(0, -1).join("/");
    if (parentPath && !this.known.has(parentPath)) throw invalid("IMPORT_NO_PARENT", t("Its parent page was not imported"));
    const made = await this.documents.create(this.principal, {
      space: this.space,
      title,
      markdown: page.markdown,
      slug: segments.at(-1)!,
      ...(parentPath ? { parentPath } : {}),
      ...(page.sortOrder === undefined ? {} : { sortOrder: page.sortOrder }),
      message: this.message
    });
    if (page.labels?.length) await this.documents.setLabels(this.principal, made.document.id, page.labels);
    this.known.add(page.path);
    return "created";
  }
}
