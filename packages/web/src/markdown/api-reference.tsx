import * as React from "react";
import { useDark } from "@rspress/core/runtime";
// By its path, because it is not one of the files the package says can be imported.
import scalarScript from "../../node_modules/@scalar/api-reference/dist/browser/standalone.js?url";
import { t } from "../i18n";

interface ScalarApp {
  destroy(): void;
}

interface Scalar {
  createApiReference(element: HTMLElement, configuration: object): ScalarApp;
}

let loading: Promise<Scalar> | null = null;

/** The whole of it is a few megabytes, so it comes as the file its authors publish, and only to pages that show one. */
function loadScalar(): Promise<Scalar> {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scalarScript;
    script.onload = () => resolve((window as unknown as { Scalar: Scalar }).Scalar);
    script.onerror = () => {
      loading = null;
      reject(new Error(t("The API reference could not be loaded")));
    };
    document.head.append(script);
  });
  return loading;
}

/**
 * It sits on a panel of its own: its list and columns have room inside them that the page's own text does not, and on
 * a panel that room reads as the panel's edge. What it puts on the panel, such as the address to call, comes forward.
 */
const OUR_LOOK = `
.scalar-app {
  --scalar-font: var(--rp-font-family-base);
  --scalar-font-code: var(--rp-font-family-mono);
  --scalar-custom-header-height: var(--rp-nav-height, 0px);
}
.light-mode, .dark-mode {
  --scalar-color-accent: var(--rp-c-brand);
}
.light-mode {
  --scalar-background-1: var(--rp-c-bg-soft);
  --scalar-background-2: var(--rp-c-bg);
  --scalar-background-3: var(--rp-c-bg-mute);
  --scalar-border-color: var(--rp-c-divider-light);
}
.dark-mode {
  --scalar-background-1: #18181b;
  --scalar-background-2: #121212;
  --scalar-background-3: #26262b;
  --scalar-border-color: var(--rp-c-divider-light);
}`;

/**
 * `tryable` is for the site's own API: anywhere else, the page's policy would stop the browser sending a request. It has
 * nothing to send anywhere otherwise, and everything it offers that needs its makers' servers is turned off.
 */
export default function ApiReference({ url, full, tryable = false }: { readonly url: string; readonly full: boolean; readonly tryable?: boolean }) {
  const host = React.useRef<HTMLDivElement>(null);
  const dark = useDark();
  const [failure, setFailure] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!full) return undefined;
    document.documentElement.classList.add("pd-api-reference-full");
    return () => document.documentElement.classList.remove("pd-api-reference-full");
  }, [full]);
  React.useEffect(() => {
    let current = true;
    let app: ScalarApp | null = null;
    loadScalar().then(scalar => {
      if (!current || !host.current) return;
      app = scalar.createApiReference(host.current, {
        url,
        showSidebar: full,
        hideDarkModeToggle: true,
        forceDarkModeState: dark ? "dark" : "light",
        withDefaultFonts: false,
        hideClientButton: true,
        hideTestRequestButton: !tryable,
        showDeveloperTools: "never",
        telemetry: false,
        agent: { disabled: true },
        mcp: { disabled: true },
        customCss: OUR_LOOK
      });
    }, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    return () => {
      current = false;
      app?.destroy();
    };
  }, [url, full, tryable, dark]);
  if (failure) return <p className="pd-muted">{failure}</p>;
  return <div ref={host} className="pd-api-reference" />;
}
