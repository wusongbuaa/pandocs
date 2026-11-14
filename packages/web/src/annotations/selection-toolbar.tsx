import * as React from "react";
import clsx from "clsx";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { Tip } from "../ui/tooltip";
import { selectionActions, type SelectionAction, type SelectionContext } from "../theme/slots";
import { t } from "../i18n";

const GAP = 8;
const NAV_HEIGHT = 72;

function ActionMenu({
  label,
  trigger,
  items,
  context,
  onDone
}: {
  label: string;
  trigger: React.ReactNode;
  items: readonly { id: string; label: string; hint?: string; run(context: SelectionContext): void }[];
  context: SelectionContext;
  onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <span className="pd-tool-group">
      <button
        type="button"
        className={clsx("pd-tool", open && "pd-tool--open")}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open ? (
        <div className="pd-tool-menu" role="menu">
          {items.map(item => (
            <button
              type="button"
              key={item.id}
              role="menuitem"
              className="pd-tool-menu__item"
              onClick={() => {
                item.run(context);
                setOpen(false);
                onDone?.();
              }}
            >
              <span>{item.label}</span>
              {item.hint ? <small>{item.hint}</small> : null}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

function ToolButton({ action, context }: { action: SelectionAction; context: SelectionContext }) {
  const Icon = action.icon;
  if (action.items) {
    return (
      <ActionMenu
        label={action.label}
        context={context}
        items={action.items}
        trigger={
          <>
            <Icon size={16} aria-hidden="true" />
            {action.label}
            <ChevronDown size={14} aria-hidden="true" />
          </>
        }
      />
    );
  }
  const iconOnly = action.display === "icon";
  return (
    <Tip label={iconOnly ? action.label : undefined}>
      <button
        type="button"
        className={clsx("pd-tool", iconOnly && "pd-tool--icon")}
        data-action={action.id}
        aria-label={action.label}
        onClick={() => action.run?.(context)}
      >
        <Icon size={16} aria-hidden="true" />
        {iconOnly ? null : <span className="pd-tool__label">{action.label}</span>}
      </button>
    </Tip>
  );
}

/** Floats over the selection. Mouse down on it must not collapse the selection it acts on. */
export function SelectionToolbar({ rect, context }: { rect: DOMRect; context: SelectionContext }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);
  const available = selectionActions.filter(action => action.available?.(context) ?? true);
  const shown = available.filter(action => action.display !== "more");
  const overflow = available.filter(action => action.display === "more");
  const groups = [...new Set(shown.map(action => action.group))].sort((a, b) => a - b);

  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const doc = document.querySelector("main .rp-doc")?.getBoundingClientRect();
    const width = element.offsetWidth;
    const min = Math.max(doc?.left ?? GAP, GAP);
    const max = Math.max(Math.min(doc?.right ?? innerWidth - GAP, innerWidth - GAP) - width, min);
    const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, min), max);
    const above = rect.top - element.offsetHeight - GAP;
    setPosition({ top: above > NAV_HEIGHT ? above : rect.bottom + GAP, left });
  }, [rect]);

  if (available.length === 0) return null;
  return (
    <div
      ref={ref}
      className="pd-toolbar"
      role="toolbar"
      aria-label={t("Actions on the selected text")}
      style={position ?? { visibility: "hidden", top: 0, left: 0 }}
      onMouseDown={event => event.preventDefault()}
    >
      {groups.map((group, index) => (
        <React.Fragment key={group}>
          {index > 0 ? <span className="pd-tool-sep" /> : null}
          {shown
            .filter(action => action.group === group)
            .map(action => (
              <ToolButton key={action.id} action={action} context={context} />
            ))}
        </React.Fragment>
      ))}
      {overflow.length > 0 ? (
        <ActionMenu
          label={t("More")}
          context={context}
          trigger={<MoreHorizontal size={16} aria-hidden="true" />}
          items={overflow.map(action => ({ id: action.id, label: action.label, run: ctx => action.run?.(ctx) }))}
        />
      ) : null}
    </div>
  );
}
