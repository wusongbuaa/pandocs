import * as React from "react";
import { Bell, BellRing } from "lucide-react";
import { Popover } from "../ui/popover";
import { api, failureMessage } from "../api/client";
import { toast } from "../ui/toast";
import { Tip } from "../ui/tooltip";
import { t } from "../i18n";

const FollowOptions = React.lazy(() => import("./follow-options"));

/** Being told when a page, or anything in its space, changes. It costs a request per page, so it waits until the page is showing. */
export function FollowButton({ documentId, space, spaceName }: { documentId: string; space: string; spaceName: string }) {
  const [following, setFollowing] = React.useState({ document: false, space: false });
  React.useEffect(() => {
    let current = true;
    api.get<typeof following>(`documents/${documentId}/subscription`).then(state => { if (current) setFollowing(state); }, () => undefined);
    return () => { current = false; };
  }, [documentId]);
  const change = async (what: keyof typeof following, on: boolean) => {
    setFollowing(state => ({ ...state, [what]: on }));
    try {
      await api.send(on ? "PUT" : "DELETE", what === "document" ? `documents/${documentId}/subscription` : `spaces/${encodeURIComponent(space)}/subscription`);
    } catch (error) {
      setFollowing(state => ({ ...state, [what]: !on }));
      toast(failureMessage(error), "error");
    }
  };
  const on = following.document || following.space;
  const label = on ? t("Following") : t("Follow");
  return (
    <Popover.Root>
      <Tip label={label}>
        <Popover.Trigger className="rp-llms-button pd-action pd-action--icon" aria-label={label}>
          {on ? <BellRing size={16} aria-hidden="true" /> : <Bell size={16} aria-hidden="true" />}
        </Popover.Trigger>
      </Tip>
      <Popover.Content className="pd-follow" align="start" sideOffset={6}>
        <React.Suspense fallback={null}><FollowOptions document={following.document} space={following.space} spaceName={spaceName} onChange={change} /></React.Suspense>
      </Popover.Content>
    </Popover.Root>
  );
}
