import * as React from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import { api } from "../api/client";
import { fromInputMethod } from "../ui/input-method";
import { useLoaded } from "../ui/use-loaded";
import { t } from "../i18n";

/** Typing a new label, with the ones already used in this space to choose from. */
export default function NewLabel({
  space,
  taken,
  onAdd,
  onCancel
}: {
  space: string;
  taken: readonly string[];
  onAdd: (label: string) => void;
  onCancel: () => void;
}) {
  const known = useLoaded(() => api.get<{ label: string }[]>(`spaces/${encodeURIComponent(space)}/labels`), [space]);
  const [text, setText] = React.useState("");
  const highlighted = React.useRef(false);
  const inUse = new Set(taken.map(label => label.toLowerCase()));
  const items = (known.status === "ready" ? known.data : [])
    .map(({ label }) => label)
    .filter(label => !inUse.has(label.toLowerCase()));
  return (
    <Autocomplete.Root
      items={items}
      value={text}
      openOnInputClick
      onItemHighlighted={item => {
        highlighted.current = item !== undefined;
      }}
      onValueChange={(next, details) => {
        if (details.reason === "item-press") onAdd(next);
        else setText(next);
      }}
    >
      <Autocomplete.Input
        className="pd-label-input"
        autoFocus
        maxLength={40}
        aria-label={t("New label")}
        placeholder={t("New label")}
        onBlur={() => {
          if (!text.trim()) onCancel();
        }}
        onKeyDown={event => {
          if (fromInputMethod(event)) return;
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter" && !highlighted.current && text.trim()) onAdd(text.trim());
        }}
      />
      <Autocomplete.Portal>
        <Autocomplete.Positioner className="pd-floating" align="start" sideOffset={6}>
          <Autocomplete.Popup className="pd-menu">
            <Autocomplete.List>
              {(label: string) => (
                <Autocomplete.Item key={label} value={label} className="pd-menu__item">
                  {label}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
