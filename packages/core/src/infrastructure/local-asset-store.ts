import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, normalize, sep } from "node:path";
import type { AssetStore } from "../ports.js";
import { t } from "@pandocs/i18n";

/** For local development and single-node deployments; object storage is the production path. */
export function createLocalAssetStore(root: string): AssetStore {
  const locate = (key: string) => {
    const path = normalize(join(root, key));
    if (!path.startsWith(normalize(root) + sep)) throw new Error(t("The asset path goes outside its directory"));
    return path;
  };
  return {
    async put(key, bytes) {
      const path = locate(key);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, path);
    },
    async get(key) {
      try {
        return { bytes: await readFile(locate(key)) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(locate(key), { force: true });
    }
  };
}
