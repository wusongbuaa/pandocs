import type { BlockRegistry, DocumentAnalysis, MergeResult } from "@pandocs/markdown";
import type { SiteSettings } from "./application/site.js";
import type { WebhookEvent } from "./application/webhook-events.js";
import type { IngestReport, Mention, Principal } from "./domain/types.js";

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType?: string | undefined;
}

export interface AssetStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** For what is only kept for a while, such as an uploaded export until it has been imported. Nothing happens if it is not there. */
  remove?(key: string): Promise<void>;
}

export interface Directory {
  search(query: string, limit: number): Promise<readonly Mention[]>;
  /** Display names for the management pages. Without it they show the raw identifiers. */
  names?(ids: readonly string[]): Promise<readonly Mention[]>;
  /** Who someone is when they are not the one asking, to tell what they can read before writing to them. Null for an account that is gone or disabled. */
  principal?(id: string): Promise<Principal | null>;
}

export interface NotificationEvent {
  readonly kind: "mention" | "reply" | "proposal_decided" | "page_updated";
  readonly recipientId: string;
  readonly documentId: string;
  readonly documentTitle: string;
  /** Where the app shows it, for a link in the message: `<space>/<path>?thread=<id>`. */
  readonly location: string;
  readonly actorName: string;
  readonly summary: string;
  /** Other pages they follow that changed, which this one message also covers. */
  readonly alsoUpdated?: readonly { readonly documentTitle: string; readonly location: string }[] | undefined;
}

/** External push. The in-product "related to me" list works without one. */
export interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

export const ASSIST_ACTIONS = ["explain", "rewrite", "translate", "summarize"] as const;
export type AssistAction = (typeof ASSIST_ACTIONS)[number];
/** Not for selections: the text and the discussion both come from the server, and the result is only ever a suggestion. */
export type ModelAction = AssistAction | "apply_discussion";

/** Something the model can do, with its arguments as JSON Schema. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** Whatever the model sent. It is not checked against the schema, and `undefined` if it could not be read at all. */
  readonly input: unknown;
}

export interface ModelTurn {
  readonly text: string;
  readonly calls: readonly ModelToolCall[];
}

/** A run of turns with a model, which keeps the provider's own history: some of what it sends has to go back unchanged. */
export interface ModelConversation {
  /** `allowTools` false makes this the last turn: the model has to answer with what it has. */
  turn(input: { readonly allowTools: boolean; readonly onText: (delta: string) => void }): Promise<ModelTurn>;
  /** The answers to all of the last turn's calls, before the next one. */
  answerCalls(results: readonly { readonly id: string; readonly content: string; readonly failed?: boolean }[]): void;
  /** Writes down what it cost. It counts as one use however many turns it took. */
  finish(): Promise<void>;
}

export interface LlmPort {
  /** One bounded call with no tools, so hosts can meter it and keep agents elsewhere. */
  complete(input: {
    readonly purpose: "thread_summary" | "document_summary";
    readonly prompt: string;
    readonly actor: Principal;
  }): Promise<string>;
  /** Same bounds as `complete`. `content` is what the reader selected, `context` the text around it, `target` the language to translate into. */
  assist(input: {
    readonly action: ModelAction;
    readonly content: string;
    readonly context: string;
    readonly target?: string | undefined;
    readonly actor: Principal;
  }): Promise<string>;
  /** For asking the documents a question. Refuses straight away when `actor` is over their limit. A host without it simply offers no such thing. */
  conversation?(input: {
    readonly purpose: "ask";
    readonly actor: Principal;
    readonly system: string;
    /** Ends with what the model should answer now. */
    readonly history: readonly { readonly role: "user" | "assistant"; readonly text: string }[];
    readonly tools: readonly ModelTool[];
    readonly signal: AbortSignal;
  }): Promise<ModelConversation>;
}

export interface ProcessorInput {
  readonly bytes?: Uint8Array | undefined;
  readonly markdown?: string | undefined;
  readonly contentType: string;
  readonly filename: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly jobId: string;
}

export interface ProcessorOutput {
  readonly markdown: string;
  readonly title?: string | undefined;
  readonly detail?: string | undefined;
  readonly warnings?: readonly string[] | undefined;
  /** Images and the like found inside the source, which `markdown` refers to as `assets/<sha256>.<ext>`. */
  readonly files?: readonly { readonly bytes: Uint8Array; readonly filename: string }[] | undefined;
}

/** The extension point for inbound content: a custom parser is a new processor plus a route. */
export interface Processor {
  readonly name: string;
  run(input: ProcessorInput): Promise<ProcessorOutput>;
}

export interface ImportedPage {
  /** Its place in what is being imported. The page above it has to come first. */
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly sortOrder?: number | undefined;
}

/** Where an importer puts what it finds, as it goes. */
export interface ImportSink {
  /** How many pages to expect, for showing progress. */
  expect(pages: number): void;
  /** Keeps a file, and says how a page refers to it: `assets/<sha256>.<ext>`. Null if it could not be kept, which has been noted. */
  asset(bytes: Uint8Array, filename: string): Promise<string | null>;
  page(page: ImportedPage): Promise<void>;
  /** Something that did not come over, or not all of it. */
  note(file: string, reason: string): void;
}

