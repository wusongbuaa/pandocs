export const CSP_HEADER = "Content-Security-Policy";
export const CSP_REPORT_PATH = "/api/csp-report";

/**
 * Enforced from the start. The app shows content written by many people and agents, so a mistake in escaping must not
 * become a running script. 'wasm-unsafe-eval' is for the code highlighter, which compiles WebAssembly and evaluates no scripts.
 */
const pagePolicy = (frameAncestors: string, base: string) =>
  [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    // KaTeX and the theme write style attributes into HTML, and Mermaid adds <style> to its diagrams.
    "style-src 'self' 'unsafe-inline'",
    // Documents can link images and videos from anywhere; an uploaded logo is a data: URL.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `report-uri ${base}${CSP_REPORT_PATH}`
  ].join("; ");

/** For a site below a path, such as `/docs`, reports come back the same way as everything else. */
export const pageCsp = (base = "") => pagePolicy("'self'", base);

export const PAGE_CSP = pageCsp();

/** An embedded page differs in one way: who may frame it. Browsers enforce this, so a site not on the list gets nothing. */
export const embedCsp = (allowedOrigins: readonly string[], base = "") =>
  pagePolicy(["'self'", ...allowedOrigins].join(" "), base);

/** The login page has no script at all. */
export const LOGIN_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
