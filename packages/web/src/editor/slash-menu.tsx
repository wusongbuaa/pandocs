import * as React from "react";
import { Extension, type Editor, type Range } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import clsx from "clsx";
import { runSlashItem, type SlashItem } from "./commands";
import { t } from "../i18n";

interface SlashState {
  readonly items: readonly SlashItem[];
  readonly range: Range;
  readonly rect: DOMRect | null;
  readonly index: number;
}

/** The plugin lives outside React; this hands its state to the popup. */
class SlashController {
  state: SlashState | null = null;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.state;
  set(next: SlashState | null) {
    this.state = next;
    this.listeners.forEach(listener => listener());
  }
}

export function createSlash(items: () => readonly SlashItem[]) {
  const controller = new SlashController();
  const fromProps = (props: SuggestionProps<SlashItem>, index: number): SlashState => ({
    items: props.items,
    range: props.range,
    rect: props.clientRect?.() ?? null,
    index
  });
  const extension = Extension.create({
    name: "pandocsSlash",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem, SlashItem>({
          editor: this.editor,
          pluginKey: new PluginKey("pandocsSlash"),
          char: "/",
          // Chinese has no spaces to wait for, so anywhere works, except inside what looks like a link or a path.
          allowedPrefixes: null,
          allow: ({ state, range }) =>
            !/[\w:/.-]/u.test(state.doc.textBetween(Math.max(range.from - 1, 0), range.from, "\n", "\n")),
          items: ({ query }) => {
            const text = query.trim().toLowerCase();
            return items().filter(item => !text || item.label.includes(text) || item.keywords.includes(text));
          },
          command: ({ editor, range, props }) => runSlashItem(editor, range, props),
          render: () => {
            let latest: SuggestionProps<SlashItem> | null = null;
            return {
              onStart: props => {
                latest = props;
                controller.set(fromProps(props, 0));
              },
              onUpdate: props => {
                latest = props;
                controller.set(fromProps(props, 0));
              },
              onExit: () => {
                latest = null;
                controller.set(null);
              },
              onKeyDown: ({ event }) => {
                const state = controller.state;
                if (!state || state.items.length === 0) return false;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  const step = event.key === "ArrowDown" ? 1 : state.items.length - 1;
                  controller.set({ ...state, index: (state.index + step) % state.items.length });
                  return true;
                }
                if (event.key === "Enter") {
                  latest?.command(state.items[state.index]!);
                  return true;
                }
                return false;
              }
            };
          }
        })
      ];
    }
  });
  return { extension, controller };
}

export function SlashPopup({ controller, editor }: { controller: SlashController; editor: Editor }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const list = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    list.current?.querySelector("[aria-selected=true]")?.scrollIntoView({ block: "nearest" });
  }, [state?.index]);
  if (!state?.rect) return null;
  if (state.items.length === 0)
    return (
      <div className="pd-slash pd-slash--empty" style={{ top: state.rect.bottom + 6, left: state.rect.left }}>
        {t("No matching blocks")}
      </div>
    );
  const below = state.rect.bottom + 320 < innerHeight;
  return (
    <div
      ref={list}
      className="pd-slash rp-scrollbar"
      role="listbox"
      aria-label={t("Insert a block")}
      onMouseDown={event => event.preventDefault()}
      style={
        below
          ? { top: state.rect.bottom + 6, left: state.rect.left }
          : { bottom: innerHeight - state.rect.top + 6, left: state.rect.left }
      }
    >
      {state.items.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            key={item.id}
            role="option"
            aria-selected={index === state.index}
            className={clsx("pd-slash__item", index === state.index && "pd-slash__item--active")}
            onClick={() => runSlashItem(editor, state.range, item)}
          >
            <Icon size={16} aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
