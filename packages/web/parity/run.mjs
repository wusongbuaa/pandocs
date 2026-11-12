// Compares the built app with a real Rspress build of the same Markdown, pixel by pixel. See README.md.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const work = join(here, ".work");
const GOLDEN_PORT = 4173;
const APP_PORT = 4174;
const PAGES = [
  ["elements", "元素样例"],
  ["second", "第二页"]
];
const WIDTHS = [1440, 1024, 390];
const THEMES = ["light", "dark"];
const MAX_DIFF_PERCENT = 0.2;
const npm = ["--no-audit", "--no-fund", "--registry", "https://registry.npmjs.org"];

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
}

function prepareGolden() {
  const root = join(work, "golden");
  mkdirSync(join(root, "docs/parity"), { recursive: true });
  if (!existsSync(join(root, "node_modules/@rspress/core"))) {
    writeFileSync(join(root, "package.json"), '{"private":true,"type":"module"}\n');
    run("npm", ["install", ...npm, "@rspress/core@2.1.0", "rspress-plugin-mermaid@2.0.0"], root);
  }
  for (const [name, title] of PAGES) {
    const body = readFileSync(join(here, "fixtures", `${name}.md`), "utf8");
    writeFileSync(join(root, "docs/parity", `${name}.md`), `# ${title}\n\n${body}`);
  }
  writeFileSync(
    join(root, "rspress.config.ts"),
    `
import * as path from "node:path";
import { defineConfig } from "@rspress/core";
import pluginMermaid from "rspress-plugin-mermaid";
const nav = [{ text: "比对", link: "/parity/" }, { text: "更多", items: [{ text: "第二页", link: "/parity/second" }] }];
export default defineConfig({
  root: path.join(__dirname, "docs"),
  outDir: path.join(__dirname, "out"),
  base: "/",
  title: "比对站点",
  lang: "zh",
  logoText: "比对站点",
  llms: true,
  plugins: [pluginMermaid()],
  markdown: { link: { checkDeadLinks: false } },
  route: { cleanUrls: true },
  themeConfig: {
    nav,
    sidebar: { "/parity/": ${JSON.stringify(PAGES.map(([name, title]) => ({ text: title, link: `/parity/${name}` })))} },
    footer: { message: "页脚文字" },
    lastUpdated: true,
    editLink: { docRepoBaseUrl: "https://example.test/edit/" },
    socialLinks: [{ icon: "github", mode: "link", content: "https://github.com/web-infra-dev/rspress" }],
    llmsUI: { viewOptions: ["markdownLink"] },
    outlineTitle: "目录", prevPageText: "上一页", nextPageText: "下一页", searchPlaceholderText: "搜索", editLinkText: "编辑此页面", lastUpdatedText: "最后更新于"
  }
});
`
  );
  if (!existsSync(join(root, ".git"))) {
    run("git", ["init", "-q", "."], root);
  }
  run("git", ["add", "-A", "docs"], root);
  try {
    run(
      "git",
      ["-c", "user.name=parity", "-c", "user.email=parity@example.invalid", "commit", "-qm", "parity", "--allow-empty"],
      root
    );
  } catch {
    /* nothing to commit */
  }
  run("npx", ["rspress", "build"], root);
  return join(root, "out");
}

function serve(directory, port, single) {
  const script = `
    import { createServer } from "node:http";
    import { createReadStream, existsSync, statSync } from "node:fs";
    import { extname, join, normalize } from "node:path";
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".md": "text/markdown" };
    const root = ${JSON.stringify(directory)};
    createServer((request, response) => {
      const path = decodeURIComponent(request.url.split("?")[0]);
      const send = file => { response.setHeader("content-type", types[extname(file)] ?? "application/octet-stream"); createReadStream(file).pipe(response); };
      const inner = ${single ? `path` : `path.startsWith("/docs/") ? path.slice("/docs".length) : path`};
      const file = normalize(join(root, inner));
      for (const candidate of [file, file + ".html", join(file, "index.html")]) if (existsSync(candidate) && statSync(candidate).isFile()) return send(candidate);
      ${single ? `return send(join(root, "index.html"));` : `response.statusCode = 404; response.end();`}
    }).listen(${port}, "127.0.0.1");
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
}

async function main() {
  mkdirSync(work, { recursive: true });
  const toolRoot = join(work, "tools");
  if (!existsSync(join(toolRoot, "node_modules/pixelmatch"))) {
    mkdirSync(toolRoot, { recursive: true });
    writeFileSync(join(toolRoot, "package.json"), '{"private":true,"type":"module"}\n');
    run("npm", ["install", ...npm, "pixelmatch@7", "pngjs@7"], toolRoot);
  }
  const require = createRequire(join(toolRoot, "package.json"));
  const { default: pixelmatch } = await import(require.resolve("pixelmatch"));
  const { PNG } = require("pngjs");
  const { chromium } = createRequire(join(app, "../../package.json"))("@playwright/test");

  const golden = prepareGolden();
  run("npx", ["vite", "build", "--mode", "parity", "--outDir", join(work, "app")], app);
  const servers = [serve(golden, GOLDEN_PORT, false), serve(join(work, "app"), APP_PORT, true)];
  await new Promise(resolve => setTimeout(resolve, 500));

  const browser = await chromium.launch({ channel: process.env.PARITY_BROWSER_CHANNEL ?? "chrome" });
  const shots = join(work, "shots");
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  let failed = false;
  try {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
          locale: "zh-CN"
        });
        await context.addInitScript(value => localStorage.setItem("rspress-theme-appearance", value), theme);
        const page = await context.newPage();
        for (const [name] of PAGES) {
          const capture = async (port, label) => {
            await page.goto(`http://127.0.0.1:${port}/parity/${name}`, { waitUntil: "networkidle" });
            // The two builds have different commit times.
            await page.addStyleTag({ content: ".rp-last-updated { visibility: hidden !important; }" });
            await page.waitForTimeout(600);
            const file = join(shots, `${name}-${width}-${theme}-${label}.png`);
            await page.screenshot({ path: file, fullPage: true });
            return PNG.sync.read(readFileSync(file));
          };
          const a = await capture(GOLDEN_PORT, "rspress");
          const b = await capture(APP_PORT, "app");
          const w = Math.min(a.width, b.width);
          const h = Math.min(a.height, b.height);
          const crop = source => {
            const out = new PNG({ width: w, height: h });
            PNG.bitblt(source, out, 0, 0, w, h, 0, 0);
            return out;
          };
          const diff = new PNG({ width: w, height: h });
          const count = pixelmatch(crop(a).data, crop(b).data, diff.data, w, h, { threshold: 0.1 });
          writeFileSync(join(shots, `${name}-${width}-${theme}-diff.png`), PNG.sync.write(diff));
          const percent = (100 * count) / (w * h);
          const sameSize = a.width === b.width && a.height === b.height;
          const ok = sameSize && percent <= MAX_DIFF_PERCENT;
          failed ||= !ok;
          console.log(
            `${ok ? "ok  " : "FAIL"} ${name} ${width} ${theme} size ${a.width}x${a.height}/${b.width}x${b.height} diff ${count}px ${percent.toFixed(4)}%`
          );
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    for (const server of servers) server.kill();
  }
  console.log(`Screenshots and diffs are in ${shots}`);
  process.exit(failed ? 1 : 0);
}

await main();
