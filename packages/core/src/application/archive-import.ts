import { createHash } from "node:crypto";
import { t } from "@pandocs/i18n";
import { unzipSync } from "fflate";
import { z } from "zod";
import { PandocsError, invalid } from "../domain/errors.js";
import type { Principal } from "../domain/types.js";
import type { AssetService } from "./assets.js";
import { requireSpace, type AppContext } from "./context.js";
import { documentLabels, type DocumentService } from "./documents.js";
import { PageWriter } from "./page-writer.js";

const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 1024 * 1024 * 1024;
const ASSET_FILE = /^assets\/([a-f0-9]{64})(?:\.[a-z0-9]+)?$/iu;

const manifestSchema = z.object({
  documents: z.array(
    z.object({
      file: z.string().min(1),
      // Spaces, tabs and line breaks in a title read as one space, as anywhere else a title is given.
      title: z.string().transform(value => value.replace(/\s+/gu, " ").trim()),
      sortOrder: z.number().optional(),
      labels: documentLabels.optional()
    })
  )
});

export interface ArchiveImportReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly assets: number;
  /** What could not come in, and why; everything else did. */
  readonly skipped: readonly { readonly file: string; readonly reason: string }[];
}

/** Sizes in a zip are only claims, so this checks them before anything is unpacked, and refuses what would fill the memory. */
function unpack(bytes: Uint8Array): Record<string, Uint8Array> {
  let count = 0;
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: file => {
        count += 1;
        total += file.originalSize;
        if (count > MAX_ENTRIES || total > MAX_UNPACKED_BYTES)
          throw invalid("ARCHIVE_TOO_LARGE", t("The archive is too large once unpacked"));
        return true;
      }
    });
  } catch (error) {
    if (error instanceof PandocsError) throw error;
    throw invalid("ARCHIVE_INVALID", t("This is not a valid archive"));
  }
}

/**
 * Brings back what `ExportService` packed, into this space or another. Pages at the same address get a new version when
 * their text differs, so nothing is lost and running it twice changes nothing. Each page commits on its own: a page
 * that cannot come in is reported rather than undoing the others.
 */
export class ArchiveImportService {
  constructor(
    private readonly context: AppContext,
    private readonly documents: DocumentService,
    private readonly assets: AssetService
  ) {}

  async import(principal: Principal, spaceSlug: string, bytes: Uint8Array): Promise<ArchiveImportReport> {
    const { db } = this.context;
    await requireSpace(db, principal, spaceSlug, "editor");
    const files = unpack(bytes);
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes)
      throw invalid("ARCHIVE_INVALID", t("The archive has no manifest.json, so it was not exported from here"));
    const parsed = manifestSchema.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(manifestBytes));
        } catch {
          return null;
        }
      })()
    );
    if (!parsed.success) throw invalid("ARCHIVE_INVALID", t("manifest.json has the wrong content"));

    const skipped: { file: string; reason: string }[] = [];
    let assets = 0;
    // Images first, so no page is ever saved pointing at one that is not there yet.
    for (const [file, content] of Object.entries(files)) {
      const match = ASSET_FILE.exec(file);
      if (!match) continue;
      if (createHash("sha256").update(content).digest("hex") !== match[1]!.toLowerCase()) {
        skipped.push({ file, reason: t("A file's content does not match the checksum in its name") });
        continue;
      }
      await this.assets.put(principal, spaceSlug, content, file.slice("assets/".length));
      assets += 1;
    }

    const writer = await PageWriter.open(
      this.context,
      this.documents,
      principal,
      spaceSlug,
      t("Imported from an archive")
    );
    const pages = parsed.data.documents
      .map(page => ({ ...page, path: page.file.replace(/\.md$/u, "") }))
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const page of pages) {
      const content = files[page.file];
      if (!content) {
        skipped.push({ file: page.file, reason: t("The archive does not have this file") });
        continue;
      }
      if (!page.title) {
        skipped.push({ file: page.file, reason: t("It has no title") });
        continue;
      }
      try {
        const outcome = await writer.write({
          path: page.path,
          title: page.title,
          markdown: new TextDecoder().decode(content),
          sortOrder: page.sortOrder,
          labels: page.labels
        });
        if (outcome === "created") created += 1;
        else if (outcome === "updated") updated += 1;
        else unchanged += 1;
      } catch (error) {
        if (!(error instanceof PandocsError)) throw error;
        skipped.push({ file: page.file, reason: error.message });
      }
    }
    return { created, updated, unchanged, assets, skipped };
  }
}
