import * as React from "react";
import { Sparkles } from "lucide-react";
import { app } from "../data/runtime-data";
import { askToSignIn, isVisitor } from "../theme/sign-in";
import { t } from "../i18n";
import { toggleAsk, useAsk } from "./store";

const AskPanel = React.lazy(() => import("./ask-panel"));

/** For those who can use it, which is settled by the site and who they are, and for visitors who could by signing in. */
export function AskButton() {
  const { open } = useAsk();
  const { ai } = app.bootstrap;
  if (!ai?.ask) {
    // Where the site has a model but asking takes a login, a visitor sees it is there and can sign in for it.
    if (!ai?.configured || !isVisitor()) return null;
    return (
      <button
        type="button"
        className="pd-ask-button"
        aria-label={t("Ask AI")}
        onClick={() => askToSignIn({ reason: t("Sign in to ask the AI about these documents.") })}
      >
        <Sparkles size={15} aria-hidden="true" />
        <span>{t("Ask AI")}</span>
      </button>
    );
  }
  return (
    <button type="button" className="pd-ask-button" aria-label={t("Ask AI")} aria-pressed={open} onClick={toggleAsk}>
      <Sparkles size={15} aria-hidden="true" />
      <span>{t("Ask AI")}</span>
    </button>
  );
}

/** The panel and all it brings along load the first time someone opens it. */
export function AskHost() {
  const { open } = useAsk();
  return open ? (
    <React.Suspense fallback={null}>
      <AskPanel />
    </React.Suspense>
  ) : null;
}
