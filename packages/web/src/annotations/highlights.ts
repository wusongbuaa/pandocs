import type { ThreadView } from "../types";
import { revealTarget } from "../markdown/reveal";
import { buildTextMap, rangeFor } from "../reader/text-map";

const THREAD_HIGHLIGHT = "pd-comment";
const ACTIVE_HIGHLIGHT = "pd-comment-active";

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function highlightApi(): { registry: HighlightRegistry; create: (...ranges: Range[]) => unknown } | null {
  const css = globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return css?.highlights && Highlight
    ? { registry: css.highlights, create: (...ranges) => new Highlight(...ranges) }
    : null;
}

export const bodyRoot = () => document.querySelector<HTMLElement>("[data-pandocs-body]");

export function textThreads(threads: readonly ThreadView[]): readonly ThreadView[] {
  return threads.filter(
    thread => thread.status === "open" && thread.anchor.kind === "text" && thread.anchorState !== "orphaned"
  );
}

/**
 * The CSS Custom Highlight API paints without touching the DOM, so React's nodes and the coordinate
 * mapping stay intact. `extra` is text that is active without having a discussion yet.
 */
export function paintHighlights(
  threads: readonly ThreadView[],
  activeId: string | null,
  extra: readonly { readonly start: number; readonly end: number }[]
): void {
  const root = bodyRoot();
  const api = highlightApi();
  if (!root || !api) return;
  const map = buildTextMap(root);
  const ranges = (anchors: readonly { readonly start: number; readonly end: number }[]) =>
    anchors.flatMap(anchor => rangeFor(map, root, anchor.start, anchor.end) ?? []);
  const anchored = textThreads(threads).map(thread => ({
    id: thread.id,
    ...(thread.anchor as { start: number; end: number })
  }));
  api.registry.set(THREAD_HIGHLIGHT, api.create(...ranges(anchored.filter(item => item.id !== activeId))));
  api.registry.set(
    ACTIVE_HIGHLIGHT,
    api.create(...ranges([...anchored.filter(item => item.id === activeId), ...extra]))
  );
}

export function clearHighlights(): void {
  const api = highlightApi();
  api?.registry.delete(THREAD_HIGHLIGHT);
  api?.registry.delete(ACTIVE_HIGHLIGHT);
}

/** How long a prompt takes to open, and a little more, for when its transition never says it has ended. */
const PROMPT_OPENS_MS = 450;

/**
 * Text in a closed tab, prompt or fold takes up no room, so there is nothing to scroll to until it is opened. What it
 * gives settles once all is open: a prompt grows over a moment, and scrolling before that stops at its top.
 */
function openFolded(element: Element): Promise<void> | null {
  const prompts = [...ancestorsOf(element)].filter(at => at.matches(".rp-prompt__content--collapsed"));
  const hidden = element.closest("details:not([open]), .rp-tabs__content__item--hidden") !== null;
  if (prompts.length === 0 && !hidden) return null;
  if (hidden) revealTarget(element);
  for (const prompt of prompts)
    prompt.closest(".rp-prompt")?.querySelector<HTMLElement>(".rp-prompt__action-toggle")?.click();
  return Promise.all(
    prompts.map(
      prompt =>
        new Promise<void>(resolve => {
          const done = (event?: Event) => {
            if (event && event.target !== prompt) return;
            prompt.removeEventListener("transitionend", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, PROMPT_OPENS_MS);
          prompt.addEventListener("transitionend", done);
        })
    )
  ).then(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
}

function* ancestorsOf(element: Element): Generator<Element> {
  for (let at: Element | null = element; at; at = at.parentElement) yield at;
}

export function scrollToAnchor(anchor: { readonly start: number; readonly end: number }): void {
  const root = bodyRoot();
  if (!root) return;
  const element = rangeFor(buildTextMap(root), root, anchor.start, anchor.end)?.startContainer.parentElement;
  if (!element) return;
  const scroll = () => element.scrollIntoView({ block: "center", behavior: "smooth" });
  const opening = openFolded(element);
  if (opening) void opening.then(scroll);
  else scroll();
}
