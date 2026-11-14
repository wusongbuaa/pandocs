import { t } from "@pandocs/i18n";

export class PandocsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PandocsError";
  }
}

export const notFound = (what: string) =>
  new PandocsError(404, "NOT_FOUND", t("{0} not found, or you have no access to it", what));
export const forbidden = (message = t("You do not have permission to do this")) =>
  new PandocsError(403, "FORBIDDEN", message);
export const invalid = (code: string, message: string, details?: unknown) =>
  new PandocsError(422, code, message, details);
export const revisionConflict = (current: number) =>
  new PandocsError(
    409,
    "REVISION_CONFLICT",
    t("The document is now at version {0}. Try again from the latest content.", current),
    { currentRevision: current }
  );

/** Unique indexes whose violation means two people asked for the same address at once, which is a conflict, not a fault. */
const TAKEN: Readonly<Record<string, string>> = {
  documents_space_path_unique: "DOCUMENT_PATH_TAKEN",
  documents_space_folded_path_unique: "DOCUMENT_PATH_TAKEN",
  spaces_slug_unique: "SPACE_SLUG_TAKEN",
  spaces_slug_key: "SPACE_SLUG_TAKEN"
};

/** Refusals that mean what was asked cannot be stored as it is: a check, a number out of range, text too long. */
const NOT_STORABLE = new Set(["23514", "22003", "22001", "22P02"]);
/** Two changes at the same moment that the database could not both let through. Asking again finds things as they are now. */
const AT_ONCE = new Set(["40P01", "40001"]);

/** What the database refused, said the way the API says it, for what the checks before it could not see coming. */
export function fromDatabase(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  const taken = code === "23505" && typeof constraint === "string" ? TAKEN[constraint] : undefined;
  if (taken) return new PandocsError(409, taken, t("Someone took this address a moment ago. Choose another."));
  if (typeof code === "string" && NOT_STORABLE.has(code))
    return invalid("INPUT_INVALID", t("The request is not valid"));
  if (typeof code === "string" && AT_ONCE.has(code))
    return new PandocsError(
      409,
      "CONCURRENT_CHANGE",
      t("Someone else changed this at the same moment. Look again, then try again.")
    );
  return error;
}
