import { api } from "../api/client";
import { SAMPLE_SPACE } from "../data/manage";
import { app } from "../data/runtime-data";
import examples from "../../sample-docs/examples.json";

const files = import.meta.glob<string>("../../sample-docs/{zh,en}/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true
});
const images = import.meta.glob<string>("../../sample-docs/assets/*", {
  query: "?url",
  import: "default",
  eager: true
});

export type SampleLanguage = "zh" | "en";

/** In the order of the sidebar, each after the page holding it. */
export const SAMPLE_PAGES = [
  "index",
  "start",
  "concepts",
  "writing",
  "writing/editor",
  "writing/blocks",
  "writing/layouts",
  "collaboration",
  "collaboration/comments",
  "collaboration/change-sets",
  "collaboration/following",
  "agents",
  "agents/together",
  "agents/connect",
  "agents/files",
  "agents/api",
  "agents/api-reference",
  "import",
  "import/files",
  "import/tools",
  "import/git-sync",
  "ai",
  "embedding",
  "running",
  "running/deploy",
  "running/storage",
  "running/people",
  "running/public",
  "running/look",
  "running/licenses"
] as const;

const HEAD = /^---\ntitle: (.+)\n/u;

/** The title leaves the front matter, since a page has it apart from its text. Nothing else there means no front matter at all. */
export function samplePage(
  language: SampleLanguage,
  path: string
): { readonly title: string; readonly markdown: string } {
  const source = files[`../../sample-docs/${language}/${path}.md`]!;
  const head = HEAD.exec(source)!;
  const rest = source.slice(head[0].length);
  return { title: head[1]!, markdown: rest.startsWith("---\n") ? rest.slice(4).replace(/^\n+/u, "") : `---\n${rest}` };
}

export const sampleImageNames = () => Object.keys(images).map(file => file.slice(file.lastIndexOf("/") + 1));

async function uploadImages(): Promise<ReadonlyMap<string, string>> {
  const uploaded = new Map<string, string>();
  for (const [file, url] of Object.entries(images)) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const blob = await (await fetch(url)).blob();
    const { path } = await api.uploadRaw<{ path: string }>(
      `spaces/${SAMPLE_SPACE}/assets?filename=${encodeURIComponent(name)}`,
      new File([blob], name, { type: blob.type })
    );
    uploaded.set(`assets/${name}`, path);
  }
  return uploaded;
}

const withImages = (markdown: string, uploaded: ReadonlyMap<string, string>) =>
  markdown.replace(/assets\/[\w.-]+/gu, written => uploaded.get(written) ?? written);

interface Created {
  readonly document: { readonly id: string };
  readonly revision: { readonly no: number };
}

/**
 * Pandocs' own documents, written through the same API as anything else. What is there already stays as it is, so
 * running this again after it stopped part way only adds what is missing, and never undoes what someone has changed.
 */
export async function importSampleDocs(onProgress: (done: number, total: number) => void): Promise<void> {
  const { site, spaces } = app.bootstrap;
  const original: SampleLanguage = site.defaultLang.startsWith("zh") ? "zh" : "en";
  const other: SampleLanguage = original === "zh" ? "en" : "zh";
  const translatedTo = site.locales.find(locale => locale.lang.startsWith(other))?.lang;
  if (!spaces.some(space => space.slug === SAMPLE_SPACE)) {
    const front = samplePage(original, "index");
    const tagline = /^ {2}tagline: (.+)$/mu.exec(front.markdown)?.[1] ?? "";
    await api.send("POST", "spaces", {
      body: { slug: SAMPLE_SPACE, name: front.title, description: tagline, defaultRole: "viewer" }
    });
  }
  const uploaded = await uploadImages();
  const there = new Set(
    (await api.get<readonly { path: string }[]>(`spaces/${SAMPLE_SPACE}/tree`)).map(entry => entry.path)
  );
  const created = new Map<string, string>();
  let done = 0;
  for (const path of SAMPLE_PAGES) {
    if (!there.has(path)) {
      const page = samplePage(original, path);
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : undefined;
      const { document, revision } = await api.send<Created>("POST", `spaces/${SAMPLE_SPACE}/documents`, {
        body: {
          title: page.title,
          slug: path.slice(path.lastIndexOf("/") + 1),
          markdown: withImages(page.markdown, uploaded),
          ...(parent ? { parentPath: parent } : {})
        }
      });
      created.set(path, document.id);
      if (translatedTo) {
        const translation = samplePage(other, path);
        await api.send("PUT", `documents/${document.id}/translations/${translatedTo}`, {
          body: {
            title: translation.title,
            markdown: withImages(translation.markdown, uploaded),
            sourceRevision: revision.no,
            machine: false
          }
        });
      }
    }
    done += 1;
    onProgress(done, SAMPLE_PAGES.length);
  }
  const example = created.get(examples.page);
  if (example) {
    const { comment, suggestion } = examples[original];
    await api.send("POST", `documents/${example}/threads`, {
      body: { anchor: { kind: "quote", quote: comment.quote }, body: comment.body }
    });
    await api.send("POST", `documents/${example}/proposals`, {
      body: {
        baseRevision: 1,
        ops: [{ op: "str_replace", pattern: suggestion.pattern, content: suggestion.content }],
        rationale: suggestion.rationale
      }
    });
  }
}
