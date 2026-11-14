import * as React from "react";
import copy from "copy-to-clipboard";
import { Copy, RotateCw, Send, Square, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { createBlockRegistry } from "@pandocs/markdown";
import { useLocation, usePage } from "@rspress/core/runtime";
import { Link } from "@rspress/core/theme";
import { Tip } from "../ui/tooltip";
import { fromInputMethod } from "../ui/input-method";
import { closePanel, useAnnotations } from "../annotations/store";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import { renderMarkdown, type RenderedMarkdown } from "../markdown/pipeline";
import { toast } from "../ui/toast";
import { t } from "../i18n";
import { CITATION_PREFIX, numberCitations, type AskSource } from "./citations";
import {
  ask,
  clearConversation,
  closeAsk,
  isAsking,
  rateAnswer,
  stopAsking,
  useAsk,
  type AskStep,
  type AskTurn
} from "./store";

/** What a model writes is plain Markdown: none of the blocks that need a page around them. */
const NO_BLOCKS = createBlockRegistry([]);
/** Often enough to read along, without working through the Markdown for every few words. */
const REDRAW_MS = 120;

/** The latest value at most this often. New values keep arriving while it waits, and the wait has to end anyway. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = React.useState(value);
  const latest = React.useRef(value);
  latest.current = value;
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    if (Object.is(shown, value) || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, ms);
  }, [shown, value, ms]);
  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );
  return shown;
}

function Answer({ markdown, citations }: { markdown: string; citations: readonly AskSource[] }) {
  const shown = useThrottled(markdown, REDRAW_MS);
  const [rendered, setRendered] = React.useState<RenderedMarkdown["hast"] | null>(null);
  React.useEffect(() => {
    let current = true;
    void renderMarkdown(shown, { title: "", registry: NO_BLOCKS }).then(result => {
      if (current) setRendered(result.hast);
    });
    return () => {
      current = false;
    };
  }, [shown]);
  const byNumber = React.useMemo(() => new Map(citations.map(citation => [citation.n, citation])), [citations]);
  if (!rendered) return null;
  return toJsxRuntime(rendered, {
    Fragment,
    jsx,
    jsxs,
    ignoreInvalidStyle: true,
    passKeys: true,
    components: {
      // A picture in an answer could carry what it read to anywhere on the internet, just by loading.
      img: () => null,
      a: ({ href, children, ...rest }: React.ComponentProps<"a">) => {
        const citation = href?.startsWith(CITATION_PREFIX)
          ? byNumber.get(Number(href.slice(CITATION_PREFIX.length)))
          : undefined;
        if (citation)
          return (
            <sup className="pd-ask__cite">
              <Link href={citation.url} title={citation.title}>
                {citation.n}
              </Link>
            </sup>
          );
        return (
          <a href={href} {...rest}>
            {children}
          </a>
        );
      }
    } as never
  });
}

function stepText({ kind, label }: AskStep): string {
  if (kind === "search") return t("Searched for “{0}”", label);
  if (kind === "read") return t("Read “{0}”", label);
  return t("Looked through the pages of {0}", label);
}

function TurnView({ turn, onRetry }: { turn: AskTurn; onRetry(question: string): void }) {
  const { markdown, citations } = React.useMemo(() => {
    const known = turn.citations ? new Map(turn.citations.map(citation => [citation.n, citation])) : turn.sources;
    return numberCitations(turn.text, n => known.get(n));
  }, [turn.citations, turn.sources, turn.text]);
  const working = turn.status === "working";
  return (
    <article className="pd-ask__turn">
      <p className="pd-ask__question">{turn.question}</p>
      {turn.steps.length > 0 ? (
        <ul className="pd-ask__steps">
          {turn.steps.map((step, at) => (
            <li key={at}>{stepText(step)}</li>
          ))}
        </ul>
      ) : null}
      {turn.text ? (
        <div className="pd-ask__answer rp-doc" aria-live="polite">
          <Answer markdown={markdown} citations={citations} />
        </div>
      ) : null}
      {working && !turn.text ? <p className="pd-ask__working">{t("Looking through the documents…")}</p> : null}
      {turn.status === "failed" ? <p className="pd-ask__failed">{turn.error}</p> : null}
      {turn.status === "stopped" ? <p className="pd-ask__working">{t("Stopped.")}</p> : null}
      {citations.length > 0 && !working ? (
        <ol className="pd-ask__sources" aria-label={t("Sources")}>
          {citations.map(citation => (
            <li key={citation.n}>
              <Link href={citation.url}>{citation.title}</Link>
            </li>
          ))}
        </ol>
      ) : null}
      {!working ? (
        <div className="pd-ask__actions">
          {turn.text ? (
            <Tip label={t("Copy the answer")}>
              <button
                type="button"
                className="pd-icon-button pd-icon-button--small"
                aria-label={t("Copy the answer")}
                onClick={() => {
                  copy(turn.text.replace(/\s*\[\d{1,3}\](?!\()/gu, ""));
                  toast(t("Copied"));
                }}
              >
                <Copy size={14} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
          <Tip label={t("Ask again")}>
            <button
              type="button"
              className="pd-icon-button pd-icon-button--small"
              aria-label={t("Ask again")}
              onClick={() => onRetry(turn.question)}
            >
              <RotateCw size={14} aria-hidden="true" />
            </button>
          </Tip>
          {turn.answerId ? (
            <>
              <Tip label={t("This helped")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("This helped")}
                  aria-pressed={turn.rating === true}
                  onClick={() => rateAnswer(turn.key, turn.answerId!, true)}
                >
                  <ThumbsUp size={14} aria-hidden="true" />
                </button>
              </Tip>
              <Tip label={t("This did not help")}>
                <button
                  type="button"
                  className="pd-icon-button pd-icon-button--small"
                  aria-label={t("This did not help")}
                  aria-pressed={turn.rating === false}
                  onClick={() => rateAnswer(turn.key, turn.answerId!, false)}
                >
                  <ThumbsDown size={14} aria-hidden="true" />
                </button>
              </Tip>
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** Beside the page rather than over it, like the discussions, so the pages it leads to can be read as it talks about them. */
export default function AskPanel() {
  const { turns } = useAsk();
  const annotations = useAnnotations();
  const { page } = usePage();
  const data = useAppPage();
  const { pathname } = useLocation();
  const [question, setQuestion] = React.useState("");
  const input = React.useRef<HTMLTextAreaElement>(null);
  const end = React.useRef<HTMLDivElement>(null);
  const asking = isAsking(turns);

  // One panel at a time on that side of the page.
  const discussionsOpen = annotations.open;
  React.useEffect(() => {
    if (annotations.open) closePanel();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Only when this opens: after that, opening the discussions closes this.
  }, []);
  const wasOpen = React.useRef(discussionsOpen);
  React.useEffect(() => {
    if (discussionsOpen && !wasOpen.current) closeAsk();
    wasOpen.current = discussionsOpen;
  }, [discussionsOpen]);

  React.useEffect(() => {
    document.documentElement.classList.add("pd-ask-open");
    input.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog]")) closeAsk();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.documentElement.classList.remove("pd-ask-open");
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const lastText = turns.at(-1)?.text.length ?? 0;
  React.useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, lastText]);

  const send = (text: string) => {
    const words = text.trim();
    if (!words || asking) return;
    const first = pathname
      .split("/")
      .filter(Boolean)
      .find(segment => app.bootstrap.spaces.some(space => space.slug === segment));
    void ask(words, {
      lang: page.lang || undefined,
      space: data?.kind === "document" ? data.space.slug : first,
      document: data?.kind === "document" ? data.entry.id : undefined
    });
    setQuestion("");
  };

  return (
    <aside className="pd-panel pd-ask" aria-label={t("Ask AI")}>
      <header className="pd-panel__head">
        <h2>{t("Ask AI")}</h2>
        <div className="pd-panel__head-tools">
          {turns.length > 0 ? (
            <button type="button" className="pd-panel__head-button" onClick={clearConversation}>
              {t("Start over")}
            </button>
          ) : null}
          <button type="button" className="pd-icon-button" aria-label={t("Close")} onClick={closeAsk}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="pd-panel__body pd-ask__body">
        {turns.length === 0 ? (
          <p className="pd-panel__empty">
            {t("Ask about anything in these documents. Answers come from pages you can read, with links to them.")}
          </p>
        ) : null}
        {turns.map(turn => (
          <TurnView key={turn.key} turn={turn} onRetry={send} />
        ))}
        <div ref={end} />
      </div>
      <form
        className="pd-ask__form"
        onSubmit={event => {
          event.preventDefault();
          send(question);
        }}
      >
        <textarea
          ref={input}
          rows={2}
          maxLength={2000}
          value={question}
          placeholder={t("Ask a question")}
          aria-label={t("Ask a question")}
          onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => {
            // Enter also confirms a word being typed with an input method.
            if (event.key === "Enter" && !event.shiftKey && !fromInputMethod(event)) {
              event.preventDefault();
              send(question);
            }
          }}
        />
        {asking ? (
          <button type="button" className="pd-icon-button" aria-label={t("Stop")} onClick={stopAsking}>
            <Square size={14} aria-hidden="true" />
          </button>
        ) : (
          <button type="submit" className="pd-icon-button" aria-label={t("Send")} disabled={!question.trim()}>
            <Send size={14} aria-hidden="true" />
          </button>
        )}
      </form>
      <p className="pd-ask__note">{t("AI can get things wrong. Check the pages it links to.")}</p>
    </aside>
  );
}
