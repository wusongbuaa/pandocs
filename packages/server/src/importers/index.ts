import type { BulkImporter } from "@pandocs/core";
import { createConfluenceImporter } from "./confluence.js";
import { createFeishuImporter, type FeishuConfig } from "./feishu.js";
import { createNotionImporter } from "./notion.js";

/** Exports anyone can upload, and what needs an app set up on the other side only where one has been. */
export function createImporters(feishu: FeishuConfig | undefined): readonly BulkImporter[] {
  return [createNotionImporter(), createConfluenceImporter(), ...(feishu ? [createFeishuImporter(feishu)] : [])];
}
