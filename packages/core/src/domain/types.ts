import type { Language } from "@pandocs/i18n";
import type { Anchor, AnchorState, EditOp } from "@pandocs/markdown";

export type Role = "viewer" | "commenter" | "editor" | "admin";
export type SpaceDefaultRole = Role | "none";
export type Scope = "read" | "write";
export type Channel = "web" | "api" | "cli" | "mcp" | "agent" | "migration" | "embed" | "git";
export type PrincipalKind = "user" | "agent";

/** Resolved by the host before a request reaches Pandocs. Ids are opaque to this product. */
export interface Principal {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  readonly groups: readonly string[];
  readonly isAdmin: boolean;
  readonly scopes: readonly Scope[];
  readonly channel: Channel;
  /**
   * Someone from another system, on a page it embeds. They get what was granted to them by name: not a space's default
   * role, and not what everyone gets, since "everyone" here means the people of this site.
   */
  readonly guest?: boolean | undefined;
  /** No login at all, reading a public space. See `ANONYMOUS_PRINCIPAL`. */
  readonly anonymous?: boolean | undefined;
  /** Came through a share link: these pages and nothing else, whatever else is open to anyone. */
  readonly shared?: { readonly spaceId: string; readonly documents: readonly string[] } | undefined;
  /** An agent acts for someone: it can read no more than they can. */
  readonly onBehalfOf?: { readonly id: string; readonly groups: readonly string[]; readonly isAdmin?: boolean | undefined };
}

/** What it takes for changes to land in a space. */
export interface MergeRules {
  /** How many people have to approve a change set before it can be merged. */
  readonly requiredApprovals: number;
  /** Nobody saves directly: everything goes through a change set, or a suggestion someone accepts. */
  readonly requireChangeSets: boolean;
}

export interface SpaceRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly defaultRole: SpaceDefaultRole;
  /** Anyone can read it, with or without a login. Comments, history and restricted pages stay closed. */
  readonly publicRead: boolean;
  readonly glossary: readonly GlossaryEntry[];
  readonly mergeRules: MergeRules;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly definition: string;
}

export interface MemberRecord {
  readonly subject: string;
  readonly role: Role;
}

export interface DocumentRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly path: string;
  readonly title: string;
  readonly sortOrder: number;
  readonly restricted: boolean;
  readonly currentRevisionNo: number;
  readonly editingBy: string | null;
  readonly editingName: string | null;
  readonly editingUntil: Date | null;
  readonly updatedAt: Date;
}

export interface RevisionRecord {
  readonly documentId: string;
  readonly no: number;
  readonly markdown: string;
  readonly sha256: string;
  readonly visibleText: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorKind: PrincipalKind;
  readonly channel: string;
  readonly onBehalfOf: string | null;
  readonly proposalId: string | null;
  readonly ingestJobId: string | null;
  readonly changeSetId: string | null;
  readonly message: string;
  readonly createdAt: Date;
}

export interface CommentRecord {
  readonly id: string;
  readonly threadId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly authorKind: PrincipalKind;
  readonly channel: string;
  readonly body: string;
  readonly mentions: readonly Mention[];
  readonly createdAt: Date;
  readonly editedAt: Date | null;
  readonly reactions?: readonly CommentReaction[];
}

export interface CommentReaction {
  readonly emoji: string;
  readonly count: number;
  /** Whether the person reading has this reaction on. */
  readonly mine: boolean;
}

export interface Mention {
  readonly id: string;
  readonly name: string;
}

export interface ThreadRecord {
  readonly id: string;
  readonly documentId: string;
  readonly anchor: Anchor;
  readonly anchorState: AnchorState;
  readonly anchoredRevisionNo: number;
  readonly status: "open" | "resolved";
  readonly summary: string | null;
  readonly summaryAt: Date | null;
  readonly createdBy: string;
  readonly createdName: string;
  readonly createdKind: PrincipalKind;
  readonly resolvedName: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProposalRecord {
  readonly id: string;
  readonly documentId: string;
  readonly baseRevisionNo: number;
  readonly ops: readonly EditOp[];
  readonly rationale: string;
  readonly threadIds: readonly string[];
  readonly authorId: string;
  readonly authorName: string;
  readonly authorKind: PrincipalKind;
  readonly onBehalfOf: string | null;
  readonly channel: string;
  readonly status: "pending" | "accepted" | "rejected";
  readonly decidedName: string | null;
  readonly decidedAt: Date | null;
  readonly decisionNote: string | null;
  readonly acceptedOps: readonly number[] | null;
  readonly appliedRevisionNo: number | null;
  readonly createdAt: Date;
}

export interface AssetRecord {
  readonly spaceId: string;
  readonly sha256: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly filename: string;
}

export type PersistMode = "publish" | "draft" | "proposal";
export type IngestStatus = "queued" | "running" | "retry_wait" | "succeeded" | "failed" | "discarded";

export interface IngestTarget {
  readonly documentId?: string | undefined;
  readonly parentPath?: string | undefined;
  readonly slug?: string | undefined;
  readonly title?: string | undefined;
  readonly sortOrder?: number | undefined;
  readonly restricted?: boolean | undefined;
}

export interface IngestReport {
  readonly processors?: readonly { readonly name: string; readonly detail?: string }[];
  readonly warnings?: readonly string[];
  readonly diagnostics?: readonly { readonly severity: string; readonly code: string; readonly message: string; readonly line?: number }[];
  readonly stats?: Readonly<Record<string, number>>;
}

export interface IngestJobRecord {
  readonly id: string;
  readonly spaceId: string;
  /** What the job reports is for the person who started it, whenever it runs. */
  readonly language: Language;
  readonly target: IngestTarget;
  readonly channel: string;
  readonly contentType: string;
  readonly filename: string;
  readonly sourceAssetSha: string | null;
  readonly sourceText: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly route: string;
  readonly processors: readonly string[];
  readonly persist: PersistMode;
  readonly status: IngestStatus;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly report: IngestReport;
  readonly draftMarkdown: string | null;
  readonly draftTitle: string | null;
  readonly documentId: string | null;
  readonly revisionNo: number | null;
  readonly proposalId: string | null;
  readonly createdBy: string;
  readonly createdName: string;
  readonly createdKind: PrincipalKind;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
