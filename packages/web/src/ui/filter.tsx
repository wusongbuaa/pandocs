import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import "../styles/kit.css";

/**
 * Narrowing down what a page lists. One is always chosen, so pressing it again leaves it as it is. The group cannot
 * choose an empty value, which "All" often has, so the items go by their place in the list.
 */
export function Filter<Value extends string | number>({
  label,
  value,
  items,
  onChange
}: {
  readonly label: string;
  readonly value: Value;
  readonly items: readonly { readonly value: Value; readonly label: string }[];
  readonly onChange: (value: Value) => void;
}) {
  const chosen = items.findIndex(item => item.value === value);
  return (
    <ToggleGroup
      className="pd-filter"
      aria-label={label}
      size="sm"
      variant="outline"
      spacing={0}
      value={chosen < 0 ? [] : [String(chosen)]}
      onValueChange={(next: readonly string[]) => {
        const item = next[0] === undefined ? undefined : items[Number(next[0])];
        if (item) onChange(item.value);
      }}
    >
      {items.map((item, index) => (
        <ToggleGroupItem key={String(item.value)} value={String(index)}>
          {item.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
