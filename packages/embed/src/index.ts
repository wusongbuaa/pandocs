/**
 * `<pandocs-doc>`: a page of a Pandocs site inside another web app. The page itself runs in a frame, so it is the same
 * page people see on the site, styled by its own theme and not by the app around it.
 *
 * ```html
 * <pandocs-doc server="https://docs.example.com" app="helpdesk" space="handbook" path="getting-started"></pandocs-doc>
 * <script type="module">
 *   document.querySelector("pandocs-doc").getToken = async () => {
 *     // Your server calls POST /api/v1/embed/sessions with your app's secret, and hands back the token.
 *     const response = await fetch("/my-api/pandocs-token");
 *     return (await response.json()).token;
 *   };
 * </script>
 * ```
 */
export type TokenProvider = () => Promise<string> | string;

export interface PandocsNavigateDetail {
  readonly path: string;
}

const OBSERVED = ["space", "path", "theme"] as const;
/** Allows what a document needs, and stops it navigating the page around it. */
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

const BaseElement: typeof HTMLElement =
  typeof HTMLElement === "undefined" ? (class {} as typeof HTMLElement) : HTMLElement;

export class PandocsDocElement extends BaseElement {
  static readonly observedAttributes = OBSERVED;

  /** Where to get a token for the person using this page. Asked again when the current one is about to run out. */
  getToken: TokenProvider | undefined;

  private frame: HTMLIFrameElement | null = null;
  private origin = "";
  private currentPath = "";

  private readonly onMessage = (event: MessageEvent) => {
    if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== this.origin) return;
    const message = event.data as { type?: string; path?: string } | null;
    if (message?.type === "pandocs:need-token") void this.sendToken();
    else if (message?.type === "pandocs:ready") this.dispatchEvent(new CustomEvent("pandocs-ready"));
    else if (message?.type === "pandocs:navigate" && typeof message.path === "string") {
      this.reflect(message.path);
      this.dispatchEvent(
        new CustomEvent<PandocsNavigateDetail>("pandocs-navigate", { detail: { path: message.path } })
      );
    }
  };

  /** The attributes say where the frame is, so setting one to anywhere else means going there. */
  private reflect(path: string): void {
    const [space = "", ...rest] = path.split(/[?#]/u)[0]!.split("/").filter(Boolean).map(decodeURIComponent);
    this.currentPath = `/${[space, ...rest].map(encodeURIComponent).join("/")}`;
    this.setAttribute("space", space);
    this.setAttribute("path", rest.join("/"));
  }

  private async sendToken(): Promise<void> {
    if (!this.getToken) {
      this.fail(new Error("pandocs-doc needs a getToken function"));
      return;
    }
    try {
      const token = await this.getToken();
      this.frame?.contentWindow?.postMessage({ type: "pandocs:token", token }, this.origin);
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.dispatchEvent(new CustomEvent("pandocs-error", { detail: { error } }));
  }

  private pagePath(): string {
    const space = this.getAttribute("space") ?? "";
    const path = this.getAttribute("path") ?? "";
    return `/${[space, ...path.split("/").filter(Boolean)].map(encodeURIComponent).join("/")}`;
  }

  connectedCallback(): void {
    const server = this.getAttribute("server");
    const app = this.getAttribute("app");
    if (!server || !app) {
      this.fail(new Error("pandocs-doc needs server and app"));
      return;
    }
    const base = new URL(server);
    this.origin = base.origin;
    this.currentPath = this.pagePath();
    const address = new URL(
      `${base.pathname.replace(/\/$/u, "")}/embed/${encodeURIComponent(app)}${this.currentPath}`,
      base.origin
    );
    address.searchParams.set("host", location.origin);
    const theme = this.getAttribute("theme");
    if (theme) address.searchParams.set("theme", theme);
    const language = this.getAttribute("lang");
    if (language) address.searchParams.set("lang", language);
    if (this.hasAttribute("sidebar")) address.searchParams.set("sidebar", "1");

    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", SANDBOX);
    frame.setAttribute("allow", "clipboard-write");
    frame.setAttribute("title", this.getAttribute("title") ?? "Document");
    frame.style.cssText = "display:block;width:100%;height:100%;border:0";
    const style = document.createElement("style");
    style.textContent = ":host{display:block;height:600px}";
    root.replaceChildren(style, frame);
    this.frame = frame;
    window.addEventListener("message", this.onMessage);
    frame.src = address.toString();
  }

  disconnectedCallback(): void {
    window.removeEventListener("message", this.onMessage);
    this.frame = null;
  }

  attributeChangedCallback(name: string, previous: string | null, value: string | null): void {
    if (!this.frame || previous === value) return;
    const target = this.frame.contentWindow;
    if (name === "theme" && value) target?.postMessage({ type: "pandocs:theme", theme: value }, this.origin);
    if (name === "path" || name === "space") {
      const path = this.pagePath();
      if (path !== this.currentPath) {
        this.currentPath = path;
        target?.postMessage({ type: "pandocs:navigate", path }, this.origin);
      }
    }
  }
}

if (typeof customElements !== "undefined" && !customElements.get("pandocs-doc"))
  customElements.define("pandocs-doc", PandocsDocElement);
