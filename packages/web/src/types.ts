import type { Anchor, AnchorState, Diagnostic, EditOp, OutlineEntry, SourceBlock } from "@pandocs/markdown";
import { t } from "./i18n";

export type Role = "none" | "viewer" | "commenter" | "editor" | "admin";

const channelLabels = (): Readonly<Record<string, string>> => ({
  web: t("Web"),
  api: "API",
  cli: "CLI",
  mcp: "MCP",
  agent: t("Agent"),
  migration: t("Migration"),
  embed: t("Another system"),
  git: "Git"
});

/** Where a change came from, for showing; a channel this version does not know keeps its own name. */
export const channelLabel = (channel: string): string => channelLabels()[channel] ?? channel;

const ROLE_ORDER: readonly Role[] = ["none", "viewer", "commenter", "editor", "admin"];

export const atLeast = (role: Role, required: Role) => ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);

export interface Me {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly isAdmin: boolean;
  readonly scopes: readonly string[];
  /** No login: reading a public space. */
  readonly anonymous?: boolean;
}

export interface SiteNavItem {
  readonly text: string;
  readonly link?: string;
  readonly items?: readonly { readonly text: string; readonly link: string }[];
}

export interface SiteSettings {
  readonly title: string;
  readonly description: string;
  readonly logo: string;
  /** An address or a small uploaded image, or empty for Pandocs' icons. */
  readonly favicon: string;
  readonly footer: string;
  readonly defaultLang: string;
  readonly locales: readonly { readonly lang: string; readonly label: string }[];
  readonly nav: readonly SiteNavItem[] | null;
  readonly socialLinks: readonly { readonly icon: string; readonly link: string }[];
  readonly appLinks: readonly { readonly text: string; readonly link: string }[];
  readonly actions: readonly SiteAction[];
  readonly trashRetentionDays: number | null;
  readonly logoutUrl: string;
  readonly askForVisitors: boolean;
  /** `#rrggbb`, or empty for Pandocs' green. */
  readonly brandColor: string;
  readonly customCss: string;
}

export interface PageTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly markdown: string;
  readonly builtIn: boolean;
}

/** Something someone follows: a page, or a whole space when `documentId` is null. */
export interface Subscription {
  readonly kind: "document" | "space";
  readonly documentId: string | null;
  readonly title: string | null;
  readonly path: string | null;
  readonly spaceSlug: string;
  readonly spaceName: string;
  readonly createdAt: string;
}

export interface SearchHit {
  readonly id: string;
  readonly spaceSlug: string;
  readonly spaceName: string;
  readonly path: string;
  readonly title: string;
  readonly snippet: string;
  readonly updatedAt: string;
}

export interface SiteAction {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly copy?: string;
}

export interface TreeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sortOrder: number;
  readonly restricted: boolean;
  readonly currentRevisionNo: number;
  readonly updatedAt: string;
  readonly hasContent: boolean;
  /** Its title in the languages it has been translated into. */
  readonly titles?: Readonly<Record<string, string>>;
  readonly labels: readonly string[];
}

/** What it takes for changes to land in a space. */
export interface MergeRules {
  readonly requiredApprovals: number;
  readonly requireChangeSets: boolean;
}

export interface ChangeSetSummary {
  readonly id: string;
  readonly spaceSlug: string;
  readonly title: string;
  readonly description: string;
  readonly status: "open" | "merged" | "closed";
  readonly authorId: string;
  readonly authorName: string;
  readonly authorKind: string;
  readonly decidedName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pages?: number;
  readonly approvals?: number;
}

export interface ChangeSetPage {
  readonly id: string;
  readonly kind: "edit" | "create" | "delete" | "restore";
  readonly documentId: string | null;
  readonly path: string;
  readonly title: string;
  readonly baseRevisionNo: number | null;
  readonly currentRevisionNo: number | null;
  readonly baseMarkdown: string;
  readonly proposedMarkdown: string;
}

export interface ChangeSetDetail extends Omit<ChangeSetSummary, "pages"> {
  readonly pages: readonly ChangeSetPage[];
  readonly hiddenPages: number;
  readonly reviews: readonly {
    readonly reviewerName: string;
    readonly verdict: string;
    readonly note: string;
    readonly stale: boolean;
  }[];
  readonly blockers: readonly { readonly code: string; readonly message: string; readonly path?: string }[];
  readonly canReview: boolean;
  readonly canChange: boolean;
  readonly canMerge: boolean;
  readonly canDelete: boolean;
}

