import { PermanentIngestError, type BulkImporter, type ImportSink } from "@pandocs/core";
import { t } from "@pandocs/i18n";
import { relativeDocHref } from "@pandocs/markdown";
import { blocksToMarkdown, type FeishuBlock } from "./feishu-blocks.js";
import { slugFor } from "./zip.js";

export interface FeishuConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** `https://open.feishu.cn`, or `https://open.larksuite.com` for Lark. */
  readonly baseUrl: string;
}

const MAX_PAGES = 5000;
const MAX_DEPTH = 20;
const MAX_ATTEMPTS = 5;
/** Renews a little before the end, so nothing is sent with a token that runs out on the way. */
const TOKEN_MARGIN_MS = 5 * 60 * 1000;
/** What they allow: 100 a minute for knowledge bases, 5 a second for documents and for files. */
const SPACING_MS = { wiki: 650, docs: 220 };
const WAIT_AFTER_LIMIT_MS = 5000;
const ACCESS_DENIED = new Set([131006, 1770032, 1770002, 2889902, 99991672, 99991679, 1061004, 91403]);
const TOKEN_EXPIRED = new Set([99991661, 99991663, 99991668]);
const RATE_LIMITED = new Set([99991400, 131008]);

interface WikiNode {
  readonly space_id?: string;
  readonly node_token: string;
  readonly obj_token: string;
  readonly obj_type: string;
  readonly node_type?: string;
  readonly has_child?: boolean;
  readonly title?: string;
}

interface Item {
  readonly title: string;
  readonly objType: string;
  readonly objToken: string;
  readonly nodeToken: string | null;
  readonly children: Item[];
  path: string;
}

type Target =
  | { readonly kind: "wiki"; readonly token: string }
  | { readonly kind: "docx"; readonly token: string }
  | { readonly kind: "space"; readonly id: string };

/** Only the token matters: what to fetch is asked of the API this server is set up for, whatever host the address names. */
export function parseFeishuAddress(text: string): Target {
  const pathname = URL.canParse(text) ? new URL(text).pathname : text;
  const space = /\/wiki\/(?:settings|space)\/([A-Za-z0-9]+)/u.exec(pathname);
  if (space) return { kind: "space", id: space[1]! };
  const node = /\/wiki\/([A-Za-z0-9]+)/u.exec(pathname);
  if (node) return { kind: "wiki", token: node[1]! };
  const document = /\/docx\/([A-Za-z0-9]+)/u.exec(pathname);
  if (document) return { kind: "docx", token: document[1]! };
  throw new PermanentIngestError("IMPORT_ADDRESS_INVALID", t("That is not the address of a document or knowledge base. It should contain /wiki/ or /docx/."));
}

const NO_ACCESS = () => t("The app has no access to this. Add it to the document or the knowledge base, and check its permissions. The documentation says how.");

