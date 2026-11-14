import * as React from "react";
import type { PandocsDocElement, PandocsNavigateDetail, TokenProvider } from "./index.js";
import "./index.js";

export interface PandocsDocProps {
  readonly server: string;
  readonly app: string;
  readonly space: string;
  readonly path?: string;
  readonly theme?: "light" | "dark";
  /** The language of the page's own text. Otherwise it follows the browser. */
  readonly lang?: "en" | "zh";
  /** Shows the space's page tree beside the page. */
  readonly sidebar?: boolean;
  readonly getToken: TokenProvider;
  readonly onNavigate?: (path: string) => void;
  readonly onError?: (error: unknown) => void;
  readonly className?: string;
  readonly style?: React.CSSProperties;
}

/** The `<pandocs-doc>` element for React. Set a height with `style` or `className`. */
export function PandocsDoc({
  server,
  app,
  space,
  path,
  theme,
  lang,
  sidebar,
  getToken,
  onNavigate,
  onError,
  className,
  style
}: PandocsDocProps) {
  const ref = React.useRef<PandocsDocElement | null>(null);
  const latest = React.useRef({ getToken, onNavigate, onError });
  latest.current = { getToken, onNavigate, onError };

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    element.getToken = () => latest.current.getToken();
    const navigate = (event: Event) =>
      latest.current.onNavigate?.((event as CustomEvent<PandocsNavigateDetail>).detail.path);
    const fail = (event: Event) => latest.current.onError?.((event as CustomEvent<{ error: unknown }>).detail.error);
    element.addEventListener("pandocs-navigate", navigate);
    element.addEventListener("pandocs-error", fail);
    return () => {
      element.removeEventListener("pandocs-navigate", navigate);
      element.removeEventListener("pandocs-error", fail);
    };
  }, []);

  return React.createElement("pandocs-doc", {
    ref,
    server,
    app,
    space,
    ...(path ? { path } : {}),
    ...(theme ? { theme } : {}),
    ...(lang ? { lang } : {}),
    ...(sidebar ? { sidebar: "" } : {}),
    ...(className ? { class: className } : {}),
    ...(style ? { style } : {})
  });
}
