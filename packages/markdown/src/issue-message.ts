import { t } from "@pandocs/i18n";
import type { core } from "zod";

/**
 * What a rejected value says when its schema has no words of its own, in the reader's language where zod's would be
 * English. A schema's own `error` still comes first. The server and the web app install it with
 * `config({ customError: issueMessage })`, so that what a form shows under a field and what an editor shows about a
 * block are in the same language as everything around them.
 */
export function issueMessage(issue: core.$ZodRawIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? t("Required") : t("Expected {0}", issue.expected);
    case "too_small": {
      const minimum = Number(issue.minimum);
      if (issue.origin === "string") return minimum <= 1 ? t("Required") : t("At least {0} {0|character|characters}", minimum);
      if (issue.origin === "array" || issue.origin === "set") return t("At least {0} {0|item|items}", minimum);
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") return issue.inclusive ? t("At least {0}", minimum) : t("More than {0}", minimum);
      return t("Not valid");
    }
    case "too_big": {
      const maximum = Number(issue.maximum);
      if (issue.origin === "string") return t("At most {0} {0|character|characters}", maximum);
      if (issue.origin === "array" || issue.origin === "set") return t("At most {0} {0|item|items}", maximum);
      if (issue.origin === "number" || issue.origin === "int" || issue.origin === "bigint") return issue.inclusive ? t("At most {0}", maximum) : t("Less than {0}", maximum);
      return t("Not valid");
    }
    case "invalid_format":
      if (issue.format === "email") return t("Not an email address");
      if (issue.format === "url") return t("Not a web address");
      if (issue.format === "uuid" || issue.format === "guid") return t("Not a valid ID");
      if (issue.format === "datetime" || issue.format === "date" || issue.format === "time") return t("Not a valid date or time");
      return t("Not in the right format");
    case "invalid_value":
      return t("Must be one of: {0}", issue.values.map(String).join(t(", ")));
    case "unrecognized_keys":
      return t("Unknown {0|field|fields}: {1}", issue.keys.length, issue.keys.join(t(", ")));
    case "not_multiple_of":
      return t("Must be a multiple of {0}", Number(issue.divisor));
    default:
      return t("Not valid");
  }
}
