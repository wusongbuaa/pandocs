import { Copy, FilePenLine, Link2, MessageSquarePlus } from "lucide-react";
import copy from "copy-to-clipboard";
import { Sparkles } from "lucide-react";
import { app } from "../data/runtime-data";
import { registerSelectionAction, type SelectionContext } from "../theme/slots";
import { atLeast } from "../types";
import { toast } from "../ui/toast";
import { buildTextMap } from "../reader/text-map";
import type { AssistAction } from "./assist-card";
import { runHostAction } from "./host-actions";
import { startComment } from "./store";
import { askToSignIn, isVisitor } from "../theme/sign-in";
import { t } from "../i18n";

const canComment = ({ page }: SelectionContext) => atLeast(page.view.role, "commenter");

/** A link that finds the same words again, which keeps working when the text around them moves. */
export function selectionUrl(context: SelectionContext, root: Element): string {
  const quote = context.selection.exact.replace(/\s+/gu, "").slice(0, 200);
  const whole = buildTextMap(root).segments.map(segment => segment.node.nodeValue ?? "").join("").replace(/\s+/gu, "");
  let occurrence = 1;
  for (let at = whole.indexOf(quote); at !== -1 && at < context.selection.start; at = whole.indexOf(quote, at + 1)) occurrence += 1;
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("q", quote);
  if (occurrence > 1) url.searchParams.set("n", String(occurrence - 1));
  return url.toString();
}

const ASSIST_ITEMS: readonly { readonly id: AssistAction; readonly label: string }[] = [
  { id: "explain", label: t("Explain") },
  { id: "rewrite", label: t("Rewrite") },
  { id: "translate", label: t("Translate") },
  { id: "summarize", label: t("Summarize") }
];

export function registerBuiltinSelectionActions(openSuggestion: (context: SelectionContext) => void, openAssist: (context: SelectionContext, action: AssistAction) => void): void {
  registerSelectionAction({
    id: "comment",
    label: t("Comment"),
    icon: MessageSquarePlus,
    display: "label",
    group: 1,
    // A visitor sees it too, and signing in brings them back to the same words.
    available: context => canComment(context) || isVisitor(),
    run(context) {
      const root = document.querySelector("[data-pandocs-body]");
      if (isVisitor() && root) {
        const { pathname, search } = new URL(selectionUrl(context, root));
        askToSignIn({ reason: t("Sign in to comment on what you selected."), next: `${pathname}${search}` });
        context.clear();
        return;
      }
      const { selection, page } = context;
      startComment({ kind: "text", start: selection.start, end: selection.end, exact: selection.exact, revision: page.view.revision.no });
      context.clear();
    }
  });
  registerSelectionAction({
    id: "suggest",
    label: t("Suggest changes"),
    icon: FilePenLine,
    display: "label",
    group: 1,
    available: canComment,
    run: openSuggestion
  });
  registerSelectionAction({
    id: "ai",
    label: t("AI"),
    icon: Sparkles,
    display: "label",
    group: 2,
    // The usage ledger needs a person to attribute the call to; agents bring their own models.
    available: () => Boolean(app.bootstrap.ai?.configured) && app.bootstrap.me.kind === "user" && !app.bootstrap.me.anonymous,
    items: ASSIST_ITEMS.map(item => ({ ...item, run: context => openAssist(context, item.id) }))
  });
  registerSelectionAction({
    id: "copy",
    label: t("Copy"),
    icon: Copy,
    display: "icon",
    group: 3,
    run(context) {
      copy(context.selection.exact);
      toast(t("Copied"));
    }
  });
  registerSelectionAction({
    id: "copy-link",
    label: t("Copy link"),
    icon: Link2,
    display: "icon",
    group: 3,
    run(context) {
      const root = document.querySelector("[data-pandocs-body]");
      if (!root) return;
      copy(selectionUrl(context, root));
      toast(t("Link copied. It opens at this text."));
    }
  });
  for (const action of app.bootstrap.site.actions) {
    registerSelectionAction({
      id: `host:${action.id}`,
      label: action.label,
      icon: Sparkles,
      display: "more",
      group: 4,
      run: context => runHostAction(action, { url: location.href, title: context.page.view.document.title, text: context.selection.exact })
    });
  }
}
