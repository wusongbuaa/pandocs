import * as React from "react";
import type { Space, TreeEntry } from "../types";

export interface ReaderContextValue {
  readonly space: Pick<Space, "slug" | "name">;
  /** The document's path inside the space; relative links resolve against it. */
  readonly currentPath: string;
  /** Prepended to routes when another language than the default is showing. */
  readonly routePrefix: string;
  readonly children: readonly TreeEntry[];
  /** Present when the reader may start a discussion on an image or a diagram. */
  readonly onCommentBlock?: ((ref: string) => void) | undefined;
}

const ReaderContext = React.createContext<ReaderContextValue>({ space: { slug: "", name: "" }, currentPath: "", routePrefix: "", children: [] });

export const ReaderContextProvider = ReaderContext.Provider;
export const useReader = () => React.useContext(ReaderContext);
