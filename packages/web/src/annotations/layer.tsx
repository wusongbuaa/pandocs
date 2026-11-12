import * as React from "react";
import { useSearchParams } from "@rspress/core/runtime";
import { anchorFromQuote } from "@pandocs/markdown";
import { FilePenLine } from "lucide-react";
import { api, failureMessage } from "../api/client";
import type { PandocsPage } from "../data/pages";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { atLeast } from "../types";
import { buildTextMap, captureSelection, offsetAt, type CapturedSelection } from "../reader/text-map";
import type { SelectionContext } from "../theme/slots";
import { AssistCard, type AssistAction } from "./assist-card";
import { ConfirmHost } from "../ui/confirm";
import { toast, Toaster } from "../ui/toast";
import { bodyRoot, clearHighlights, paintHighlights, scrollToAnchor, textThreads } from "./highlights";
import { AnnotationPanel } from "./panel";
import { registerBuiltinSelectionActions } from "./selection-actions";
import { SelectionToolbar } from "./selection-toolbar";
import { activateThread, closeDocument, closePanel, openDocument, openPanel, refreshProposals, startComment, useAnnotations } from "./store";
import { suggestionTarget } from "./suggestion-target";
import { t } from "../i18n";

const SuggestDialog = React.lazy(() => import("./suggest-dialog"));
const ProposalDialog = React.lazy(() => import("../review/proposal-dialog"));

interface LiveSelection {
  readonly captured: CapturedSelection;
  readonly range: Range;
}

function blockRefOf(node: Node): string | undefined {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return element?.closest("[data-block-ref]")?.getAttribute("data-block-ref") ?? undefined;
}

