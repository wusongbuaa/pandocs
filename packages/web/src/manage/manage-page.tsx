import type { ManageSpec } from "../data/manage";
import { API_BASE } from "../api/client";
import ApiReference from "../markdown/api-reference";
import { AccountView } from "./account-view";
import { AuditView, SiteAuditView } from "./audit-view";
import { ChangeSetsView } from "./change-sets-view";
import { DraftsView } from "./drafts-view";
import { GlossaryView } from "./glossary-view";
import { ImportsView } from "./imports-view";
import { InboxView } from "./inbox-view";
import { InsightsView } from "./insights-view";
import { MembersView } from "./members-view";
import { PagesView } from "./pages-view";
import { SiteView } from "./site-view";
import { SpaceSettingsView } from "./space-settings-view";
import { SpacesView } from "./spaces-view";
import { TemplatesView } from "./templates-view";
import { TrashView } from "./trash-view";
import { EmbedAppsView } from "./embed-view";
import { UsersView } from "./users-view";
import { GitSyncView } from "./git-sync-view";
import { WebhooksView } from "./webhooks-view";

function View({ spec }: { spec: ManageSpec }) {
  switch (spec.view) {
    case "inbox":
      return <InboxView />;
    case "drafts":
      return <DraftsView />;
    case "account":
      return <AccountView />;
    case "api-reference":
      return <ApiReference url={`${API_BASE}/openapi.yaml`} full tryable />;
    case "users":
      return <UsersView />;
    case "embed-apps":
      return <EmbedAppsView />;
    case "spaces":
      return <SpacesView />;
    case "site":
      return <SiteView />;
    case "site-audit":
      return <SiteAuditView />;
    case "site-insights":
      return <InsightsView />;
    case "site-webhooks":
      return <WebhooksView />;
    case "webhooks":
      return <WebhooksView space={spec.space} />;
    case "git-sync":
      return <GitSyncView space={spec.space} />;
    case "insights":
      return <InsightsView space={spec.space} />;
    case "pages":
      return <PagesView space={spec.space} />;
    case "change-sets":
      return <ChangeSetsView space={spec.space} />;
    case "templates":
      return <TemplatesView space={spec.space} />;
    case "members":
      return <MembersView space={spec.space} />;
    case "trash":
      return <TrashView space={spec.space} />;
    case "imports":
      return <ImportsView space={spec.space} />;
    case "glossary":
      return <GlossaryView space={spec.space} />;
    case "audit":
      return <AuditView space={spec.space} />;
    case "settings":
      return <SpaceSettingsView space={spec.space} />;
  }
}

/** The product's own pages. They sit in the theme's document layout, with its sidebar for the navigation between them. */
export default function ManagePage({ spec }: { spec: ManageSpec }) {
  return (
    <div className="pd-manage">
      <View spec={spec} />
    </div>
  );
}
