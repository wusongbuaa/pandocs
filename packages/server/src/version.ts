declare const PANDOCS_VERSION: string | undefined;

/** Written in when the server is built. Running from source, there is no release to name. */
export const VERSION = typeof PANDOCS_VERSION === "string" ? PANDOCS_VERSION : "dev";
