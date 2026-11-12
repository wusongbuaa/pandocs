import * as React from "react";
import { Sparkles } from "lucide-react";
import { api, failureMessage } from "../api/client";
import { useAppPage } from "../markdown/document-body";
import type { ThreadView } from "../types";
import { toast } from "../ui/toast";
import { t } from "../i18n";

const SuggestionDialog = React.lazy(() => import("./suggestion-dialog"));

export interface ThreadSuggestion {
  readonly baseRevision: number;
  readonly firstRef: string;
  readonly lastRef: string;
  readonly source: string;
  readonly text: string;
}

/** What a discussion concluded, as a suggestion someone with edit rights can accept. Accepting it resolves the discussion. */
export function SuggestFromThread({ thread }: { thread: ThreadView }) {
  const page = useAppPage();
  const [busy, setBusy] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<ThreadSuggestion | null>(null);
  if (page?.kind !== "document") return null;
  const generate = async () => {
    setBusy(true);
    try {
      const result = await api.send<ThreadSuggestion>("POST", `threads/${thread.id}/suggestion`);
      if (result.text.trim() === result.source.trim()) toast(t("The discussion asks for no clear change, so AI changed nothing"));
      else setSuggestion(result);
    } catch (error) {
      toast(failureMessage(error, t("Could not generate it. Try again later.")), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="pd-card__action" disabled={busy} onClick={event => { event.stopPropagation(); void generate(); }}>
        <Sparkles size={13} aria-hidden="true" />{busy ? t("Generating…") : t("Suggest a change from this discussion")}
      </button>
      {suggestion ? <React.Suspense fallback={null}><SuggestionDialog page={page} thread={thread} suggestion={suggestion} onClose={() => setSuggestion(null)} /></React.Suspense> : null}
    </>
  );
}
