import * as React from "react";
import { usePage } from "@rspress/core/runtime";
import Reveal from "reveal.js";
import "reveal.js/reveal.css";
import type { PandocsPage } from "../data/pages";
import { useDocumentContent, useReaderContextOf } from "../markdown/document-body";
import { ReaderContextProvider } from "../markdown/reader-context";
import { PresentFrame } from "./present-frame";
import { splitSlides } from "./split-slides";
import { t } from "../i18n";

/** Reveal counts every `section` under its slides as a slide, including the one footnotes come in. */
function PlainSection(props: React.ComponentProps<"div">) {
  return <div {...props} />;
}
const SLIDE_COMPONENTS = { section: PlainSection };

function Slide({ hast }: { hast: PandocsPage["rendered"]["hast"] }) {
  return <section><div className="rp-doc pd-slide">{useDocumentContent(hast, SLIDE_COMPONENTS)}</div></section>;
}

/** The page as a deck, drawn by the same components as the page itself, so every block looks the way it reads. */
export default function SlidesView({ page }: { page: PandocsPage }) {
  const { page: { title } } = usePage();
  const deck = React.useRef<HTMLDivElement>(null);
  const shown = React.useRef<InstanceType<typeof Reveal> | null>(null);
  const context = useReaderContextOf(page);
  const { opening, slides } = React.useMemo(() => splitSlides(page.rendered.hast), [page.rendered.hast]);
  const openingContent = useDocumentContent(React.useMemo(() => ({ type: "root" as const, children: [...opening] as never[] }), [opening]), SLIDE_COMPONENTS);
  React.useEffect(() => {
    let left = false;
    // `overview` off because Escape leaves the deck; the address stays the page's, so reloading starts over from the top.
    const reveal = new Reveal(deck.current!, { embedded: true, hash: false, history: false, respondToHashChanges: false, overview: false, help: false, keyboardCondition: () => !document.querySelector(".pd-zoom"), center: false, width: 960, height: 600, margin: 0.06, maxScale: 2, slideNumber: "c/t", transition: "fade", transitionSpeed: "fast", backgroundTransition: "none" });
    void reveal.initialize().then(() => {
      if (left) reveal.destroy();
      else shown.current = reveal;
    });
    return () => {
      left = true;
      shown.current = null;
      if (reveal.isReady()) reveal.destroy();
    };
  }, []);
  // A new version of the page, from someone saving while this is open, can have more slides or fewer, which the deck
  // has to count again; where the presenter is stays.
  React.useEffect(() => {
    shown.current?.sync();
  }, [slides]);
  return (
    <PresentFrame page={page} label={t("Presentation")}>
      <ReaderContextProvider value={context}>
        <div ref={deck} className="reveal">
          <div className="slides">
            <section><div className="rp-doc pd-slide pd-slide--opening"><h1>{title}</h1>{openingContent}</div></section>
            {slides.map((slide, index) => <Slide key={index} hast={slide} />)}
          </div>
        </div>
      </ReaderContextProvider>
    </PresentFrame>
  );
}
