import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_LANGUAGE, setLanguageScope, type Language } from "@pandocs/i18n";
import { issueMessage } from "@pandocs/markdown";
import { config } from "zod";

const language = new AsyncLocalStorage<Language>();

/** On a server the language belongs to the request, and work it starts carries it along. */
setLanguageScope({
  current: () => language.getStore() ?? DEFAULT_LANGUAGE,
  run: (chosen, work) => language.run(chosen, work)
});

// What a schema rejects is said in that language too.
config({ customError: issueMessage });
