import * as React from "react";
import copy from "copy-to-clipboard";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Replace, FileCode2, Redo2, Undo2 } from "lucide-react";
import { useNavigate } from "@rspress/core/runtime";
import {
  defaultBlockRegistry,
  joinFrontMatter,
  mergeThreeWay,
  opsBetweenMarkdown,
  parseDocument,
  splitFrontMatter,
  type Diagnostic
} from "@pandocs/markdown";
import { Button } from "@/components/ui/button";
import { Tip } from "../ui/tooltip";
import { SelectField, TextField, TextareaField } from "../ui/form";
import { api, ApiError, failureMessage, onSessionExpired } from "../api/client";
import { app } from "../data/runtime-data";
import { setEditorShown } from "../data/editor-shown";
import type { ChangeSetSummary } from "../types";
import { assetSource } from "../markdown/block-parts";
import { ReaderContextProvider } from "../markdown/reader-context";
import { AssistCard, type AssistAction } from "../annotations/assist-card";
import { Avatar } from "../ui/avatar";
import { startCommentOnQuote } from "../annotations/store";
import { invalidatePages, type PandocsPage } from "../data/pages";
import { documentRoute, pageUrl } from "../data/paths";
import { ProblemsMenu } from "../review/doc-notices";
import { confirm } from "../ui/confirm";
import { Dialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { BlockHandle } from "./block-handle";
import { ImageTools } from "./image-tools";
import { slashItems } from "./commands";
import {
  createDialectExtensions,
  createDialectMarked,
  createMarkdownExtension,
  LIVE_FIELD,
  readerHeadingsOf
} from "@pandocs/editor-model";
import {
  deleteServerDraft,
  forgetLocalDraft,
  keepLocalDraft,
  saveServerDraft,
  type DraftContent,
  type StoredDraft
} from "./drafts";
import type { LiveSession } from "./live-session";
import { dialectViews } from "./node-views";
import { SelectionBubble } from "./selection-bubble";
import { createSlash, SlashPopup } from "./slash-menu";
import { TableTools } from "./table-tools";
import { uploadAsset } from "./upload";
import { createWriteBack, replaceChangedBlocks, type WriteBack } from "./write-back";
import { t } from "../i18n";

const HEARTBEAT_MS = 45_000;
const AUTOSAVE_MS = 1500;
const LIVE_CHECK_MS = 400;

export interface DocumentEditorProps {
  readonly page: PandocsPage;
  /** Editors save directly; everyone else submits a suggestion for an editor to confirm. A translation saves on its own. */
  readonly mode: "edit" | "propose" | "translate";
  /** The translation being written; empty for the page itself. */
  readonly lang: string;
  /** What the editor opens with: the current version, or a draft restored on top of an older one. */
  readonly markdown: string;
  readonly baseRevision: number;
  readonly route: string;
  /** Set when this opened on a draft, which differs from what is published before anything is typed. */
  readonly resumed?: { readonly draft: StoredDraft; readonly local: boolean } | undefined;
  /** The draft this page's editors share, in which case `markdown` is the version it has caught up with. */
  readonly live?: LiveSession | undefined;
}

const CARET_COLORS = ["#8957e5", "#079c70", "#0095ff", "#d9730d", "#e03e6e", "#0f9fa8"];

/** Where each person is typing in a shared draft, in colours far enough apart to tell people by. */
function caretColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return CARET_COLORS[Math.abs(hash) % CARET_COLORS.length]!;
}

type DraftStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: string }
  | { readonly kind: "failed" };

const SAVED_AS_DRAFT = t("Your changes are saved as a draft. Pick up next time you open this page.");

const NEW_CHANGE_SET = "new";

interface Colleague {
  readonly id: string;
  readonly name: string;
}

/** Who else is in the draft right now, each once however many tabs they have open. */
function useColleagues(live: LiveSession | undefined): readonly Colleague[] {
  const [colleagues, setColleagues] = React.useState<readonly Colleague[]>([]);
  React.useEffect(() => {
    const awareness = live?.provider.awareness;
    if (!awareness) return undefined;
    const read = () => {
      const found = new Map<string, Colleague>();
      for (const [client, state] of awareness.getStates()) {
        const user = (state as { user?: { id?: string; name?: string } }).user;
        if (client !== awareness.clientID && user?.id && user.name && user.id !== app.bootstrap.me.id)
          found.set(user.id, { id: user.id, name: user.name });
      }
      // Someone moving their cursor changes this too, and the same people need not draw the toolbar again.
      const next = [...found.values()];
      setColleagues(previous =>
        previous.length === next.length &&
        previous.every((colleague, at) => colleague.id === next[at]!.id && colleague.name === next[at]!.name)
          ? previous
          : next
      );
    };
    read();
    awareness.on("change", read);
    return () => awareness.off("change", read);
  }, [live]);
  return colleagues;
}

