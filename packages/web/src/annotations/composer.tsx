import * as React from "react";
import { Tip } from "../ui/tooltip";
import { Popover } from "../ui/popover";
import { AtSign, Smile } from "lucide-react";
import { api, failureMessage } from "../api/client";
import { fromInputMethod } from "../ui/input-method";
import { toast } from "../ui/toast";
import { t } from "../i18n";

export interface Mention {
  readonly id: string;
  readonly name: string;
}

export const EMOJIS = ["👍", "👏", "🎉", "❤️", "😄", "🤔", "👀", "✅"];

export function EmojiPicker({
  label,
  onPick,
  children
}: {
  label: string;
  onPick: (emoji: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tip label={label}>
        <Popover.Trigger className="pd-icon-button pd-icon-button--small" aria-label={label}>
          {children}
        </Popover.Trigger>
      </Tip>
      <Popover.Content className="pd-emoji-picker" side="top" align="start" sideOffset={6}>
        {EMOJIS.map(emoji => (
          <button
            type="button"
            key={emoji}
            className="pd-emoji-picker__item"
            onClick={() => {
              onPick(emoji);
              setOpen(false);
            }}
          >
            {emoji}
          </button>
        ))}
      </Popover.Content>
    </Popover.Root>
  );
}

/** The name being typed after `@`. Chinese has no space before it, and an address like a@b.com is not a mention. */
export function mentionQuery(beforeCaret: string): string | null {
  return /(?:^|[^a-zA-Z0-9._-])@([^\s@]{1,20})$/u.exec(beforeCaret)?.[1] ?? null;
}

export interface ComposerProps {
  readonly placeholder: string;
  readonly submitLabel?: string;
  readonly autoFocus?: boolean;
  readonly initial?: string;
  readonly initialMentions?: readonly Mention[];
  onSubmit(body: string, mentions: readonly Mention[]): Promise<void>;
  onCancel?: (() => void) | undefined;
}

export function Composer({
  placeholder,
  submitLabel = t("Send"),
  autoFocus,
  initial = "",
  initialMentions = [],
  onSubmit,
  onCancel
}: ComposerProps) {
  const [body, setBody] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [mentions, setMentions] = React.useState<readonly Mention[]>(initialMentions);
  const [suggestions, setSuggestions] = React.useState<readonly Mention[]>([]);
  const [highlighted, setHighlighted] = React.useState(0);
  const area = React.useRef<HTMLTextAreaElement>(null);

  const queryAt = () => {
    const element = area.current;
    if (!element) return null;
    return mentionQuery(element.value.slice(0, element.selectionStart));
  };

  React.useEffect(() => {
    const query = queryAt();
    if (!query) {
      setSuggestions([]);
      return undefined;
    }
    let current = true;
    const timer = setTimeout(() => {
      api.get<Mention[]>(`directory?q=${encodeURIComponent(query)}`).then(
        result => {
          if (!current) return;
          setSuggestions(result);
          setHighlighted(0);
        },
        () => {
          if (current) setSuggestions([]);
        }
      );
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [body]);

  const insertAtCaret = (text: string) => {
    const element = area.current;
    if (!element) return;
    const at = element.selectionStart;
    const next = `${body.slice(0, at)}${text}${body.slice(element.selectionEnd)}`;
    setBody(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const pick = (person: Mention) => {
    const element = area.current;
    if (!element) return;
    const caret = element.selectionStart;
    const before = body.slice(0, caret).replace(/@[^\s@]*$/u, `@${person.name} `);
    setBody(`${before}${body.slice(caret)}`);
    setMentions(current => (current.some(item => item.id === person.id) ? current : [...current, person]));
    setSuggestions([]);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      // Someone who was mentioned and then edited out of the text is no longer mentioned.
      await onSubmit(
        text,
        mentions.filter(person => text.includes(`@${person.name}`))
      );
      setBody("");
      setMentions([]);
    } catch (error) {
      toast(failureMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // While an input method is choosing a word, arrows and Enter are its own.
    if (suggestions.length > 0 && !fromInputMethod(event)) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted(
          index => (index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlighted]!);
        return;
      }
      if (event.key === "Escape") {
        event.stopPropagation();
        setSuggestions([]);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="pd-composer" onClick={event => event.stopPropagation()}>
      <div className="pd-composer__field">
        <textarea
          ref={area}
          value={body}
          autoFocus={autoFocus}
          rows={2}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={event => setBody(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {suggestions.length > 0 ? (
          <ul className="pd-mentions" role="listbox" aria-label={t("Mention someone")}>
            {suggestions.map((person, index) => (
              <li key={person.id} role="option" aria-selected={index === highlighted}>
                <button
                  type="button"
                  className={
                    index === highlighted ? "pd-mentions__item pd-mentions__item--active" : "pd-mentions__item"
                  }
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => pick(person)}
                >
                  {person.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="pd-composer__foot">
        <div className="pd-composer__tools">
          <Tip label={t("Mention someone")}>
            <button
              type="button"
              className="pd-icon-button pd-icon-button--small"
              aria-label={t("Mention someone")}
              onClick={() => insertAtCaret("@")}
            >
              <AtSign size={15} aria-hidden="true" />
            </button>
          </Tip>
          <EmojiPicker label={t("Insert emoji")} onPick={insertAtCaret}>
            <Smile size={15} aria-hidden="true" />
          </EmojiPicker>
        </div>
        <div className="pd-composer__actions">
          {onCancel ? (
            <button type="button" className="pd-btn" onClick={onCancel}>
              {t("Cancel")}
            </button>
          ) : null}
          <button
            type="button"
            className="pd-btn pd-btn--primary"
            disabled={!body.trim() || busy}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
