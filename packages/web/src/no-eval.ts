import { config } from "zod";

// The page's policy has no eval. Zod tries `new Function` to find out whether it may compile its parsers, which works
// but files a violation report on every page. It decides when a schema is created, so this runs before any of them.
config({ jitless: true });