function useSelection(): [LiveSelection | null, () => void] {
  const [selection, setSelection] = React.useState<LiveSelection | null>(null);
  const clear = React.useCallback(() => {
    document.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);
  React.useEffect(() => {
    const update = () => requestAnimationFrame(() => {
      const root = bodyRoot();
      const browserSelection = document.getSelection();
      const captured = root ? captureSelection(root, browserSelection) : null;
      setSelection(captured && browserSelection ? { captured, range: browserSelection.getRangeAt(0).cloneRange() } : null);
    });
    // Touch screens select without a mouse-up, and scrolling moves the rectangle the toolbar follows.
    let touchTimer: ReturnType<typeof setTimeout> | undefined;
    const onSelectionChange = () => {
      clearTimeout(touchTimer);
      touchTimer = setTimeout(update, 250);
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", update, { passive: true });
    return () => {
      clearTimeout(touchTimer);
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", update);
    };
  }, []);
  return [selection, clear];
}

function locateQuote(quote: string, occurrence: number): { start: number; end: number } | null {
  const root = bodyRoot();
  if (!root) return null;
  const text = buildTextMap(root).segments.map(segment => segment.node.nodeValue ?? "").join("").replace(/\s+/gu, "");
  try {
    return anchorFromQuote(text, quote, occurrence);
  } catch {
    return null;
  }
}

/** The built-in actions register once; the suggestion they open belongs to whichever page is showing. */
let registered = false;
const openSuggestion: { current: (context: SelectionContext) => void } = { current: () => undefined };
const openAssist: { current: (context: SelectionContext, action: AssistAction) => void } = { current: () => undefined };

function DocumentAnnotations({ page }: { page: PandocsPage }) {
  const { threads, open, activeId, pending } = useAnnotations();
  const [params] = useSearchParams();
  const [selection, clearSelection] = useSelection();
  const [suggesting, setSuggesting] = React.useState<{ context: SelectionContext; draft?: string } | null>(null);
  const [assist, setAssist] = React.useState<{ context: SelectionContext; action: AssistAction } | null>(null);
  const [linked, setLinked] = React.useState<{ start: number; end: number } | null>(null);
  const [proposalId, setProposalId] = React.useState(params.get("proposal"));
  const documentId = page.entry.id;
  const threadParam = params.get("thread");

  // Once the page is on screen, not while drawing it: a render React throws away would leave these pointing nowhere.
  React.useEffect(() => {
    if (!registered) {
      registered = true;
      registerBuiltinSelectionActions(context => openSuggestion.current(context), (context, action) => openAssist.current(context, action));
    }
    const suggest = (context: SelectionContext) => setSuggesting({ context });
    const ask = (context: SelectionContext, action: AssistAction) => {
      setAssist({ context, action });
      context.clear();
    };
    openSuggestion.current = suggest;
    openAssist.current = ask;
    return () => {
      if (openSuggestion.current === suggest) openSuggestion.current = () => undefined;
      if (openAssist.current === ask) openAssist.current = () => undefined;
    };
  }, []);

  React.useEffect(() => {
    // Discussions are for people who are signed in.
    if (app.bootstrap.me.anonymous) return undefined;
    openDocument(documentId, { threadId: threadParam }).catch(error => toast(failureMessage(error), "error"));
    if (params.get("proposal")) openPanel("proposals");
    return () => {
      closeDocument();
      clearHighlights();
    };
    // Only moving to another document starts over; the parameter is read once on arrival.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  React.useEffect(() => {
    const quote = params.get("q");
    const found = quote ? locateQuote(quote, Number(params.get("n") ?? 0) + 1) : null;
    setLinked(found);
    if (found) requestAnimationFrame(() => scrollToAnchor(found));
  }, [params, page.view.revision.no]);

  const pendingText = pending?.kind === "text" ? pending : null;
  const assisted = assist?.context.selection ?? null;
  React.useEffect(() => {
    paintHighlights(threads, activeId, [...(pendingText ? [pendingText] : []), ...(linked ? [linked] : []), ...(assisted ? [assisted] : [])]);
  }, [threads, activeId, pendingText, linked, assisted, page.view.revision.no]);

  // Moving to a discussion moves the page to where it is anchored.
  React.useEffect(() => {
    const thread = threads.find(item => item.id === activeId);
    if (!thread) return;
    if (thread.anchor.kind === "text" && thread.anchorState !== "orphaned") scrollToAnchor(thread.anchor);
    if (thread.anchor.kind === "block") bodyRoot()?.querySelector(`[data-block-ref="${thread.anchor.ref}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  React.useEffect(() => {
    document.documentElement.classList.toggle("pd-panel-open", open);
    return () => document.documentElement.classList.remove("pd-panel-open");
  }, [open]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open && !document.querySelector("[role=dialog]")) closePanel();
    };
    /** A highlight has no element of its own to click. */
    const onClick = (event: MouseEvent) => {
      const root = bodyRoot();
      if (!root || !(event.target instanceof Node) || !root.contains(event.target) || document.getSelection()?.isCollapsed === false) return;
      const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null; caretRangeFromPoint?: (x: number, y: number) => Range | null };
      const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
      const range = position ? null : doc.caretRangeFromPoint?.(event.clientX, event.clientY);
      const node = position?.offsetNode ?? range?.startContainer;
      if (!node || !root.contains(node)) return;
      const at = offsetAt(buildTextMap(root), root, node, position?.offset ?? range?.startOffset ?? 0);
      const hit = textThreads(threads).find(thread => thread.anchor.kind === "text" && at >= thread.anchor.start && at < thread.anchor.end);
      if (hit) activateThread(hit.id);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open, threads]);

  const context: SelectionContext | null = selection && !params.get("mode") && !params.get("view") ? { page, selection: selection.captured, range: selection.range, clear: clearSelection } : null;
  const suggested = suggesting?.context;
  const target = suggested ? suggestionTarget(page, suggested.selection.exact, blockRefOf(suggested.range.startContainer), blockRefOf(suggested.range.endContainer)) : null;
  return (
    <>
      {context?.selection.rect ? <SelectionToolbar rect={context.selection.rect} context={context} /> : null}
      {open ? <AnnotationPanel page={page} onOpenProposal={setProposalId} /> : null}
      {assist ? (
        <AssistCard key={`${assist.action}:${assist.context.selection.start}`} rect={assist.context.selection.rect} action={assist.action} onClose={() => setAssist(null)}
          load={() => api.send<{ text: string }>("POST", `documents/${page.entry.id}/assist`, { body: { action: assist.action, start: assist.context.selection.start, end: assist.context.selection.end, revision: page.view.revision.no } })}
          actions={text => (assist.action === "rewrite" && atLeast(page.view.role, "commenter") ? <button type="button" className="pd-btn pd-btn--primary" onClick={() => { setSuggesting({ context: assist.context, draft: text }); setAssist(null); }}><FilePenLine size={14} aria-hidden="true" />{t("Suggest changes")}</button> : null)} />
      ) : null}
      {target ? <React.Suspense fallback={null}><SuggestDialog page={page} target={target} draft={suggesting?.draft} onSubmitted={() => void refreshProposals()} onClose={() => { setSuggesting(null); clearSelection(); }} /></React.Suspense> : null}
      {proposalId ? <React.Suspense fallback={null}><ProposalDialog proposalId={proposalId} page={page} onClose={() => setProposalId(null)} /></React.Suspense> : null}
    </>
  );
}

/** Everything that floats over the page. It sits in the theme's `bottom` slot and takes no layout of its own. */
export function AnnotationLayer() {
  const page = useAppPage();
  return (
    <>
      {page?.kind === "document" && !page.translation?.exists ? <DocumentAnnotations key={page.entry.id} page={page} /> : null}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

export function commentOnBlock(page: PandocsPage, ref: string): void {
  startComment({ kind: "block", ref, preview: page.view.blocks.find(block => block.ref === ref)?.preview ?? "", revision: page.view.revision.no });
}
