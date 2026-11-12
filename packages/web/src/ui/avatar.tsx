import Marble from "boring-avatars";

/** The panda's ink and the greens of its book, so that a person's mark looks like it belongs to the site. */
const AVATAR_COLORS = ["#1f2430", "#159c5d", "#22b573", "#5fd39a", "#d7f5e5"];

/** A person's mark: drawn from their id, so it stays the same when they change their name. */
export function PersonMark({ id, size }: { readonly id: string; readonly size: number }) {
  return <Marble name={id} variant="marble" colors={AVATAR_COLORS} size={size} />;
}

export function Avatar({
  id,
  name,
  size = 24
}: {
  readonly id: string;
  readonly name: string;
  readonly size?: number;
}) {
  return (
    <span className="pd-avatar" title={name} aria-hidden="true">
      <PersonMark id={id} size={size} />
    </span>
  );
}
