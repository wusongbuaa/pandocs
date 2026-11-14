import * as React from "react";
import { Button } from "@/components/ui/button";
import { ChoiceSelect } from "../ui/form";
import { api, failureMessage } from "../api/client";
import type { Member, Role } from "../types";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList
} from "@/components/ui/combobox";
import { EmptyState, LoadedContent } from "./parts";
import { MEMBER_ROLES, ROLE_LABELS } from "./roles";
import { t } from "../i18n";

function subjectLabel({ subject, name }: Member): string {
  if (subject === "everyone") return t("Everyone signed in");
  if (subject.startsWith("group:")) return t("Group {0}", subject.slice("group:".length));
  return name ?? subject.slice("user:".length);
}

function PeoplePicker({ onPick }: { onPick: (subject: string, name: string) => void }) {
  const [query, setQuery] = React.useState("");
  const [people, setPeople] = React.useState<readonly { id: string; name: string }[]>([]);
  React.useEffect(() => {
    const keyword = query.trim();
    if (!keyword || keyword.startsWith("group:")) {
      setPeople([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      api
        .get<{ id: string; name: string }[]>(`directory?q=${encodeURIComponent(keyword)}`)
        .then(setPeople, () => setPeople([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  const pick = (subject: string, name: string) => {
    onPick(subject, name);
    setQuery("");
    setPeople([]);
  };
  const group = query.trim().startsWith("group:") && query.trim().length > "group:".length ? query.trim() : null;
  const items = [
    ...(group ? [{ value: group, label: t("Group {0}", group.slice("group:".length)) }] : []),
    ...people.map(person => ({ value: `user:${person.id}`, label: person.name }))
  ];
  return (
    <Combobox
      items={items}
      filter={null}
      value={null}
      inputValue={query}
      openOnInputClick={false}
      onInputValueChange={(next, details) => {
        if (details.reason !== "item-press") setQuery(next);
      }}
      onValueChange={(next: { value: string; label: string } | null) => {
        if (next) pick(next.value, next.label);
      }}
    >
      <ComboboxInput
        className="pd-members__picker"
        aria-label={t("Add a member")}
        placeholder={t("Name or email. For a group, write group:name")}
        showTrigger={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>{t("Nothing found")}</ComboboxEmpty>
        <ComboboxList>
          {(item: { value: string; label: string }) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** Who has what on a space or a restricted page. Saving is immediate; there is nothing half-done to lose. */
export function MemberEditor({ path }: { path: string }) {
  const loaded = useLoaded(() => api.get<Member[]>(path), [path]);
  const [role, setRole] = React.useState<Exclude<Role, "none">>("viewer");
  const set = async (subject: string, next: Role | null) => {
    try {
      await api.send("PUT", path, { body: { subject, role: next } });
      loaded.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const everyone = loaded.status === "ready" && loaded.data.some(member => member.subject === "everyone");
  return (
    <div className="pd-members">
      <div className="pd-members__add">
        <PeoplePicker onPick={subject => void set(subject, role)} />
        <ChoiceSelect
          className="pd-members__role"
          label={t("Their role")}
          value={role}
          onChange={value => setRole(value as Exclude<Role, "none">)}
          choices={MEMBER_ROLES.map(item => ({ value: item, label: ROLE_LABELS[item] }))}
        />
        {!everyone ? (
          <Button variant="outline" onClick={() => void set("everyone", role)}>
            {t("Add everyone signed in")}
          </Button>
        ) : null}
      </div>
      <LoadedContent loaded={loaded}>
        {members =>
          members.length === 0 ? (
            <EmptyState>{t("No individually granted members yet.")}</EmptyState>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>{t("Members")}</th>
                  <th>{t("Permissions")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map(member => (
                  <tr key={member.subject}>
                    <td>{subjectLabel(member)}</td>
                    <td>
                      <ChoiceSelect
                        size="sm"
                        className="pd-members__role"
                        label={t("Role of {0}", subjectLabel(member))}
                        value={member.role}
                        onChange={value => void set(member.subject, value as Role)}
                        choices={MEMBER_ROLES.map(item => ({ value: item, label: ROLE_LABELS[item] }))}
                      />
                    </td>
                    <td className="pd-table__actions">
                      <Button variant="outline" size="sm" onClick={() => void set(member.subject, null)}>
                        {t("Remove")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </LoadedContent>
    </div>
  );
}