export interface Space {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly defaultRole: Role;
  /** Anyone can read it, with or without a login. */
  readonly publicRead?: boolean;
  readonly role: Role;
  readonly glossary: readonly GlossaryEntry[];
  readonly mergeRules?: MergeRules;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export interface SpaceWithTree extends Space {
  readonly tree: readonly TreeEntry[];
}

export interface Bootstrap {
  readonly me: Me;
  /** Whether pages can be shared with people who have no login. */
  readonly shareLinks: boolean;
  /** Pages get the custom CSS as a stylesheet, so it is left out here. */
  readonly site: Omit<SiteSettings, "customCss" | "favicon">;
  readonly spaces: readonly SpaceWithTree[];
  readonly searchIndexHash: string;
  /** The site is too large to send its text to the browser, so full-text results come from the server. */
  readonly fullTextOnServer?: boolean;
  /** Off where every account comes from the company, so there is no password to ask about. */
  readonly passwordLogin?: boolean;
  readonly ai?: {
    /** A model is set up on this site. */
    readonly configured: boolean;
    /** This person can ask it about the documents. */
    readonly ask: boolean;
  };
}

export interface RevisionMeta {
  readonly no: number;
  readonly sha256: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly channel: string;
  readonly proposalId: string | null;
  readonly ingestJobId: string | null;
  readonly message: string;
  readonly createdAt: string;
}

export interface DocumentView {
  readonly document: {
    readonly id: string;
    readonly path: string;
    readonly title: string;
    readonly restricted: boolean;
    readonly parentId: string | null;
    readonly currentRevisionNo: number;
    readonly updatedAt: string;
  };
  readonly spaceSlug: string;
  readonly role: Role;
  readonly revision: RevisionMeta;
  readonly markdown?: string;
  readonly outline: readonly OutlineEntry[];
  readonly blocks: readonly SourceBlock[];
  readonly diagnostics: readonly Diagnostic[];
  readonly editing: { readonly name: string; readonly until: string } | null;
  readonly labels: readonly string[];
}

export interface CommentView {
  readonly id: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly authorKind: string;
  readonly channel: string;
  readonly body: string;
  readonly createdAt: string;
  readonly editedAt?: string | null;
  readonly mentions?: readonly { readonly id: string; readonly name: string }[];
  readonly reactions?: readonly { readonly emoji: string; readonly count: number; readonly mine: boolean }[];
}

export interface ThreadView {
  readonly id: string;
  readonly documentId: string;
  readonly anchor: Anchor;
  readonly anchorState: AnchorState;
  readonly status: "open" | "resolved";
  readonly summary: string | null;
  readonly createdName: string;
  readonly resolvedName: string | null;
  readonly createdAt: string;
  readonly comments: readonly CommentView[];
}

export interface ProposalSummary {
  readonly id: string;
  readonly baseRevisionNo: number;
  readonly ops: readonly EditOp[];
  readonly rationale: string;
  readonly authorName: string;
  readonly authorKind: string;
  readonly status: "pending" | "accepted" | "rejected";
  readonly decidedName: string | null;
  readonly createdAt: string;
}

export interface ProposalDetail extends ProposalSummary {
  readonly stale: boolean;
  readonly currentRevisionNo: number;
  readonly baseMarkdown: string;
  readonly proposedMarkdown: string;
}

export interface InboxView {
  readonly notifications: readonly {
    readonly id: string;
    readonly kind: string;
    readonly documentTitle: string;
    readonly documentPath: string;
    readonly spaceSlug: string;
    readonly threadId: string | null;
    readonly changeSetId?: string | null;
    readonly actorName: string;
    readonly summary: string;
    readonly createdAt: string;
    readonly readAt: string | null;
  }[];
  readonly proposals: readonly {
    readonly id: string;
    readonly documentTitle: string;
    readonly documentPath: string;
    readonly spaceSlug: string;
    readonly rationale: string;
    readonly authorName: string;
    readonly createdAt: string;
  }[];
  readonly changeSets: readonly ChangeSetSummary[];
}

export interface ImportJob {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly route: string;
  readonly persist: "publish" | "draft" | "proposal";
  readonly status: "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "discarded";
  readonly errorMessage: string | null;
  readonly draftMarkdown: string | null;
  readonly draftTitle: string | null;
  readonly documentId: string | null;
  readonly proposalId: string | null;
  /** Where whoever started it asked for the page to go. */
  readonly target?: { readonly parentPath?: string; readonly slug?: string };
  readonly createdName: string;
  readonly createdAt: string;
  readonly report: {
    readonly warnings?: readonly string[];
    readonly diagnostics?: readonly { readonly severity: string; readonly message: string }[];
    readonly processors?: readonly { readonly name: string; readonly detail?: string }[];
  };
}

export interface Member {
  readonly subject: string;
  readonly role: Role;
  readonly name?: string;
}

export interface TrashEntry {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly deletedAt: string;
  readonly deletedName: string | null;
  readonly descendants: number;
}

export interface DeletedSpace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly deletedAt: string;
  readonly deletedName: string | null;
}

export type AuditCategory = "document" | "discussion" | "proposal" | "member" | "space";

export interface AuditEntry {
  readonly id: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly channel: string;
  readonly action: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly documentTitle: string | null;
  readonly documentPath: string | null;
  readonly spaceSlug: string | null;
  readonly createdAt: string;
}

export interface TranslationView {
  readonly lang: string;
  readonly title: string;
  readonly markdown: string;
  readonly sourceRevision: number;
  readonly stale: boolean;
  readonly machine: boolean;
  readonly updatedAt: string;
}
