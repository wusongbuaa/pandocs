import { zipSync, type Zippable } from "fflate";
import type { Principal } from "../domain/types.js";
import type { AssetService } from "./assets.js";
import { requireSpace, type AppContext } from "./context.js";
import type { DocumentService } from "./documents.js";
import { loadRevision } from "./revisions.js";

const ASSET_PATH = /\bassets\/([a-f0-9]{64})(\.[a-z0-9]+)?/giu;
const STORED = { level: 0 } as const;

export class ExportService {
  constructor(private readonly context: AppContext, private readonly documents: DocumentService, private readonly assets: AssetService) {}

  /**
   * Everything this person can read in a space, in the shape it was written: `<path>.md` for each page, the images
   * they use under `assets/`, and a manifest with what Markdown cannot hold, such as titles and order.
   */
  async space(principal: Principal, slug: string): Promise<{ filename: string; bytes: Uint8Array }> {
    const { db } = this.context;
    const { space } = await requireSpace(db, principal, slug);
    const tree = await this.documents.tree(principal, slug);
    const files: Zippable = {};
    const assets = new Map<string, string>();
    const encoder = new TextEncoder();
    for (const node of tree) {
      const { markdown } = await loadRevision(db, node.id, node.currentRevisionNo);
      files[`${node.path}.md`] = encoder.encode(markdown);
      for (const [path, sha256] of markdown.matchAll(ASSET_PATH)) assets.set(path, sha256!.toLowerCase());
    }
    const missing: string[] = [];
    for (const [path, sha256] of assets) {
      try {
        files[path] = [(await this.assets.get(principal, slug, sha256)).bytes, STORED];
      } catch {
        // The pages are what matters; the manifest says which images could not be included.
        missing.push(path);
      }
    }
    const manifest = {
      space: { slug: space.slug, name: space.name, description: space.description },
      documents: tree.map(node => ({ file: `${node.path}.md`, title: node.title, labels: node.labels, parent: tree.find(item => item.id === node.parentId)?.path ?? null, sortOrder: node.sortOrder, revision: node.currentRevisionNo })),
      missingAssets: missing
    };
    files["manifest.json"] = encoder.encode(JSON.stringify(manifest, null, 2));
    return { filename: `${space.slug}.zip`, bytes: zipSync(files) };
  }
}