/** What a change goes in as, when it is not being saved straight away: a suggestion on this page, or part of a change set. */
function ChangeSetChoice({
  space,
  value,
  onChange,
  allowSuggestion
}: {
  space: string;
  value: string;
  onChange: (value: string) => void;
  allowSuggestion: boolean;
}) {
  const open = useLoaded(() => api.get<ChangeSetSummary[]>(`spaces/${space}/change-sets?status=open`), [space]);
  const me = app.bootstrap.me.id;
  const yours = (open.status === "ready" ? open.data : []).filter(item => item.authorId === me);
  return (
    <SelectField
      label={t("Send it as")}
      value={value}
      onChange={onChange}
      choices={[
        ...(allowSuggestion ? [{ value: "", label: t("A suggestion on this page") }] : []),
        { value: NEW_CHANGE_SET, label: t("A new change set") },
        ...yours.map(item => ({ value: item.id, label: t('Add to "{0}"', item.title) }))
      ]}
    />
  );
}

export function DocumentEditor({
  page,
  mode,
  lang,
  markdown,
  baseRevision,
  route,
  resumed,
  live
}: DocumentEditorProps) {
  const navigate = useNavigate();
  const documentId = page.entry.id;
  const space = page.space.slug;
  const registry = defaultBlockRegistry;
  const { frontMatter, body } = React.useMemo(() => splitFrontMatter(markdown), [markdown]);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const apiDocumentInput = React.useRef<HTMLInputElement>(null);
  const readerContext = React.useMemo(
    () => ({ space: page.space, currentPath: page.entry.path, routePrefix: "", children: [] }),
    [page.entry.path, page.space]
  );
  const [marked] = React.useState(createDialectMarked);
  const [slash] = React.useState(() =>
    createSlash(() =>
      slashItems(
        () => imageInput.current?.click(),
        () => apiDocumentInput.current?.click()
      )
    )
  );
  const [extensions] = React.useState(() => [
    ...createDialectExtensions({
      registry,
      views: dialectViews,
      assetSource: src => assetSource(space, src),
      placeholder: Placeholder.configure({ placeholder: t("Type here, or type / to insert a block") }),
      readerHeadings: readerHeadingsOf(marked, body, page.entry.title),
      collaborative: Boolean(live)
    }),
    slash.extension,
    createMarkdownExtension(marked),
    ...(live
      ? [
          Collaboration.configure({ document: live.doc, field: LIVE_FIELD }),
          CollaborationCaret.configure({
            provider: live.provider,
            user: {
              id: app.bootstrap.me.id,
              name: app.bootstrap.me.displayName,
              color: caretColor(app.bootstrap.me.id)
            }
          })
        ]
      : [])
  ]);
  const [dirty, setDirty] = React.useState(Boolean(resumed));
  const [busy, setBusy] = React.useState(false);
  const [draft, setDraft] = React.useState<DraftStatus>({ kind: "idle" });
  const [conflict, setConflict] = React.useState<string | null>(null);
  const [proposing, setProposing] = React.useState<string | null>(null);
  const [rationale, setRationale] = React.useState("");
  const reviewOnly = page.space.mergeRules?.requireChangeSets === true;
  const [reviewTarget, setReviewTarget] = React.useState(reviewOnly ? NEW_CHANGE_SET : "");
  const [changeSetTitle, setChangeSetTitle] = React.useState(page.entry.title);
  const [title, setTitle] = React.useState(
    String(live?.meta.get("titleDraft") ?? "") ||
      resumed?.draft.title ||
      (lang && page.entry.titles?.[lang]) ||
      page.entry.title
  );
  const titleNow = React.useRef(title);
  titleNow.current = title;
  /** The version a shared draft has caught up with, which is what saving it is compared with. */
  const base = React.useRef({ no: baseRevision, markdown });
  const colleagues = useColleagues(live);
  const [connected, setConnected] = React.useState(true);
  const [unsynced, setUnsynced] = React.useState(false);
  const liveCheck = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** What the Markdown source was when someone opened it, so that what others did meanwhile can be merged in on the way back. */
  const sourceWas = React.useRef("");
  const [problems, setProblems] = React.useState<readonly Diagnostic[]>(
    () => parseDocument(markdown, registry).diagnostics
  );
  /** The whole Markdown while someone is editing it directly. The editor keeps its state underneath and catches up on the way back. */
  const [source, setSource] = React.useState<string | null>(null);
  const sourceNow = React.useRef<string | null>(null);
  const sourceBox = React.useRef<HTMLTextAreaElement>(null);
  const frontMatterNow = React.useRef(frontMatter);
  const [assist, setAssist] = React.useState<{
    readonly action: AssistAction;
    readonly quote: string;
    readonly from: number;
    readonly to: number;
    readonly rect: DOMRect;
  } | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const [sessionLost, setSessionLost] = React.useState(false);
  const writeBack = React.useRef<WriteBack | null>(null);
  const saveRef = React.useRef<() => void>(() => undefined);
  const autosave = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Changed since opening, so leaving is worth asking about. */
  const touched = React.useRef(false);
  /** Has changes the server's draft does not have yet. */
  const unsaved = React.useRef(false);
  /** Counts them, so a save that comes back can tell whether it covered everything. */
  const changes = React.useRef(0);
  /** Saved or thrown away: there is nothing left to keep. */
  const finished = React.useRef(false);

  const editedMarkdown = () =>
    writeBack.current ? joinFrontMatter(frontMatterNow.current, writeBack.current.markdown()) : markdown;
  const currentMarkdown = () => sourceNow.current ?? editedMarkdown();

  /** In a shared draft, anyone can change what there is to save, and anyone can save it. */
  const checkLive = () => {
    clearTimeout(liveCheck.current);
    liveCheck.current = setTimeout(() => {
      setDirty(
        currentMarkdown().trimEnd() !== base.current.markdown.trimEnd() || titleNow.current.trim() !== page.entry.title
      );
      setProblems(parseDocument(currentMarkdown(), registry).diagnostics);
    }, LIVE_CHECK_MS);
  };

  // The timers and listeners below outlive the render that set them up, and need the title as it is now.
  const draftContent = React.useRef<() => DraftContent>(() => ({ markdown, baseRevision }));
  draftContent.current = () => ({
    markdown: currentMarkdown(),
    baseRevision,
    ...(mode === "propose" ? {} : { title })
  });

  const flushDraft = React.useCallback(async (): Promise<boolean> => {
    clearTimeout(autosave.current);
    const content = draftContent.current();
    const sent = changes.current;
    setProblems(parseDocument(content.markdown, registry).diagnostics);
    setDraft({ kind: "saving" });
    try {
      const saved = await saveServerDraft(documentId, lang, content);
      if (changes.current === sent) {
        unsaved.current = false;
        forgetLocalDraft(documentId, lang);
      }
      setDraft({ kind: "saved", at: saved.updatedAt });
      return true;
    } catch {
      if (!finished.current) keepLocalDraft(documentId, lang, content);
      setDraft({ kind: "failed" });
      return false;
    }
  }, [documentId, lang, registry]);

  const scheduleDraft = () => {
    unsaved.current = true;
    changes.current += 1;
    clearTimeout(autosave.current);
    autosave.current = setTimeout(() => void flushDraft(), AUTOSAVE_MS);
  };

  const markChanged = () => {
    touched.current = true;
    if (live) {
      checkLive();
      return;
    }
    setDirty(true);
    scheduleDraft();
  };

  const uploadImage = async (active: Editor, file: File) => {
    try {
      active
        .chain()
        .focus()
        .setImage({ src: await uploadAsset(space, file), alt: file.name.replace(/\.[^.]+$/u, "") })
        .run();
    } catch (error) {
      toast(failureMessage(error, t("Image upload failed")), "error");
    }
  };

  const editor = useEditor(
    {
      extensions,
      ...(live ? {} : { content: body, contentType: "markdown" }),
      immediatelyRender: false,
      editorProps: {
        attributes: { class: "pd-editor__content", "aria-label": t("Page content") },
        handleKeyDown(_view: unknown, event: KeyboardEvent) {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            saveRef.current();
            return true;
          }
          return false;
        },
        handlePaste(_view: unknown, event: ClipboardEvent) {
          const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith("image/"));
          if (!image || !editorRef.current) return false;
          void uploadImage(editorRef.current, image);
          return true;
        },
        handleDrop(_view: unknown, event: DragEvent) {
          const image = [...(event.dataTransfer?.files ?? [])].find(file => file.type.startsWith("image/"));
          if (!image || !editorRef.current) return false;
          event.preventDefault();
          void uploadImage(editorRef.current, image);
          return true;
        }
      },
      onCreate({ editor: created }: { editor: Editor }) {
        writeBack.current = createWriteBack(created, marked, body);
        if (live) checkLive();
      },
      onUpdate() {
        markChanged();
      }
    } as never,
    [extensions]
  );
  const editorRef = React.useRef<Editor | null>(editor);
  editorRef.current = editor;

  // The editor exists from its second render, with its text already in place. Before the browser paints that, the page
  // drops what was being read and takes the editing layout, so the two never show at once and nothing shows blank.
  React.useLayoutEffect(() => {
    if (!editor) return undefined;
    document.documentElement.classList.add("pd-editing");
    setEditorShown(true);
    return () => {
      document.documentElement.classList.remove("pd-editing");
      setEditorShown(false);
    };
  }, [editor]);

  React.useEffect(() => {
    if (mode !== "edit") return undefined;
    const ping = (editing: boolean) =>
      api.send<{ other: { name: string } | null }>("POST", `documents/${documentId}/editing`, { body: { editing } });
    ping(true).then(
      result => {
        if (result.other && !live)
          toast(t("{0} is also editing this page. Changes to different parts merge by themselves.", result.other.name));
      },
      () => undefined
    );
    const timer = setInterval(() => void ping(true).catch(() => undefined), HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      void ping(false).catch(() => undefined);
    };
  }, [documentId, live, mode]);

  // What happens in the draft that is not in the text.
  React.useEffect(() => {
    if (!live) return undefined;
    const { meta, provider } = live;
    let gone = false;
    frontMatterNow.current = String(meta.get("frontMatter") ?? frontMatterNow.current);
    const onMeta = (event: {
      readonly keysChanged: ReadonlySet<string>;
      readonly transaction: { readonly local: boolean };
    }) => {
      if (event.keysChanged.has("frontMatter")) frontMatterNow.current = String(meta.get("frontMatter") ?? "");
      if (event.keysChanged.has("titleDraft") && !event.transaction.local) {
        titleNow.current = String(meta.get("titleDraft") ?? "") || page.entry.title;
        setTitle(titleNow.current);
        checkLive();
      }
      if (event.keysChanged.has("discardedBy") && meta.get("discardedBy") && !event.transaction.local)
        toast(t("{0} discarded the unsaved changes", String(meta.get("discardedBy"))));
      const no = Number(meta.get("baseRevision"));
      // A draft that says nothing usable about its version leaves things as they are rather than asking for version NaN.
      if (event.keysChanged.has("baseRevision") && Number.isInteger(no) && no > 0) {
        api.get<{ markdown: string }>(`documents/${documentId}/revisions/${no}`).then(
          revision => {
            if (gone) return;
            base.current = { no, markdown: revision.markdown };
            if (editorRef.current)
              writeBack.current = createWriteBack(editorRef.current, marked, splitFrontMatter(revision.markdown).body);
            checkLive();
          },
          () => undefined
        );
        if (!finished.current) {
          const by = String(meta.get("savedBy") ?? "");
          if (event.keysChanged.has("conflictAt") && meta.get("conflictAt"))
            toast(
              t(
                "{0} just saved a change to the same place. The draft keeps its text there, so saving replaces theirs. Their version is in the history.",
                by
              ),
              "error"
            );
          else if (by) toast(t("{0} saved a new version, which is now part of this draft", by));
        }
      }
    };
    meta.observe(onMeta as never);
    const onStatus = ({ status }: { status: string }) => setConnected(status === "connected");
    const onUnsynced = () => setUnsynced(provider.hasUnsyncedChanges);
    provider.on("status", onStatus);
    provider.on("unsyncedChanges", onUnsynced);
    const stop = live.onEnded(ending => {
      if (finished.current) return;
      const keep = () => {
        if (provider.hasUnsyncedChanges)
          keepLocalDraft(documentId, lang, { markdown: currentMarkdown(), baseRevision: base.current.no });
      };
      if (ending === "signed-out") {
        keep();
        setSessionLost(true);
      } else if (ending === "stale") {
        keep();
        finished.current = true;
        location.reload();
      } else {
        finished.current = true;
        toast(t("You can no longer edit this page"), "error");
        invalidatePages();
        navigate(route);
      }
    });
    return () => {
      gone = true;
      clearTimeout(liveCheck.current);
      meta.unobserve(onMeta as never);
      provider.off("status", onStatus);
      provider.off("unsyncedChanges", onUnsynced);
      stop();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- what these read is read when they run
  }, [live]);

  // A draft that only exists in this browser goes to the server as soon as there is an editor to read it from.
  const resumedLocally = Boolean(resumed?.local) && Boolean(editor);
  React.useEffect(() => {
    if (resumedLocally) scheduleDraft();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- scheduling is stable in everything it reads
  }, [resumedLocally]);

  // However someone leaves, what they typed stays: the router cannot be stopped from here, so the draft goes first.
  React.useEffect(() => {
    const keepWhatIsLeft = (pageIsGoing: boolean) => {
      const content = draftContent.current();
      keepLocalDraft(documentId, lang, content);
      void saveServerDraft(documentId, lang, content, pageIsGoing).then(
        () => forgetLocalDraft(documentId, lang),
        () => undefined
      );
    };
    // Text in the Markdown source of a shared draft is not in the draft yet, so it is at risk however the rest stands.
    const hasWorkAtRisk = () =>
      ((live ? live.provider.hasUnsyncedChanges : unsaved.current) || sourceChanged()) && !finished.current;
    const onPageHide = () => {
      if (hasWorkAtRisk()) keepWhatIsLeft(true);
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (hasWorkAtRisk()) event.preventDefault();
    };
    const retry = () => {
      if (hasWorkAtRisk()) void flushDraft();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", warn);
    window.addEventListener("online", retry);
    return () => {
      clearTimeout(autosave.current);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("online", retry);
      if (!hasWorkAtRisk()) return;
      keepWhatIsLeft(false);
      toast(SAVED_AS_DRAFT);
    };
  }, [documentId, flushDraft, lang, live]);

  React.useEffect(
    () =>
      onSessionExpired(() => {
        if (finished.current) return;
        if (touched.current) keepLocalDraft(documentId, lang, draftContent.current());
        setSessionLost(true);
      }),
    [documentId, lang]
  );

  const closeOut = () => {
    finished.current = true;
    unsaved.current = false;
    clearTimeout(autosave.current);
    forgetLocalDraft(documentId, lang);
    setDirty(false);
    return live ? Promise.resolve() : deleteServerDraft(documentId, lang).catch(() => undefined);
  };

  const showSource = (next: string | null) => {
    sourceNow.current = next;
    setSource(next);
  };

  /**
   * In a shared draft, the Markdown source is this person's alone until it goes back into the draft, where what others did
   * meanwhile is merged in. Leaving it for the visual editor does that, and so do saving and stopping: otherwise saving
   * would put it in place of what others saved since, and stopping would leave it nowhere. False when the same place changed.
   */
  const foldSource = (): boolean => {
    if (!editor || !live || sourceNow.current === null) return true;
    const merged = mergeThreeWay(sourceWas.current, sourceNow.current, editedMarkdown(), registry);
    if (!merged.ok)
      toast(t("Someone changed the same place while you were in the Markdown source, and your text was kept"), "error");
    const parts = splitFrontMatter(merged.ok ? merged.markdown : merged.keepingOurs);
    frontMatterNow.current = parts.frontMatter;
    live.meta.set("frontMatter", parts.frontMatter);
    replaceChangedBlocks(editor, parts.body);
    showSource(null);
    return merged.ok;
  };
  const sourceChanged = () => sourceNow.current !== null && sourceNow.current !== sourceWas.current;

  const toggleSource = () => {
    if (!editor) return;
    if (source === null) {
      sourceWas.current = currentMarkdown();
      showSource(sourceWas.current);
      requestAnimationFrame(() => sourceBox.current?.focus());
      return;
    }
    if (live) {
      foldSource();
      return;
    }
    const parts = splitFrontMatter(source);
    frontMatterNow.current = parts.frontMatter;
    editor.commands.setContent(parts.body, { contentType: "markdown", emitUpdate: false });
    // What was just typed is the new baseline, so blocks that were not touched keep these exact bytes.
    writeBack.current = createWriteBack(editor, marked, parts.body);
    showSource(null);
  };

  const onSourceKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      saveRef.current();
    } else if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.setRangeText(
        "  ",
        event.currentTarget.selectionStart,
        event.currentTarget.selectionEnd,
        "end"
      );
      showSource(event.currentTarget.value);
      markChanged();
    }
  };

  const openAssist = (action: AssistAction) => {
    if (!editor) return;
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to);
    setAssist({
      action,
      from,
      to,
      quote: editor.state.doc.textBetween(from, to, "\n"),
      rect: new DOMRect(start.left, start.top, Math.max(end.right - start.left, 1), end.bottom - start.top)
    });
  };

  /** The server reads the words from this person's draft, so it has to have the latest. */
  const runAssist = async (action: AssistAction, quote: string) => {
    if (!live && unsaved.current && !(await flushDraft())) throw new Error("draft not saved");
    return api.send<{ text: string }>("POST", `documents/${documentId}/draft/assist${lang ? `?lang=${lang}` : ""}`, {
      body: { action, quote, ...(live ? { markdown: currentMarkdown() } : {}) }
    });
  };

  const replaceSelection = (text: string) => {
    if (!editor || !assist) return;
    if (editor.state.doc.textBetween(assist.from, assist.to, "\n") !== assist.quote) {
      toast(t("The selected text has changed, so nothing was replaced"), "error");
      setAssist(null);
      return;
    }
    editor
      .chain()
      .focus()
      .insertContentAt({ from: assist.from, to: assist.to }, text, { contentType: "markdown" } as never)
      .run();
    setAssist(null);
  };

  const requestExit = () => {
    if (live) {
      if (sourceChanged()) foldSource();
      finished.current = !live.provider.hasUnsyncedChanges;
      if (dirty)
        toast(t("Your changes stay in this page's shared draft, for you or anyone else who can edit it to save."));
      navigate(route);
    } else if (touched.current) {
      setLeaving(true);
    } else {
      navigate(route);
    }
  };

  const discardShared = async () => {
    if (
      !(await confirm({
        title: t("Discard the unsaved changes?"),
        description: t(
          "This takes the shared draft back to the published page, for everyone in it, including what others have typed."
        ),
        action: t("Discard changes"),
        danger: true
      }))
    )
      return;
    try {
      await api.send("DELETE", `documents/${documentId}/live`);
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };

  const keepDraftAndExit = async () => {
    setBusy(true);
    const onServer = await flushDraft();
    // Either way it is safe now, and leaving should not try again.
    finished.current = true;
    toast(onServer ? SAVED_AS_DRAFT : t("Cannot reach the server. The draft stays on this computer for now."));
    navigate(route);
  };

  const discardAndExit = async () => {
    await closeOut();
    navigate(route);
  };

  /** The page reloads into the login flow and comes back here, where the copy in this browser is offered again. */
  const signInAgain = () => {
    finished.current = true;
    location.reload();
  };

  /**
   * Where the page is now. Someone may have moved it while this was open, and the app only has the tree it started
   * with, so the page at its new address, with links read from there, takes loading the app again.
   */
  const routeAt = (path: string) =>
    `${route.slice(0, route.length - documentRoute(page.space.slug, page.entry.path).length)}${documentRoute(page.space.slug, path)}`;

  const finish = async (message: string, path = page.entry.path) => {
    await closeOut();
    invalidatePages();
    toast(message, "success");
    if (path === page.entry.path) navigate(route);
    else location.assign(pageUrl(routeAt(path)));
  };

  const save = async () => {
    if (!editor || busy || !writeBack.current) return;
    // Where the same place changed, the draft now has this person's text there; they look it over and save again.
    if (live && sourceNow.current !== null && !foldSource()) return;
    const next = currentMarkdown();
    if (mode === "translate") {
      setBusy(true);
      try {
        // What this started from, so that a save by someone else meanwhile is merged with rather than undone.
        const started =
          page.translation?.exists && page.translation.updatedAt
            ? {
                base: {
                  updatedAt: page.translation.updatedAt,
                  markdown: page.view.markdown ?? "",
                  title: page.entry.titles?.[lang] ?? ""
                }
              }
            : {};
        await api.send("PUT", `documents/${documentId}/translations/${lang}`, {
          body: { title: title.trim(), markdown: next, sourceRevision: baseRevision, machine: false, ...started }
        });
        await closeOut();
        // Titles in the sidebar come from when the app loaded.
        location.assign(pageUrl(route));
      } catch (error) {
        toast(failureMessage(error, t("Could not save. Try again later.")), "error");
        setBusy(false);
      }
      return;
    }
    if (mode === "propose") {
      if (opsBetweenMarkdown(page.view.markdown ?? "", next, registry).length === 0) {
        toast(t("Nothing changed"));
        return;
      }
      setProposing(next);
      return;
    }
    setBusy(true);
    try {
      const retitled = title.trim() !== page.entry.title;
      const result = await api.send<{ merged: boolean; changed: boolean; document?: { path: string } }>(
        "PUT",
        `documents/${documentId}/content`,
        {
          idempotent: true,
          body: {
            markdown: next,
            expectedRevision: base.current.no,
            merge: true,
            ...(live ? { fromLiveDraft: true } : {}),
            ...(retitled ? { title: title.trim() } : {})
          }
        }
      );
      live?.meta.delete("titleDraft");
      const path = result.document?.path ?? page.entry.path;
      if (retitled) {
        await closeOut();
        // Titles in the sidebar come from when the app loaded.
        location.assign(pageUrl(routeAt(path)));
        return;
      }
      await finish(
        !result.changed
          ? t("Nothing changed")
          : result.merged
            ? t("Saved, and merged with someone else's changes")
            : t("Saved"),
        path
      );
    } catch (error) {
      if (live && error instanceof ApiError && error.code === "MERGE_CONFLICT")
        toast(
          t(
            "Someone has just saved a change to the same place. It is on its way into this draft. Look it over, then save again."
          ),
          "error"
        );
      else if (error instanceof ApiError && error.code === "MERGE_CONFLICT") setConflict(next);
      else toast(failureMessage(error, t("Could not save. Try again later.")), "error");
    } finally {
      setBusy(false);
    }
  };
  saveRef.current = () => void save();

  const submitProposal = async () => {
    if (proposing === null) return;
    setBusy(true);
    try {
      if (reviewTarget) {
        const changeSet =
          reviewTarget === NEW_CHANGE_SET
            ? (
                await api.send<{ id: string }>("POST", `spaces/${space}/change-sets`, {
                  body: { title: changeSetTitle.trim(), description: rationale }
                })
              ).id
            : reviewTarget;
        await api.send("POST", `change-sets/${changeSet}/pages`, {
          body: {
            document: documentId,
            baseRevision: live ? base.current.no : page.view.revision.no,
            markdown: proposing
          }
        });
        // It has moved to the change set. With someone else here, what they are writing stays with them.
        if (live && colleagues.length === 0)
          await api.send("DELETE", `documents/${documentId}/live`).catch(() => undefined);
        await finish(t("Added to the change set."));
        return;
      }
      await api.send("POST", `documents/${documentId}/proposals`, {
        body: {
          baseRevision: page.view.revision.no,
          ops: opsBetweenMarkdown(page.view.markdown ?? "", proposing, registry),
          rationale
        }
      });
      await finish(t("Suggestion sent. Someone with edit access will review it."));
    } catch (error) {
      toast(failureMessage(error, t("Could not send it. Try again later.")), "error");
    } finally {
      setBusy(false);
    }
  };

  // What was being read is still on screen until the next render, when the editor is there to replace it.
  if (!editor) return null;

  const liveStatus =
    connected && !unsynced ? t("Synced") : connected ? t("Syncing…") : t("Not connected. Your changes are kept here.");
  const status = live
    ? liveStatus
    : draft.kind === "saving"
      ? t("Saving draft…")
      : draft.kind === "saved"
        ? t("Draft saved {0}", relativeTime(draft.at))
        : draft.kind === "failed"
          ? t("Draft kept on this computer. It syncs when the connection is back.")
          : dirty
            ? ""
            : mode === "propose"
              ? t("Your changes go in as a suggestion for someone with edit access to review")
              : "";
  return (
    <div className="pd-editor">
      {mode === "propose" ? null : (
        <h1 className="pd-editor__heading">
          <input
            aria-label={t("Title")}
            placeholder={t("Page title")}
            value={title}
            onChange={event => {
              setTitle(event.target.value);
              live?.meta.set("titleDraft", event.target.value);
              markChanged();
            }}
          />
        </h1>
      )}
      <div className="pd-editor__bar">
        {source === null ? (
          <>
            <Tip label={t("Undo")}>
              <button
                type="button"
                className="pd-icon-button"
                aria-label={t("Undo")}
                disabled={!editor.can().undo()}
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().undo().run()}
              >
                <Undo2 size={16} aria-hidden="true" />
              </button>
            </Tip>
            <Tip label={t("Redo")}>
              <button
                type="button"
                className="pd-icon-button"
                aria-label={t("Redo")}
                disabled={!editor.can().redo()}
                onMouseDown={event => event.preventDefault()}
                onClick={() => editor.chain().focus().redo().run()}
              >
                <Redo2 size={16} aria-hidden="true" />
              </button>
            </Tip>
          </>
        ) : null}
        <Tip label={source === null ? t("Edit Markdown source") : t("Back to the visual editor")}>
          <button
            type="button"
            className="pd-icon-button"
            aria-label={t("Markdown source")}
            aria-pressed={source !== null}
            onClick={toggleSource}
          >
            <FileCode2 size={16} aria-hidden="true" />
          </button>
        </Tip>
        {colleagues.length > 0 ? (
          <span className="pd-editor__people" title={colleagues.map(colleague => colleague.name).join(", ")}>
            {colleagues.map(colleague => (
              <Avatar key={colleague.id} id={colleague.id} name={colleague.name} />
            ))}
          </span>
        ) : null}
        <span
          className="pd-editor__status"
          role="status"
          title={
            live
              ? t(
                  "Everyone editing this page shares one draft, and it goes on being there until someone saves or discards it. Readers see the last saved version."
                )
              : undefined
          }
        >
          {status}
        </span>
        {source === null && writeBack.current?.aligned === false ? (
          <span className="pd-editor__status">
            {t("This page has an unusual structure, so saving rewrites its formatting")}
          </span>
        ) : null}
        <ProblemsMenu problems={problems} />
        {live && dirty ? (
          <Button variant="outline" disabled={busy} onClick={() => void discardShared()}>
            {t("Discard changes")}
          </Button>
        ) : null}
        <Button variant="outline" disabled={busy} onClick={requestExit}>
          {t("Stop editing")}
        </Button>
        {mode === "edit" ? (
          <Button
            variant="outline"
            disabled={busy || !dirty}
            onClick={() => {
              setReviewTarget(NEW_CHANGE_SET);
              setProposing(currentMarkdown());
            }}
          >
            {t("Add to a change set")}
          </Button>
        ) : null}
        <Button disabled={busy || !dirty || (mode !== "propose" && !title.trim())} onClick={() => void save()}>
          {mode === "propose" ? t("Send suggestion") : busy ? t("Saving…") : t("Save")}
        </Button>
      </div>
      {source !== null ? (
        <textarea
          ref={sourceBox}
          className="pd-editor__source"
          aria-label={t("Markdown source")}
          spellCheck={false}
          rows={Math.max(24, source.split("\n").length + 2)}
          value={source}
          onChange={event => {
            showSource(event.target.value);
            markChanged();
          }}
          onKeyDown={onSourceKeyDown}
        />
      ) : null}
      <div hidden={source !== null}>
        <ReaderContextProvider value={readerContext}>
          <EditorContent editor={editor} />
        </ReaderContextProvider>
      </div>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        aria-hidden="true"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) void uploadImage(editor, file);
          event.target.value = "";
        }}
      />
      <input
        ref={apiDocumentInput}
        type="file"
        accept=".yaml,.yml,.json"
        hidden
        aria-hidden="true"
        onChange={event => {
          const file = event.target.files?.[0];
          if (file)
            void uploadAsset(space, file).then(
              src => editor.chain().focus().insertContent({ type: "openapi", attrs: { src } }).run(),
              (error: unknown) => toast(failureMessage(error), "error")
            );
          event.target.value = "";
        }}
      />
      {source === null ? (
        <>
          <SelectionBubble editor={editor} onComment={startCommentOnQuote} onAssist={openAssist} />
          <SlashPopup controller={slash.controller} editor={editor} />
          <BlockHandle editor={editor} />
          <TableTools editor={editor} />
          <ImageTools editor={editor} />
        </>
      ) : null}
      {assist ? (
        <AssistCard
          key={`${assist.action}:${assist.from}`}
          rect={assist.rect}
          action={assist.action}
          load={() => runAssist(assist.action, assist.quote)}
          onClose={() => setAssist(null)}
          actions={text =>
            assist.action === "rewrite" || assist.action === "translate" ? (
              <Button onClick={() => replaceSelection(text)}>
                <Replace size={14} aria-hidden="true" />
                {t("Replace selection")}
              </Button>
            ) : null
          }
        />
      ) : null}
      {conflict !== null ? (
        <Dialog
          title={t("Someone changed the same text")}
          description={t(
            "Your changes were not saved, and the draft is still here. Copy your text, then load the latest version and make them again."
          )}
          onClose={() => setConflict(null)}
          footer={
            <>
              <Button
                variant="outline"
                onClick={() => {
                  copy(conflict);
                  toast(t("Copied"), "success");
                }}
              >
                {t("Copy my text")}
              </Button>
              <Button
                onClick={() => {
                  invalidatePages();
                  navigate(route);
                }}
              >
                {t("Load the latest version")}
              </Button>
            </>
          }
        />
      ) : null}
      {leaving ? (
        <Dialog
          title={t("You have unsaved changes")}
          description={t("Keep them as a draft to continue next time, or discard them.")}
          onClose={() => setLeaving(false)}
          footer={
            <>
              <Button variant="outline" disabled={busy} onClick={() => void discardAndExit()}>
                {t("Discard changes")}
              </Button>
              <Button disabled={busy} onClick={() => void keepDraftAndExit()}>
                {t("Keep draft and leave")}
              </Button>
            </>
          }
        />
      ) : null}
      {sessionLost ? (
        <Dialog
          title={t("Your sign-in expired")}
          description={
            touched.current
              ? t("Your changes are kept on this computer. Sign in again to continue.")
              : t("Sign in again to continue.")
          }
          onClose={() => setSessionLost(false)}
          footer={<Button onClick={signInAgain}>{t("Sign in again")}</Button>}
        />
      ) : null}
      {proposing !== null ? (
        <Dialog
          title={t("Send a suggestion")}
          description={t("Say why, to help whoever reviews it.")}
          onClose={() => setProposing(null)}
          footer={
            <Button
              disabled={busy || (reviewTarget === NEW_CHANGE_SET && !changeSetTitle.trim())}
              onClick={() => void submitProposal()}
            >
              {t("Submit")}
            </Button>
          }
        >
          <ChangeSetChoice
            space={space}
            value={reviewTarget}
            onChange={setReviewTarget}
            allowSuggestion={!reviewOnly || (page.space.mergeRules?.requiredApprovals ?? 0) <= 1}
          />
          {reviewTarget === NEW_CHANGE_SET ? (
            <TextField
              label={t("Change set title")}
              maxLength={200}
              value={changeSetTitle}
              onChange={event => setChangeSetTitle(event.target.value)}
            />
          ) : null}
          <TextareaField
            label={t("Why this change (optional)")}
            autoFocus
            rows={3}
            value={rationale}
            onChange={event => setRationale(event.target.value)}
          />
        </Dialog>
      ) : null}
    </div>
  );
}
