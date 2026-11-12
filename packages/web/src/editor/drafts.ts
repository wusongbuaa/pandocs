import { api } from "../api/client";
import { app } from "../data/runtime-data";

export interface DraftContent {
  readonly markdown: string;
  readonly baseRevision: number;
  /** Only a translation has a title of its own to keep. */
  readonly title?: string | null;
}

export interface StoredDraft extends DraftContent {
  readonly updatedAt: string;
}

const draftPath = (documentId: string, lang: string) => `documents/${documentId}/draft${lang ? `?lang=${lang}` : ""}`;

export const loadServerDraft = (documentId: string, lang: string) =>
  api.get<StoredDraft | null>(draftPath(documentId, lang));

/** `leaving` lets the request outlive the page, for up to 64 KB; a longer draft relies on the copy in this browser. */
export const saveServerDraft = (
  documentId: string,
  lang: string,
  { markdown, baseRevision, title }: DraftContent,
  leaving = false
) =>
  api.send<{ updatedAt: string }>("PUT", draftPath(documentId, lang), {
    keepalive: leaving,
    body: { markdown, baseRevision, ...(title ? { title } : {}) }
  });

export const deleteServerDraft = (documentId: string, lang: string) => api.send("DELETE", draftPath(documentId, lang));

const localKey = (documentId: string, lang: string) => `pandocs:draft:${app.bootstrap.me.id}:${documentId}:${lang}`;

/** What the server could not take yet: no connection, an expired session, or a tab closing mid-save. */
export function keepLocalDraft(documentId: string, lang: string, draft: DraftContent): void {
  try {
    localStorage.setItem(localKey(documentId, lang), JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }));
  } catch {
    // Storage is full or blocked; the server's copy is all there is.
  }
}

export function readLocalDraft(documentId: string, lang: string): StoredDraft | null {
  try {
    const stored = JSON.parse(localStorage.getItem(localKey(documentId, lang)) ?? "null") as StoredDraft | null;
    return stored &&
      typeof stored.markdown === "string" &&
      typeof stored.baseRevision === "number" &&
      typeof stored.updatedAt === "string"
      ? stored
      : null;
  } catch {
    return null;
  }
}

export function forgetLocalDraft(documentId: string, lang: string): void {
  try {
    localStorage.removeItem(localKey(documentId, lang));
  } catch {
    // Nothing was kept, then.
  }
}

export interface ListedDraft {
  readonly documentId: string;
  readonly lang: string;
  readonly title: string;
  readonly path: string;
  readonly spaceSlug: string;
  readonly spaceName: string;
  readonly updatedAt: string;
  /** The server has never seen it, for example because the tab closed offline. */
  readonly localOnly?: boolean;
  /** The draft everyone who can edit the page has in common, which this person has written in. */
  readonly shared?: boolean;
}

function localDrafts(): readonly ListedDraft[] {
  const prefix = `pandocs:draft:${app.bootstrap.me.id}:`;
  let keys: readonly string[];
  try {
    keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "").filter(key =>
      key.startsWith(prefix)
    );
  } catch {
    return [];
  }
  return keys.flatMap(key => {
    const [documentId = "", lang = ""] = key.slice(prefix.length).split(":");
    const draft = readLocalDraft(documentId, lang);
    for (const space of app.bootstrap.spaces) {
      const entry = space.tree.find(item => item.id === documentId);
      if (draft && entry)
        return [
          {
            documentId,
            lang,
            title: entry.title,
            path: entry.path,
            spaceSlug: space.slug,
            spaceName: space.name,
            updatedAt: draft.updatedAt,
            localOnly: true
          }
        ];
    }
    return [];
  });
}

/** Everything left unfinished, on this computer as well as on the server. */
export async function listDrafts(): Promise<readonly ListedDraft[]> {
  const stored = await api.get<readonly ListedDraft[]>("me/drafts");
  const known = new Set(stored.map(draft => `${draft.documentId}:${draft.lang}`));
  return [...stored, ...localDrafts().filter(draft => !known.has(`${draft.documentId}:${draft.lang}`))].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  );
}

/** Whichever was written last, and whether the server still has to be told about it. */
export function latestDraft(
  server: StoredDraft | null,
  local: StoredDraft | null
): { draft: StoredDraft; local: boolean } | null {
  if (local && (!server || Date.parse(local.updatedAt) > Date.parse(server.updatedAt)))
    return { draft: local, local: true };
  return server ? { draft: server, local: false } : null;
}
