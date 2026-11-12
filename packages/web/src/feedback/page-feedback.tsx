import * as React from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useSearchParams } from "@rspress/core/runtime";
import { api, failureMessage } from "../api/client";
import { useEditorShown } from "../data/editor-shown";
import { shared } from "../embed/session";
import { useAppPage } from "../markdown/document-body";
import { toast } from "../ui/toast";
import { t } from "../i18n";

const answeredKey = (documentId: string) => `pandocs:feedback:${documentId}`;

/** Storage throws in a frame the browser has cut off from it. Not remembering only means being asked again. */
function remembered(documentId: string): string | null {
  try {
    return localStorage.getItem(answeredKey(documentId));
  } catch {
    return null;
  }
}

function remember(documentId: string, revision: number): void {
  try {
    localStorage.setItem(answeredKey(documentId), String(revision));
  } catch {
    // As above.
  }
}

function Votes({ documentId, revision }: { documentId: string; revision: number }) {
  const [state, setState] = React.useState<"asking" | "explaining" | "thanked">("asking");
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [kind, setKind] = React.useState<"helpful" | "unhelpful">("helpful");
  const [words, setWords] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // In an effect: the server cannot know what this browser remembers. A new version of the page is worth asking about again.
  React.useEffect(() => {
    if (remembered(documentId) === String(revision)) setState("thanked");
  }, [documentId, revision]);

  const vote = async (chosen: "helpful" | "unhelpful") => {
    setBusy(true);
    try {
      const { id } = await api.send<{ id: string }>("POST", `documents/${documentId}/feedback`, {
        body: { kind: chosen }
      });
      remember(documentId, revision);
      setKind(chosen);
      setFeedback(id);
      setState("explaining");
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const explain = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!feedback || !words.trim()) return;
    setBusy(true);
    try {
      await api.send("PATCH", `documents/${documentId}/feedback/${feedback}`, { body: { body: words.trim() } });
      setState("thanked");
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  if (state === "thanked")
    return (
      <p className="pd-page-feedback rp-not-doc" role="status">
        {t("Thanks for telling us.")}
      </p>
    );
  if (state === "explaining") {
    return (
      <form className="pd-page-feedback pd-page-feedback--explaining rp-not-doc" onSubmit={explain}>
        <label htmlFor="pd-page-feedback-words">
          {kind === "helpful" ? t("Thanks. Anything else to say?") : t("Thanks. What was missing or wrong?")}
        </label>
        <textarea
          id="pd-page-feedback-words"
          rows={3}
          maxLength={2000}
          value={words}
          onChange={event => setWords(event.target.value)}
        />
        <div className="pd-page-feedback__foot">
          <button type="button" className="pd-btn" onClick={() => setState("thanked")}>
            {t("Skip")}
          </button>
          <button type="submit" className="pd-btn pd-btn--primary" disabled={busy || !words.trim()}>
            {t("Send")}
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="pd-page-feedback rp-not-doc" role="group" aria-label={t("Was this page helpful?")}>
      <span>{t("Was this page helpful?")}</span>
      <button type="button" className="pd-btn pd-btn--icon" disabled={busy} onClick={() => void vote("helpful")}>
        <ThumbsUp size={14} aria-hidden="true" />
        {t("Yes")}
      </button>
      <button type="button" className="pd-btn pd-btn--icon" disabled={busy} onClick={() => void vote("unhelpful")}>
        <ThumbsDown size={14} aria-hidden="true" />
        {t("No")}
      </button>
    </div>
  );
}

/** At the end of what someone came to read, and not in the tools for a page. */
export function PageFeedback() {
  const page = useAppPage();
  const [params] = useSearchParams();
  const editorShown = useEditorShown();
  // While the editor opens, the page is still the one being read.
  const opening = params.get("mode") === "edit" && !editorShown;
  if (page?.kind !== "document" || (params.get("mode") && !opening) || params.get("view") || shared) return null;
  return <Votes key={page.entry.id} documentId={page.entry.id} revision={page.view.revision.no} />;
}
