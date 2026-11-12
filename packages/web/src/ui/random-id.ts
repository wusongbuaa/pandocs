/** Browsers only offer `randomUUID` over HTTPS and on localhost, and a site on a local network may be on neither. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
