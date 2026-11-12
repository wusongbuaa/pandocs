import * as React from "react";
import type { Mention } from "./composer";
import { api } from "../api/client";
import type { CommentView, ProposalSummary, ThreadView } from "../types";

export type PendingAnchor =
  | { readonly kind: "text"; readonly start: number; readonly end: number; readonly exact: string; readonly revision: number }
  | { readonly kind: "block"; readonly ref: string; readonly preview: string; readonly revision: number }
  /** From the editor, which has no reading offsets: the server finds these words in the saved version. */
  | { readonly kind: "quote"; readonly quote: string };

interface AnnotationState {
  readonly documentId: string | null;
  readonly threads: readonly ThreadView[];
  readonly proposals: readonly ProposalSummary[];
  readonly open: boolean;
  readonly activeId: string | null;
  readonly pending: PendingAnchor | null;
  readonly showResolved: boolean;
  readonly panelTab: "threads" | "proposals";
}

const EMPTY: AnnotationState = { documentId: null, threads: [], proposals: [], open: false, activeId: null, pending: null, showResolved: false, panelTab: "threads" };

let state = EMPTY;
const listeners = new Set<() => void>();

function update(patch: Partial<AnnotationState>): void {
  state = { ...state, ...patch };
  listeners.forEach(listener => listener());
}

export function useAnnotations(): AnnotationState {
  return React.useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state, () => EMPTY);
}

const fetchThreads = (documentId: string) => api.get<ThreadView[]>(`documents/${documentId}/threads`);
const fetchProposals = (documentId: string) => api.get<ProposalSummary[]>(`documents/${documentId}/proposals`);

/** Discussions belong to one document, so moving to another starts over. */
export async function openDocument(documentId: string, target: { readonly threadId?: string | null } = {}): Promise<void> {
  state = { ...EMPTY, open: Boolean(target.threadId), activeId: target.threadId ?? null, documentId };
  listeners.forEach(listener => listener());
  const [threads, proposals] = await Promise.all([fetchThreads(documentId), fetchProposals(documentId)]);
  if (state.documentId === documentId) update({ threads, proposals });
}

export async function refreshProposals(): Promise<void> {
  const { documentId } = state;
  if (!documentId) return;
  const proposals = await fetchProposals(documentId);
  if (state.documentId === documentId) update({ proposals });
}

export async function refreshThreads(): Promise<void> {
  const { documentId } = state;
  if (!documentId) return;
  const threads = await fetchThreads(documentId);
  if (state.documentId === documentId) update({ threads });
}

export const closeDocument = () => update(EMPTY);
export const openPanel = (tab: AnnotationState["panelTab"] = "threads") => update({ open: true, panelTab: tab });
export const closePanel = () => update({ open: false, activeId: null, pending: null });
export const setPanelTab = (panelTab: AnnotationState["panelTab"]) => update({ panelTab });
export const setShowResolved = (showResolved: boolean) => update({ showResolved });
export const activateThread = (activeId: string | null) => update({ activeId, open: activeId ? true : state.open, panelTab: "threads", showResolved: state.threads.find(thread => thread.id === activeId)?.status === "resolved" });
export const startComment = (pending: PendingAnchor) => update({ pending, open: true, activeId: null, panelTab: "threads", showResolved: false });
export const startCommentOnQuote = (quote: string) => startComment({ kind: "quote", quote: quote.replace(/\s+/gu, " ").trim() });
export const cancelComment = () => update({ pending: null });

export async function submitComment(body: string, mentions: readonly Mention[]): Promise<void> {
  const { documentId, pending } = state;
  if (!documentId || !pending) return;
  const anchor = pending.kind === "block" ? { kind: "block", ref: pending.ref, revision: pending.revision } : pending;
  const thread = await api.send<ThreadView>("POST", `documents/${documentId}/threads`, { body: { anchor, body, mentions } });
  update({ pending: null, activeId: thread.id });
  await refreshThreads();
}

export async function submitDocumentComment(body: string, mentions: readonly Mention[]): Promise<void> {
  const { documentId } = state;
  if (!documentId) return;
  await api.send("POST", `documents/${documentId}/threads`, { body: { anchor: { kind: "document" }, body, mentions } });
  await refreshThreads();
}

export async function replyToThread(threadId: string, body: string, mentions: readonly Mention[]): Promise<void> {
  await api.send<CommentView>("POST", `threads/${threadId}/comments`, { body: { body, mentions } });
  await refreshThreads();
}

export async function setThreadStatus(threadId: string, status: "open" | "resolved"): Promise<void> {
  await api.send("POST", `threads/${threadId}/${status === "resolved" ? "resolve" : "reopen"}`);
  if (status === "resolved" && state.activeId === threadId) update({ activeId: null });
  await refreshThreads();
}

export async function editComment(commentId: string, body: string, mentions: readonly Mention[]): Promise<void> {
  await api.send("PATCH", `comments/${commentId}`, { body: { body, mentions } });
  await refreshThreads();
}

export async function deleteComment(commentId: string): Promise<void> {
  await api.send("DELETE", `comments/${commentId}`);
  await refreshThreads();
}

export async function reactToComment(commentId: string, emoji: string, active: boolean): Promise<void> {
  await api.send("POST", `comments/${commentId}/reactions`, { body: { emoji, active } });
  await refreshThreads();
}
