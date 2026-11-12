import * as React from "react";
import { flushSync } from "react-dom";
import clsx from "clsx";
import { REVEAL_EVENT } from "./reveal";

export interface DocTab {
  readonly label: React.ReactNode;
  /** What tabs in the same group are matched by: the label's words. */
  readonly value: string;
  readonly content: React.ReactNode;
}

const STORED = "pandocs.tabs.";
const CHOSEN_EVENT = "pandocs:tab-chosen";

function stored(group: string): string | null {
  try {
    return localStorage.getItem(STORED + group);
  } catch {
    return null;
  }
}

function store(group: string, value: string): void {
  try {
    localStorage.setItem(STORED + group, value);
  } catch {
    // Without storage, the tabs on this page still follow each other.
  }
}

/** The words a label shows, to match tabs by. */
export function labelText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(labelText).join("");
  if (React.isValidElement(node)) return labelText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Tabs in a page, in the theme's look. The theme's labels are not buttons, so a keyboard could not reach them, and
 * tabs in a group followed each other by position, so a group whose tabs differ in number or order showed the wrong
 * one. Here the labels are tabs, moved between with the arrow keys, and a group follows by label: one with no such tab
 * stays as it is. A link to something in a tab opens it, and printing shows every pane under its label.
 */
export function DocTabs({ group, tabs }: { readonly group?: string | undefined; readonly tabs: readonly DocTab[] }) {
  const id = React.useId();
  const [chosen, setChosen] = React.useState(0);
  const labels = React.useRef<(HTMLButtonElement | null)[]>([]);
  const panes = React.useRef<(HTMLDivElement | null)[]>([]);
  const values = tabs.map(tab => tab.value);
  const key = values.join("\n");

  const follow = React.useCallback((value: string | null) => {
    const at = value === null ? -1 : key.split("\n").indexOf(value);
    if (at >= 0) setChosen(at);
  }, [key]);

  React.useEffect(() => {
    if (!group) return undefined;
    follow(stored(group));
    const onChosen = (event: Event) => {
      const detail = (event as CustomEvent<{ group: string; value: string }>).detail;
      if (detail.group === group) follow(detail.value);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORED + group) follow(event.newValue);
    };
    window.addEventListener(CHOSEN_EVENT, onChosen);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHOSEN_EVENT, onChosen);
      window.removeEventListener("storage", onStorage);
    };
  }, [group, follow]);

  React.useEffect(() => {
    const onReveal = (event: Event) => {
      const target = (event as CustomEvent<Element>).detail;
      const at = panes.current.findIndex(pane => pane?.contains(target));
      // Shown before whoever asked scrolls to it.
      if (at >= 0) flushSync(() => setChosen(at));
    };
    window.addEventListener(REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_EVENT, onReveal);
  }, []);

  const choose = (at: number) => {
    setChosen(at);
    if (!group) return;
    store(group, values[at]!);
    window.dispatchEvent(new CustomEvent(CHOSEN_EVENT, { detail: { group, value: values[at]! } }));
  };

  const onKeyDown = (event: React.KeyboardEvent, at: number) => {
    const last = tabs.length - 1;
    const next = { ArrowRight: at === last ? 0 : at + 1, ArrowLeft: at === 0 ? last : at - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    choose(next);
    labels.current[next]?.focus();
  };

  return (
    <div className="rp-tabs">
      <div className="rp-tabs__label rp-tabs__label--no-scrollbar" role="tablist">
        {tabs.map((tab, at) => (
          <button
            key={at}
            ref={element => { labels.current[at] = element; }}
            type="button"
            role="tab"
            id={`${id}-tab-${at}`}
            aria-controls={`${id}-pane-${at}`}
            aria-selected={at === chosen}
            tabIndex={at === chosen ? 0 : -1}
            className={clsx("rp-tabs__label__item", at === chosen ? "rp-tabs__label__item--selected" : "rp-tabs__label__item--not-selected")}
            onClick={() => choose(at)}
            onKeyDown={event => onKeyDown(event, at)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="rp-tabs__content">
        {tabs.map((tab, at) => (
          <div
            key={at}
            ref={element => { panes.current[at] = element; }}
            role="tabpanel"
            id={`${id}-pane-${at}`}
            aria-labelledby={`${id}-tab-${at}`}
            hidden={at !== chosen}
            className={clsx("rp-tabs__content__item", at === chosen ? "rp-tabs__content__item--active" : "rp-tabs__content__item--hidden")}
          >
            <div className="pd-tabs__print-label" aria-hidden="true">{tab.label}</div>
            {tab.content}
          </div>
        ))}
      </div>
    </div>
  );
}
