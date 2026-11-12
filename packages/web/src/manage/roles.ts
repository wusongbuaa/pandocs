import type { Role } from "../types";
import { t } from "../i18n";

export const ROLE_LABELS: Readonly<Record<Role, string>> = { none: t("No access"), viewer: t("Can read"), commenter: t("Can comment"), editor: t("Can edit"), admin: t("Administrator") };
export const MEMBER_ROLES: readonly Exclude<Role, "none">[] = ["viewer", "commenter", "editor", "admin"];
export const DEFAULT_ROLES: readonly Role[] = ["none", "viewer", "commenter", "editor"];

