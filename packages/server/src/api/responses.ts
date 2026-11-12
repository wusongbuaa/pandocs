const NO_STORE = { "Cache-Control": "no-store" };

/** The same envelope as the core's API, so clients read one shape. */
export const dataResponse = (data: unknown, status = 200) =>
  Response.json({ version: 1, data }, { status, headers: NO_STORE });
export const errorResponse = (status: number, code: string, message: string, details?: unknown) =>
  Response.json(
    { version: 1, error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: NO_STORE }
  );