/** Turns what another tool has into pages. Throw `PermanentIngestError` for what trying again cannot help. */
export interface BulkImporter {
  readonly source: string;
  /** An exported file to upload, or the address of what to fetch. */
  readonly input: "file" | "url";
  /** Its name, for the record each page's new version leaves. */
  label(): string;
  run(
    input: {
      readonly bytes?: Uint8Array | undefined;
      readonly url?: string | undefined;
      readonly includeChildren: boolean;
    },
    sink: ImportSink
  ): Promise<void>;
}

/** Shared state, as bytes, and what it says as Markdown. The core keeps it and compares versions; what is inside it is the editor's business. */
export interface LiveCodecPort {
  seed(markdown: string, meta: Readonly<Record<string, string | number | null>>): Promise<Uint8Array>;
  markdownOf(state: Uint8Array, baseMarkdown: string): Promise<string>;
  align(
    state: Uint8Array,
    markdown: string,
    meta: Readonly<Record<string, string | number | null>>
  ): Promise<{ readonly state: Uint8Array; readonly change: Uint8Array }>;
  /** A three-way merge, which on a long page should not hold up whatever else is going on. */
  merge(base: string, ours: string, theirs: string): Promise<MergeResult>;
}

export interface GitRemote {
  readonly repository: string;
  readonly branch: string;
  /** Empty for a repository anyone can read. */
  readonly token: string;
}

/** A fresh copy of a branch, for the length of one sync. */
export interface GitWorkspace {
  /** Null for a branch or repository with nothing in it yet. */
  readonly head: string | null;
  /** Who made the latest commit, and what they said about it. */
  readonly author: { readonly name: string; readonly subject: string } | null;
  /** Every file on the branch, by the identifier Git gives its content. */
  readonly files: ReadonlyMap<string, string>;
  /** Says which files are about to be read, so that they can arrive together. */
  prefetch(paths: readonly string[]): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  /** Makes one commit on top of `head` and pushes it. Fails if the branch has moved on. Says what it made. */
  commit(input: {
    readonly write: readonly { readonly path: string; readonly bytes: Uint8Array }[];
    readonly remove: readonly string[];
    readonly message: string;
    readonly author: { readonly name: string; readonly email: string };
  }): Promise<string>;
  dispose(): Promise<void>;
}

/** Talks to a Git host, which the core does not do itself. Without one, spaces cannot be connected to repositories. */
export interface GitPort {
  /** Where a branch is now, or null if it has nothing yet. Cheap enough to ask often. */
  head(remote: GitRemote): Promise<string | null>;
  open(remote: GitRemote): Promise<GitWorkspace>;
}

export interface WebhookTarget {
  readonly kind: "generic" | "slack" | "feishu" | "wecom" | "dingtalk" | "teams";
  readonly url: string;
  /** Empty when the other side checks nothing. */
  readonly secret: string;
}

export interface WebhookMessage {
  /** Stays the same across retries, for the other side to tell a repeat from something new. */
  readonly id: string;
  readonly siteTitle: string;
  /** Chats get several in one message. Anything else gets them one by one. */
  readonly events: readonly WebhookEvent[];
}

export interface WebhookSendResult {
  readonly ok: boolean;
  /** Null when no answer came back at all. */
  readonly status: number | null;
  readonly error: string | null;
}

/** Talks to the world, which the core does not do itself. Without one, what happens waits until a host that has one comes along. */
export interface WebhookSender {
  send(target: WebhookTarget, message: WebhookMessage): Promise<WebhookSendResult>;
}

export interface PandocsPorts {
  readonly assets: AssetStore;
  readonly directory?: Directory | undefined;
  readonly notifier?: Notifier | undefined;
  readonly webhookSender?: WebhookSender | undefined;
  readonly git?: GitPort | undefined;
  /** Without one, people edit alone and merge when they save. */
  readonly liveCodec?: LiveCodecPort | undefined;
  readonly llm?: LlmPort | undefined;
  readonly processors?: readonly Processor[] | undefined;
  readonly importers?: readonly BulkImporter[] | undefined;
  readonly registry?: BlockRegistry | undefined;
  /** Keeps no reading numbers, search terms or questions. */
  readonly statsDisabled?: boolean | undefined;
  /** For sites that must never be open to the internet, whatever a space administrator wants. */
  readonly publicSpacesDisabled?: boolean | undefined;
  /** Parses off the main thread, so one long document cannot hold up every other request. Without it, parsing happens in line. */
  readonly analyze?: ((markdown: string) => Promise<DocumentAnalysis>) | undefined;
  /** What the host wants before anyone has opened the settings page: its name, logo and neighbouring applications. */
  readonly siteDefaults?: Partial<SiteSettings> | undefined;
  /** Whoever hosts this has accounts with passwords. Off, the app has no password to ask about. */
  readonly passwordLogin?: boolean | undefined;
}

export type { IngestReport };