function createClient(config: FeishuConfig, fetcher: typeof fetch, sleep: (ms: number) => Promise<void>) {
  const base = config.baseUrl.replace(/\/+$/u, "");
  let token: { value: string; until: number } | null = null;
  const nextAllowed = { wiki: 0, docs: 0 };

  const paced = async (kind: keyof typeof SPACING_MS) => {
    const now = Date.now();
    const wait = nextAllowed[kind] - now;
    nextAllowed[kind] = Math.max(now, nextAllowed[kind]) + SPACING_MS[kind];
    if (wait > 0) await sleep(wait);
  };

  const accessToken = async (): Promise<string> => {
    if (token && token.until > Date.now()) return token.value;
    const response = await fetcher(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret })
    });
    const payload = await response.json().catch(() => null) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number } | null;
    if (!payload?.tenant_access_token) throw new PermanentIngestError("FEISHU_APP_REFUSED", t("Feishu did not accept the app's credentials: {0}", String(payload?.msg ?? response.status)));
    token = { value: payload.tenant_access_token, until: Date.now() + (payload.expire ?? 7200) * 1000 - TOKEN_MARGIN_MS };
    return token.value;
  };

  /**
   * Being told to slow down is not a failure, and neither is a token that just ran out. No access ends an import, except
   * for a file in a document: the rest of the document is still worth having, and it says what is missing.
   */
  const request = async (kind: keyof typeof SPACING_MS, path: string, tolerant = false): Promise<Response> => {
    for (let attempt = 1; ; attempt += 1) {
      await paced(kind);
      const response = await fetcher(`${base}${path}`, { headers: { authorization: `Bearer ${await accessToken()}` } });
      const isJson = (response.headers.get("content-type") ?? "").includes("json");
      const code = isJson && !response.ok ? (await response.clone().json().catch(() => null) as { code?: number } | null)?.code : undefined;
      if (code !== undefined && TOKEN_EXPIRED.has(code) && attempt < MAX_ATTEMPTS) {
        token = null;
        continue;
      }
      if ((response.status === 429 || (code !== undefined && RATE_LIMITED.has(code))) && attempt < MAX_ATTEMPTS) {
        await sleep(WAIT_AFTER_LIMIT_MS * attempt);
        continue;
      }
      if (!tolerant && (response.status === 403 || (code !== undefined && ACCESS_DENIED.has(code)))) throw new PermanentIngestError("FEISHU_NO_ACCESS", NO_ACCESS());
      return response;
    }
  };

  const json = async <T>(kind: keyof typeof SPACING_MS, path: string): Promise<T> => {
    const response = await request(kind, path);
    const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: T } | null;
    if (payload?.code !== 0 || !payload.data) {
      if (payload?.code !== undefined && ACCESS_DENIED.has(payload.code)) throw new PermanentIngestError("FEISHU_NO_ACCESS", NO_ACCESS());
      throw new Error(t("Feishu answered {0}: {1}", String(payload?.code ?? response.status), String(payload?.msg ?? "")));
    }
    return payload.data;
  };

  return {
    node: async (nodeToken: string) => (await json<{ node: WikiNode }>("wiki", `/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`)).node,
    async children(spaceId: string, parent: string | null): Promise<WikiNode[]> {
      const items: WikiNode[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ page_size: "50", ...(parent ? { parent_node_token: parent } : {}), ...(pageToken ? { page_token: pageToken } : {}) });
        const data = await json<{ items?: WikiNode[]; has_more?: boolean; page_token?: string }>("wiki", `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${query}`);
        items.push(...(data.items ?? []));
        pageToken = data.has_more ? data.page_token : undefined;
      } while (pageToken);
      return items;
    },
    documentTitle: async (id: string) => (await json<{ document: { title?: string } }>("docs", `/open-apis/docx/v1/documents/${encodeURIComponent(id)}`)).document.title ?? "",
    async blocks(id: string): Promise<FeishuBlock[]> {
      const items: FeishuBlock[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({ page_size: "500", document_revision_id: "-1", ...(pageToken ? { page_token: pageToken } : {}) });
        const data = await json<{ items?: FeishuBlock[]; has_more?: boolean; page_token?: string }>("docs", `/open-apis/docx/v1/documents/${encodeURIComponent(id)}/blocks?${query}`);
        items.push(...(data.items ?? []));
        pageToken = data.has_more ? data.page_token : undefined;
      } while (pageToken);
      return items;
    },
    async media(fileToken: string): Promise<{ bytes: Uint8Array; name: string | null } | null> {
      const response = await request("docs", `/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, true);
      if (!response.ok) return null;
      const disposition = response.headers.get("content-disposition") ?? "";
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
      const plain = /filename="?([^";]+)"?/iu.exec(disposition)?.[1];
      return { bytes: new Uint8Array(await response.arrayBuffer()), name: encoded ? decodeURIComponent(encoded) : plain ?? null };
    },
    async whiteboard(id: string): Promise<Uint8Array | null> {
      const response = await request("docs", `/open-apis/board/v1/whiteboards/${encodeURIComponent(id)}/download_as_image`, true);
      return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/") ? new Uint8Array(await response.arrayBuffer()) : null;
    }
  };
}

const LABELS: Readonly<Record<string, () => string>> = {
  sheet: () => t("A spreadsheet"),
  bitable: () => t("A multidimensional table"),
  mindnote: () => t("A mind map"),
  slides: () => t("A slide deck"),
  file: () => t("A file"),
  doc: () => t("A document in the old format")
};

const ORIGINALS: Readonly<Record<string, string>> = { sheet: "sheets", bitable: "base", mindnote: "mindnotes", slides: "slides", file: "file", doc: "docs" };

/** Reads through the app's own credentials, so what it can read is what anyone who can edit a space here can bring in. */
export function createFeishuImporter(config: FeishuConfig, deps: { readonly fetch?: typeof fetch; readonly sleep?: (ms: number) => Promise<void> } = {}): BulkImporter {
  const fetcher = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(done => setTimeout(done, ms)));

  return {
    source: "feishu",
    input: "url",
    label: () => t("Feishu"),
    async run({ url = "", includeChildren }, sink: ImportSink) {
      const client = createClient(config, fetcher, sleep);
      const target = parseFeishuAddress(url);
      const origin = URL.canParse(url) ? new URL(url).origin : config.baseUrl;
      const seen = new Set<string>();
      let count = 0;

      const toItem = (node: WikiNode): Item => ({ title: node.title?.trim() || t("Untitled"), objType: node.obj_type, objToken: node.obj_token, nodeToken: node.node_token, children: [], path: "" });
      const walk = async (spaceId: string, parent: string | null, depth: number): Promise<Item[]> => {
        const items: Item[] = [];
        for (const node of await client.children(spaceId, parent)) {
          // A shortcut to something already here would only make the same page twice, and could go round in circles.
          if (seen.has(node.obj_token)) continue;
          seen.add(node.obj_token);
          if (++count > MAX_PAGES) {
            sink.note(node.title ?? node.node_token, t("Only the first {0} pages are imported at a time", MAX_PAGES));
            continue;
          }
          const item = toItem(node);
          if (node.has_child && depth < MAX_DEPTH) item.children.push(...await walk(spaceId, node.node_token, depth + 1));
          items.push(item);
        }
        return items;
      };

      let roots: Item[];
      if (target.kind === "docx") {
        roots = [{ title: await client.documentTitle(target.token) || t("Untitled"), objType: "docx", objToken: target.token, nodeToken: null, children: [], path: "" }];
      } else if (target.kind === "space") {
        roots = await walk(target.id, null, 0);
      } else {
        const node = await client.node(target.token);
        seen.add(node.obj_token);
        const item = toItem(node);
        if (includeChildren && node.has_child && node.space_id) item.children.push(...await walk(node.space_id, node.node_token, 1));
        roots = [item];
      }

      const paths = new Map<string, string>();
      const place = (items: readonly Item[], prefix: string) => {
        const taken = new Set<string>();
        for (const item of items) {
          item.path = `${prefix}${slugFor(item.title, item.nodeToken ?? item.objToken, taken)}`;
          paths.set(item.objToken, item.path);
          if (item.nodeToken) paths.set(item.nodeToken, item.path);
          place(item.children, `${item.path}/`);
        }
      };
      place(roots, "");
      sink.expect(new Set(paths.values()).size);

      const stored = new Map<string, string | null>();
      const emit = async (items: readonly Item[]) => {
        for (const [order, item] of items.entries()) {
          const originalUrl = item.nodeToken ? `${origin}/wiki/${item.nodeToken}` : `${origin}/docx/${item.objToken}`;
          let markdown: string;
          if (item.objType === "docx") {
            const note = (reason: string) => sink.note(item.title, reason);
            markdown = await blocksToMarkdown(await client.blocks(item.objToken), {
              originalUrl,
              note,
              linkToPage: token => {
                const path = paths.get(token);
                return path ? relativeDocHref(item.path, path) : null;
              },
              whiteboard: async token => {
                if (stored.has(token)) return stored.get(token) ?? null;
                const bytes = await client.whiteboard(token);
                const path = bytes ? await sink.asset(bytes, `${token}.png`) : null;
                stored.set(token, path);
                return path;
              },
              media: async (token, name) => {
                if (stored.has(token)) return stored.get(token) ?? null;
                const media = await client.media(token);
                if (!media) {
                  note(t("A file could not be downloaded: {0}", name));
                  stored.set(token, null);
                  return null;
                }
                const path = await sink.asset(media.bytes, media.name ?? name);
                stored.set(token, path);
                return path;
              }
            });
          } else {
            // A page to hold its place, so what is below it has somewhere to go, with the way back to the real thing.
            const what = LABELS[item.objType]?.() ?? item.objType;
            sink.note(item.title, t("{0} cannot be imported, so its page only links to the original", what));
            const original = item.nodeToken ? originalUrl : `${origin}/${ORIGINALS[item.objType] ?? item.objType}/${item.objToken}`;
            markdown = `:::note\n\n${t("{0} is not here. See the [original]({1}).", what, original)}\n\n:::\n`;
          }
          await sink.page({ path: item.path, title: item.title, markdown, sortOrder: (order + 1) * 10 });
          await emit(item.children);
        }
      };
      await emit(roots);
    }
  };
}
