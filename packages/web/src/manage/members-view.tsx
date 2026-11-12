import * as React from "react";
import { SelectField } from "../ui/form";
import { api, failureMessage } from "../api/client";
import type { Role, Space } from "../types";
import { toast } from "../ui/toast";
import { MemberEditor } from "./member-editor";
import { ManageHead } from "./parts";
import { DEFAULT_ROLES, ROLE_LABELS } from "./roles";
import { t } from "../i18n";

export function MembersView({ space }: { space: Space }) {
  const [defaultRole, setDefaultRole] = React.useState(space.defaultRole);
  const change = async (next: Role) => {
    const previous = defaultRole;
    setDefaultRole(next);
    try {
      await api.send("PATCH", `spaces/${space.slug}`, { body: { defaultRole: next } });
      toast(t("Saved"), "success");
    } catch (error) {
      setDefaultRole(previous);
      toast(failureMessage(error), "error");
    }
  };
  return (
    <>
      <ManageHead
        title={t("{0}: members", space.name)}
        description={t(
          "A member's role applies to every page in the space. Restricted pages are granted separately, under Pages."
        )}
      />
      <div className="pd-form">
        <SelectField
          label={t("People signed in can by default")}
          description={t(
            'This applies to anyone with no grant of their own. With "No access", only the members below can see this space.'
          )}
          value={defaultRole}
          onChange={value => void change(value as Role)}
          choices={DEFAULT_ROLES.map(role => ({ value: role, label: ROLE_LABELS[role] }))}
        />
      </div>
      <h2>{t("Individual grants")}</h2>
      <MemberEditor path={`spaces/${space.slug}/members`} />
    </>
  );
}
