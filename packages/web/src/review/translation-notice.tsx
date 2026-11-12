import * as React from "react";
import { useLocation } from "@rspress/core/runtime";
import { Languages } from "lucide-react";
import { parseDocument, splitFrontMatter, topLevelBlocks } from "@pandocs/markdown";
import { api, ApiError, failureMessage } from "../api/client";
import type { PandocsPage } from "../data/pages";
import { app } from "../data/runtime-data";
import { useAppPage } from "../markdown/document-body";
import type { DocumentView } from "../types";
import { confirm } from "../ui/confirm";
import { toast } from "../ui/toast";
import { t } from "../i18n";

const CHUNK = 2500;
/** Blocks that are data or media rather than sentences stay exactly as they are. */
const UNTRANSLATED = new Set(["code", "math", "mermaid", "chart", "tree", "video", "subpages", "thematicBreak", "image"]);

export interface TranslationStep {
  /** A run of blocks to send to the model, or text to keep as written. */
  readonly from?: string;
  readonly to?: string;
  readonly keep?: string;
}

/** Groups a page into runs small enough for one model call. A block too long for one call stays in the source language. */
export function planTranslation(markdown: string): { steps: readonly TranslationStep[]; tooLong: number } {
  const blocks = topLevelBlocks(parseDocument(markdown));
  const steps: TranslationStep[] = [];
  let tooLong = 0;
  let run: { from: string; to: string; size: number } | null = null;
  const flush = () => {
    if (run) steps.push({ from: run.from, to: run.to });
    run = null;
  };
  for (const block of blocks) {
    const source = markdown.slice(block.start, block.end);
    const size = [...source].length;
    if (UNTRANSLATED.has(block.type) || size > CHUNK) {
      if (size > CHUNK && !UNTRANSLATED.has(block.type)) tooLong += 1;
      flush();
      steps.push({ keep: source });
    } else if (run && (run as { size: number }).size + size <= CHUNK) {
      run = { ...(run as { from: string; size: number }), to: block.ref, size: (run as { size: number }).size + size };
    } else {
      flush();
      run = { from: block.ref, to: block.ref, size };
    }
  }
  flush();
  return { steps, tooLong };
}

function useTranslate(page: PandocsPage) {
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null);
  const lang = page.translation!.lang;
  const translate = async () => {
    try {
      const source = await api.get<DocumentView>(`documents/${page.entry.id}`);
      const markdown = source.markdown ?? "";
      const { steps, tooLong } = planTranslation(markdown);
      const calls = steps.filter(step => step.from).length + 1;
      let done = 0;
      setProgress({ done, total: calls });
      const generate = async (body: object) => {
        const { text } = await api.send<{ text: string }>("POST", `documents/${page.entry.id}/translations/${lang}/generate`, { body });
        done += 1;
        setProgress({ done, total: calls });
        return text;
      };
      const title = await generate({ title: true });
      const parts: string[] = [];
      for (const step of steps) parts.push(step.keep ?? await generate({ from: step.from, to: step.to }));
      const { frontMatter } = splitFrontMatter(markdown);
      await api.send("PUT", `documents/${page.entry.id}/translations/${lang}`, { body: { title: title.trim(), markdown: `${frontMatter ? `${frontMatter.trimEnd()}\n\n` : ""}${parts.join("\n\n")}\n`, sourceRevision: source.revision.no, machine: true } });
      toast(tooLong > 0 ? t("Translated. {0} {0|passage was|passages were} too long and kept the original text.", tooLong) : t("Translated"), "success");
      // Titles in the sidebar come from when the app loaded.
      location.reload();
    } catch (error) {
      setProgress(null);
      toast(error instanceof ApiError ? t("Translation did not finish, and nothing was saved: {0}", error.message) : failureMessage(error), "error");
    }
  };
  return { progress, translate };
}

function NoticeBody({ page }: { page: PandocsPage }) {
  const translation = page.translation!;
  const { pathname } = useLocation();
  const { progress, translate } = useTranslate(page);
  const remove = async () => {
    if (!await confirm({ title: t("Delete this {0} version?", translation.label), description: t("This language then shows the original text. This cannot be undone."), action: t("Delete"), danger: true })) return;
    try {
      await api.send("DELETE", `documents/${page.entry.id}/translations/${translation.lang}`);
      // Titles in the sidebar come from when the app loaded.
      location.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const editHref = `${pathname}?mode=edit`;
  const message = !translation.exists
    ? t("This page has no {0} version yet, so the original text is below.", translation.label)
    : translation.stale
      ? t("The original changed after this was translated, so this {0} version may be out of date.", translation.label)
      : translation.machine ? t("AI translated this version, so it may not be accurate.") : null;
  if (!message && !translation.canEdit) return null;
  return (
    <aside className="pd-translation rp-not-doc" aria-label={t("Translation status")}>
      <Languages size={16} aria-hidden="true" />
      <span>{progress ? t("Translating {0}/{1}…", progress.done, progress.total) : message ?? t("This is the {0} version.", translation.label)}</span>
      {translation.canEdit && !progress ? (
        <span className="pd-translation__actions">
          {app.bootstrap.ai?.configured ? <button type="button" className="pd-btn" onClick={() => void translate()}>{translation.exists ? t("Translate again with AI") : t("AI translation")}</button> : null}
          <a className="pd-btn" href={editHref}>{translation.exists ? t("Edit translation") : t("Translate by hand")}</a>
          {translation.exists ? <button type="button" className="pd-btn" onClick={() => void remove()}>{t("Delete translation")}</button> : null}
        </span>
      ) : null}
    </aside>
  );
}

/** Pages in another language say what they are, and where someone can bring them up to date. */
export function TranslationNotice() {
  const page = useAppPage();
  if (page?.kind !== "document" || !page.translation) return null;
  return <NoticeBody key={page.entry.id} page={page} />;
}
