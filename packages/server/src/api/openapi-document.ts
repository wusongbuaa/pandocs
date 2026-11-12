import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Next to the bundle in a build, and where it is written when running from source. */
const LOCATIONS = ["./openapi.yaml", "../../../../docs/api/openapi.yaml"];

let document: string | null | undefined;

/** The description of this API, for whoever wants to call it. Nothing in it is secret: the project is open source. */
export function openApiDocument(): string | null {
  if (document !== undefined) return document;
  document = null;
  for (const location of LOCATIONS) {
    try {
      document = readFileSync(fileURLToPath(new URL(location, import.meta.url)), "utf8");
      break;
    } catch {
      // The next place.
    }
  }
  return document;
}
