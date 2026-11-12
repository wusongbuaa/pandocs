import { api } from "../api/client";

/** The path to write into the Markdown, which keeps working wherever the page moves. */
export async function uploadAsset(space: string, file: File): Promise<string> {
  const asset = await api.uploadRaw<{ path: string }>(`spaces/${encodeURIComponent(space)}/assets?filename=${encodeURIComponent(file.name)}`, file);
  return asset.path;
}
