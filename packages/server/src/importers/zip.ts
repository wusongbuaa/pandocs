import { PermanentIngestError } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { unzipSync } from "fflate";

const MAX_ENTRIES = 20_000;
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
/** The most one file of an export unpacks to, which is also the most an upload can be. Only a nested archive may say more. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * An export, read one file at a time: exports can be mostly attachments, of which only one needs to be in memory at once.
 * Sizes in a zip are only claims, so they are looked at before anything is unpacked.
 */
export class ZipArchive {
  private readonly sizes = new Map<string, number>();

  constructor(private readonly bytes: Uint8Array) {
    let total = 0;
    try {
      unzipSync(bytes, {
        filter: file => {
          if (!file.name.endsWith("/")) this.sizes.set(file.name, file.originalSize);
          total += file.originalSize;
          if (this.sizes.size > MAX_ENTRIES || total > MAX_UNPACKED_BYTES)
            throw new PermanentIngestError("ARCHIVE_TOO_LARGE", t("The archive is too large once unpacked"));
          return false;
        }
      });
    } catch (error) {
      if (error instanceof PermanentIngestError) throw error;
      throw new PermanentIngestError("ARCHIVE_INVALID", t("This is not a valid archive"));
    }
  }

  get names(): readonly string[] {
    return [...this.sizes.keys()];
  }

  has(name: string): boolean {
    return this.sizes.has(name);
  }

  size(name: string): number {
    return this.sizes.get(name) ?? 0;
  }

  /** Unpacking happens all at once, in this process, so what a file claims to be is checked before it is. */
  read(name: string, most = MAX_FILE_BYTES): Uint8Array {
    if (this.size(name) > most)
      throw new PermanentIngestError("ARCHIVE_TOO_LARGE", t("The archive is too large once unpacked"));
    const found = unzipSync(this.bytes, { filter: file => file.name === name })[name];
    if (!found) throw new PermanentIngestError("ARCHIVE_INVALID", t("This is not a valid archive"));
    return found;
  }

  /** A file too large to keep is left out, and said so, rather than unpacked only to be refused. */
  fits(name: string): boolean {
    return this.size(name) <= MAX_FILE_BYTES;
  }

  text(name: string): string {
    return new TextDecoder("utf-8", { fatal: false }).decode(this.read(name)).replace(/^﻿/u, "");
  }
}

/** Addresses that are readable and stay the same each time: from a plain-letter title, or else from the id the source gives it. */
export function slugFor(title: string, id: string, taken: Set<string>): string {
  const fromTitle = /^[\x20-\x7e]+$/u.test(title)
    ? title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-+|-+$/gu, "")
        .slice(0, 60)
        .replace(/-+$/u, "")
    : "";
  const base =
    fromTitle && !/^(?:assets?|index)$/u.test(fromTitle)
      ? fromTitle
      : id
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "")
          .slice(0, 12) || "page";
  let slug = base;
  for (let attempt = 2; taken.has(slug); attempt += 1) slug = `${base}-${attempt}`;
  taken.add(slug);
  return slug;
}

export const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/iu;
/** Text a page has as an attachment or embedded file. `[` and `]` end it, and quotes end the address. */
export const fileBlock = (name: string, path: string) =>
  `::file[${name.replace(/[[\]\r\n]/gu, " ")}]{src="${path.replaceAll('"', "%22")}"}`;
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
