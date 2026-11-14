import * as React from "react";
import clsx from "clsx";
import { NoSSR } from "@rspress/core/runtime";
import { Popover } from "../ui/popover";
import type { HotspotsBody } from "@pandocs/markdown";
import { assetSource, BlockError, type BlockProps } from "./block-parts";
import { useReader } from "./reader-context";
import { t } from "../i18n";

const CompareSlider = React.lazy(() => import("./compare-slider"));

/** Two screenshots of the same place, with a line to drag between them. */
export function Compare({ attrs, children }: BlockProps) {
  const { space } = useReader();
  if (!attrs.before || !attrs.after)
    return (
      <BlockError
        title={t("This comparison is missing an image")}
        source={`before: ${attrs.before ?? ""}\nafter: ${attrs.after ?? ""}`}
      />
    );
  return (
    <figure className="pd-compare" data-pandocs-nontext="">
      <NoSSR fallback={<div className="pd-compare__stage pd-compare__stage--loading" />}>
        <React.Suspense fallback={<div className="pd-compare__stage pd-compare__stage--loading" />}>
          <CompareSlider
            before={assetSource(space.slug, attrs.before)}
            after={assetSource(space.slug, attrs.after)}
            beforeLabel={attrs.beforeLabel ?? t("Before")}
            afterLabel={attrs.afterLabel ?? t("After")}
          />
        </React.Suspense>
      </NoSSR>
      {children ? <figcaption>{children}</figcaption> : null}
    </figure>
  );
}

/** A screenshot with numbered marks. The list below it says the same as the marks, for print and for a quick read. */
export function Hotspots({ attrs, body, source = "" }: BlockProps) {
  const { space } = useReader();
  const [active, setActive] = React.useState<number | null>(null);
  const points = body as HotspotsBody | undefined;
  if (!points || !attrs.src)
    return <BlockError title={t("This annotated screenshot cannot be shown")} source={source} />;
  return (
    <figure className="pd-hotspots" data-pandocs-nontext="">
      <div className="pd-hotspots__stage">
        <img src={assetSource(space.slug, attrs.src)} alt={attrs.alt ?? ""} />
        {points.map((point, index) => (
          <Popover.Root key={index}>
            <Popover.Trigger
              type="button"
              className={clsx("pd-hotspots__mark", active === index && "pd-hotspots__mark--active")}
              style={{ left: `${point.x}%`, top: `${point.y}%` }}
              aria-label={t("Note {0}: {1}", index + 1, point.title)}
            >
              {index + 1}
            </Popover.Trigger>
            <Popover.Content className="pd-popover pd-hotspots__tip" side="top" sideOffset={8} collisionPadding={12}>
              {point.title ? <strong>{point.title}</strong> : null}
              {point.text ? <p>{point.text}</p> : null}
            </Popover.Content>
          </Popover.Root>
        ))}
      </div>
      {points.length > 0 ? (
        <ol className="pd-hotspots__legend">
          {points.map((point, index) => (
            <li key={index} onMouseEnter={() => setActive(index)} onMouseLeave={() => setActive(null)}>
              {point.title ? <strong>{point.title}</strong> : null}
              {point.text ? <span>{point.text}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </figure>
  );
}
