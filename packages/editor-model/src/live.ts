import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as ProseMirrorNode, type Schema } from "@tiptap/pm/model";
import { prosemirrorToYDoc, updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { joinFrontMatter, splitFrontMatter } from "@pandocs/markdown";
import * as Y from "yjs";
import { createDialectExtensions, createDialectManager, editorSourceBlocks } from "./dialect.js";
import { blocksOf, writeBackBlocks } from "./write-back.js";

/** Where the editor's binding keeps a document's content in shared state. */
export const LIVE_FIELD = "default";
/** What everyone in a shared draft should agree on besides the text. */
export const LIVE_META = "pandocs";

export type LiveMeta = Readonly<Record<string, string | number | null>>;

export interface LiveCodec {
  /** Shared state saying what this Markdown says. */
  seed(markdown: string, meta: LiveMeta): Uint8Array;
  /** What the state says, as Markdown. Blocks nobody touched keep the bytes they have in `baseMarkdown`. */
  markdownOf(state: Uint8Array, baseMarkdown: string): string;
  /** Makes the state say this Markdown, touching only what differs, so that the change can merge with what others are typing. */
  align(state: Uint8Array, markdown: string, meta: LiveMeta): { readonly state: Uint8Array; readonly change: Uint8Array };
}

export function createLiveCodec(): LiveCodec {
  const { manager, marked } = createDialectManager();
  const schema: Schema = getSchema(createDialectExtensions());
  const parsed = (body: string): JSONContent => ProseMirrorNode.fromJSON(schema, manager.parse(body)).toJSON() as JSONContent;
  const serialize = (doc: JSONContent) => manager.serialize(doc);
  /** The editor adds an empty paragraph after a last block that is not one, so it has somewhere to put the caret. If this one does too, no one has to. */
  const editable = (body: string): ProseMirrorNode => {
    const doc = ProseMirrorNode.fromJSON(schema, manager.parse(body));
    return doc.lastChild?.type.name === "paragraph" ? doc : doc.copy(doc.content.addToEnd(schema.nodes.paragraph!.create()));
  };
  const setMeta = (doc: Y.Doc, frontMatter: string, meta: LiveMeta) => {
    const shared = doc.getMap<string | number | null>(LIVE_META);
    if (shared.get("frontMatter") !== frontMatter) shared.set("frontMatter", frontMatter);
    for (const [key, value] of Object.entries(meta)) if (shared.get(key) !== value) shared.set(key, value);
  };
  const open = (state: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  };

  return {
    seed(markdown, meta) {
      const { frontMatter, body } = splitFrontMatter(markdown);
      const doc = prosemirrorToYDoc(editable(body), LIVE_FIELD);
      doc.transact(() => setMeta(doc, frontMatter, meta));
      return Y.encodeStateAsUpdate(doc);
    },
    markdownOf(state, baseMarkdown) {
      const doc = open(state);
      const { frontMatter, body } = splitFrontMatter(baseMarkdown);
      const current = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(LIVE_FIELD), schema).toJSON() as JSONContent;
      const text = writeBackBlocks(editorSourceBlocks(marked, body), blocksOf(parsed(body), serialize), blocksOf(current, serialize));
      const front = doc.getMap<string>(LIVE_META).get("frontMatter") ?? frontMatter;
      doc.destroy();
      // Written out, a document always ends with one line break, and a page that did not has not changed for that.
      return joinFrontMatter(front, text.trimEnd() === body.trimEnd() ? body : text);
    },
    align(state, markdown, meta) {
      const doc = open(state);
      const before = Y.encodeStateVector(doc);
      const { frontMatter, body } = splitFrontMatter(markdown);
      doc.transact(() => {
        updateYFragment(doc, doc.getXmlFragment(LIVE_FIELD), editable(body), { mapping: new Map(), isOMark: new Map() } as never);
        setMeta(doc, frontMatter, meta);
      });
      const result = { state: Y.encodeStateAsUpdate(doc), change: Y.encodeStateAsUpdate(doc, before) };
      doc.destroy();
      return result;
    }
  };
}
