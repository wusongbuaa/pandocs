import { createHash } from "node:crypto";
import { invalid, notFound } from "../domain/errors.js";
import type { AssetRecord, Principal, Role } from "../domain/types.js";
import { audit, requireSpace, type AppContext } from "./context.js";
import { t } from "@pandocs/i18n";

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

const SIGNATURES: readonly { mime: string; ext: string; test(bytes: Uint8Array): boolean }[] = [
  { mime: "image/png", ext: "png", test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: "image/jpeg", ext: "jpg", test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: "gif", test: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { mime: "image/webp", ext: "webp", test: b => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  { mime: "image/bmp", ext: "bmp", test: b => b[0] === 0x42 && b[1] === 0x4d },
  { mime: "video/mp4", ext: "mp4", test: b => ascii(b, 4, 8) === "ftyp" },
  { mime: "video/webm", ext: "webm", test: b => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: "application/pdf", ext: "pdf", test: b => ascii(b, 0, 5) === "%PDF-" }
];

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Decided from the bytes, never the caller's claim: only recognised formats are ever served inline. */
export function sniffMedia(bytes: Uint8Array): { mime: string; ext: string } {
  const match = SIGNATURES.find(signature => signature.test(bytes));
  return match ? { mime: match.mime, ext: match.ext } : { mime: "application/octet-stream", ext: "bin" };
}

export interface StoredAsset extends AssetRecord {
  /** How Markdown refers to it; stable wherever the page moves inside the space. */
  readonly path: string;
}

export class AssetService {
  constructor(private readonly context: AppContext) {}

  async put(
    principal: Principal,
    spaceSlug: string,
    bytes: Uint8Array,
    filename: string,
    required: Role = "editor"
  ): Promise<StoredAsset> {
    const { db, ports } = this.context;
    if (bytes.byteLength === 0) throw invalid("ASSET_EMPTY", t("The file is empty"));
    if (bytes.byteLength > MAX_ASSET_BYTES) throw invalid("ASSET_TOO_LARGE", t("The file is larger than 100 MiB"));
    const { space } = await requireSpace(db, principal, spaceSlug, required);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { mime, ext } = sniffMedia(bytes);
    await ports.assets.put(storageKey(space.id, sha256), bytes, mime);
    await db.transaction(async tx => {
      await tx.query(
        `INSERT INTO pandocs.assets (space_id, sha256, mime, size_bytes, filename, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (space_id, sha256) DO NOTHING`,
        [space.id, sha256, mime, bytes.byteLength, filename.slice(0, 240), principal.id]
      );
      await audit(tx, principal, "asset.put", "asset", sha256, { spaceId: space.id, size: bytes.byteLength });
    });
    return { spaceId: space.id, sha256, mime, sizeBytes: bytes.byteLength, filename, path: `assets/${sha256}.${ext}` };
  }

  /** For a background job, which has no one's rights to check: its submitter's were checked when it was accepted. */
  async storeForJob(spaceId: string, bytes: Uint8Array, filename: string, createdBy: string): Promise<void> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const { mime } = sniffMedia(bytes);
    await this.context.ports.assets.put(storageKey(spaceId, sha256), bytes, mime);
    await this.context.db.query(
      `INSERT INTO pandocs.assets (space_id, sha256, mime, size_bytes, filename, created_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (space_id, sha256) DO NOTHING`,
      [spaceId, sha256, mime, bytes.byteLength, filename.slice(0, 240), createdBy]
    );
  }

  async get(
    principal: Principal,
    spaceSlug: string,
    sha256: string
  ): Promise<{ record: AssetRecord; bytes: Uint8Array }> {
    const { db, ports } = this.context;
    const { space } = await requireSpace(db, principal, spaceSlug);
    // The public gets what public pages show. An upload from a restricted page, or one no longer used, stays closed.
    // Anyone else who can read the space gets any upload in it by its hash, which is what lets a draft show an image no
    // saved version uses yet. The hash is not guessable, and pages someone cannot read never show it to them.
    if (principal.anonymous) {
      const { rows: used } = await db.query(
        `SELECT 1 FROM pandocs.documents d WHERE d.space_id = $1 AND d.deleted_at IS NULL AND NOT d.restricted AND ($3::uuid[] IS NULL OR d.id = ANY($3))
           AND ($2 = ANY(d.asset_refs) OR EXISTS (SELECT 1 FROM pandocs.document_translations t WHERE t.document_id = d.id AND t.markdown LIKE '%assets/' || $2 || '%'))
         LIMIT 1`,
        [space.id, sha256.toLowerCase(), principal.shared?.documents ?? null]
      );
      if (!used[0]) throw notFound(t("Asset"));
    }
    const { rows } = await db.query(`SELECT * FROM pandocs.assets WHERE space_id = $1 AND sha256 = $2`, [
      space.id,
      sha256.toLowerCase()
    ]);
    if (!rows[0]) throw notFound(t("Asset"));
    const stored = await ports.assets.get(storageKey(space.id, String(rows[0].sha256)));
    if (!stored) throw notFound(t("Asset"));
    return {
      record: {
        spaceId: space.id,
        sha256: String(rows[0].sha256),
        mime: String(rows[0].mime),
        sizeBytes: Number(rows[0].size_bytes),
        filename: String(rows[0].filename)
      },
      bytes: stored.bytes
    };
  }
}

export function storageKey(spaceId: string, sha256: string): string {
  return `spaces/${spaceId}/${sha256}`;
}
