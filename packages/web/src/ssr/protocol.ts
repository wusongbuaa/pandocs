import type { PreparedAnswer } from "../api/client";

/** What a page starts from, on the server and again in the browser, so that the two come out the same. */
export interface RenderedState {
  readonly origin: string;
  /** The answers the page's first render reads, by the path it would have asked the API for. */
  readonly answers: Readonly<Record<string, PreparedAnswer>>;
}

export interface RenderInput extends RenderedState {
  /** The path and query being rendered. */
  readonly url: string;
}

export interface RenderedPage {
  readonly html: string;
  readonly headTags: string;
  readonly htmlAttrs: string;
  /** The theme knows a page is missing once it has looked, which here is what a server has to answer with. */
  readonly status: 200 | 404;
}

export const STATE_ELEMENT_ID = "pandocs-state";
