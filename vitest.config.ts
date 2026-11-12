import { defineConfig } from "vitest/config";
import { webProject } from "./packages/web/build/vitest-project.js";

const root = new URL(".", import.meta.url).pathname;

const aliases = {
  "@pandocs/client": `${root}packages/client/src/index.ts`,
  "@pandocs/editor-model": `${root}packages/editor-model/src/index.ts`,
  "@pandocs/i18n": `${root}packages/i18n/src/index.ts`,
  "@pandocs/markdown/zh": `${root}packages/markdown/src/i18n/zh.ts`,
  "@pandocs/markdown/issue-message": `${root}packages/markdown/src/issue-message.ts`,
  "@pandocs/markdown": `${root}packages/markdown/src/index.ts`,
  "@pandocs/core/migrate": `${root}packages/core/src/infrastructure/migrate.ts`,
  "@pandocs/core/s3-asset-store": `${root}packages/core/src/infrastructure/s3-asset-store.ts`,
  "@pandocs/core": `${root}packages/core/src/index.ts`
};

const shared = { fileParallelism: false, testTimeout: 60000 };

const project = (name: string, include: string[]) => ({
  resolve: { alias: aliases },
  test: { ...shared, name, include, passWithNoTests: true }
});

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    ...shared,
    projects: [
      project("i18n", ["packages/i18n/test/**/*.test.ts"]),
      project("markdown", ["packages/markdown/test/**/*.test.ts"]),
      project("editor-model", ["packages/editor-model/test/**/*.test.ts"]),
      project("core", ["packages/core/test/**/*.test.ts"]),
      project("server", ["packages/server/test/**/*.test.ts"]),
      webProject(shared, aliases),
      project("e2e", ["test/e2e/**/*.spec.ts"])
    ]
  }
});
