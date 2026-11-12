import { SwitchField } from "../ui/form";
import { t } from "../i18n";

export default function FollowOptions({
  document,
  space,
  spaceName,
  onChange
}: {
  document: boolean;
  space: boolean;
  spaceName: string;
  onChange: (what: "document" | "space", on: boolean) => Promise<void>;
}) {
  return (
    <>
      <SwitchField label={t("This page")} checked={document} onChange={on => void onChange("document", on)} />
      <SwitchField
        label={t("Every page in {0}", spaceName)}
        checked={space}
        onChange={on => void onChange("space", on)}
      />
      <p className="pd-follow__note">
        {t("You will see changes in your notifications, and by mail if this site sends mail.")}
      </p>
    </>
  );
}
