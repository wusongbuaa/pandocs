import * as React from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckboxField, PasswordField, SelectField, SwitchField, TextField } from "../ui/form";
import { Menu } from "../ui/menu";
import { api, failureMessage } from "../api/client";
import type { Space } from "../types";
import { confirm } from "../ui/confirm";
import { Dialog, FormDialog } from "../ui/dialog";
import { relativeTime } from "../ui/time";
import { toast } from "../ui/toast";
import { useLoaded } from "../ui/use-loaded";
import { EmptyState, LoadedContent, ManageHead } from "./parts";
import { t } from "../i18n";

type Kind = "generic" | "slack" | "feishu" | "wecom" | "dingtalk" | "teams";

interface Webhook {
  readonly id: string;
  readonly name: string;
  readonly kind: Kind;
  /** Only where it points: the rest of the address is as secret as a password. */
  readonly url: string;
  readonly hasSecret: boolean;
  readonly events: readonly string[];
  readonly includeRestricted: boolean;
  readonly enabled: boolean;
  readonly consecutiveFailures: number;
  readonly lastStatus: string | null;
  readonly lastDeliveredAt: string | null;
}

interface Delivery {
  readonly id: string;
  readonly event: string;
  readonly status: "pending" | "delivered" | "failed";
  readonly attempts: number;
  readonly responseStatus: number | null;
  readonly error: string | null;
  readonly createdAt: string;
}

const kinds = (): readonly {
  readonly value: Kind;
  readonly label: string;
  readonly help: string;
  readonly signed: boolean;
}[] => [
  {
    value: "feishu",
    label: t("Feishu or Lark group"),
    help: t(
      "In the group's settings, add a custom bot and copy its address. Turn on signature verification to get a secret."
    ),
    signed: true
  },
  {
    value: "slack",
    label: "Slack",
    help: t("Create an incoming webhook for the channel and copy its address."),
    signed: false
  },
  {
    value: "wecom",
    label: t("WeCom group"),
    help: t("Add a group bot in the group's settings and copy its address."),
    signed: false
  },
  {
    value: "dingtalk",
    label: t("DingTalk group"),
    help: t(
      "Add a custom bot in the group's settings and copy its address. Choose signing as its security setting to get a secret."
    ),
    signed: true
  },
  {
    value: "teams",
    label: "Microsoft Teams",
    help: t("In the channel, create a workflow that posts when a webhook request arrives, and copy its address."),
    signed: false
  },
  {
    value: "generic",
    label: t("Another system"),
    help: t("It gets each event as signed JSON. See the documentation for the format."),
    signed: true
  }
];

const eventLabels = (): Readonly<Record<string, string>> => ({
  "page.created": t("A page is created"),
  "page.updated": t("A page is saved"),
  "page.moved": t("A page is moved"),
  "page.deleted": t("A page is deleted"),
  "page.restored": t("A page is restored"),
  "comment.created": t("Someone comments"),
  "thread.resolved": t("A discussion is resolved"),
  "proposal.created": t("A change is suggested"),
  "proposal.decided": t("A suggestion is decided"),
  "feedback.created": t("A reader leaves feedback"),
  "change_set.created": t("A change set is started"),
  "change_set.reviewed": t("A change set is reviewed"),
  "change_set.merged": t("A change set is merged"),
  "change_set.closed": t("A change set is closed")
});

function HookDialog({
  hook,
  base,
  onClose,
  onSaved
}: {
  hook: Webhook | null;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const labels = eventLabels();
  const [name, setName] = React.useState(hook?.name ?? "");
  const [kind, setKind] = React.useState<Kind>(hook?.kind ?? "feishu");
  const [url, setUrl] = React.useState("");
  const [secret, setSecret] = React.useState("");
  const [events, setEvents] = React.useState<readonly string[]>(
    hook?.events ?? ["page.created", "page.updated", "proposal.created"]
  );
  const [includeRestricted, setIncludeRestricted] = React.useState(hook?.includeRestricted ?? false);
  const kindInfo = kinds().find(item => item.value === kind)!;
  const toggle = (event: string, on: boolean) =>
    setEvents(current => (on ? [...current, event] : current.filter(item => item !== event)));
  const save = async () => {
    const body = {
      name: name.trim(),
      kind,
      events,
      includeRestricted,
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(secret ? { secret } : {})
    };
    await (hook ? api.send("PATCH", `webhooks/${hook.id}`, { body }) : api.send("POST", base, { body }));
    onSaved();
  };
  return (
    <FormDialog
      title={hook ? t("Edit the webhook") : t("New webhook")}
      onClose={onClose}
      action={t("Save")}
      disabled={events.length === 0}
      onSubmit={save}
    >
      <SelectField
        label={t("Sends to")}
        description={kindInfo.help}
        value={kind}
        onChange={value => setKind(value as Kind)}
        choices={kinds().map(item => ({ value: item.value, label: item.label }))}
      />
      <TextField
        name="name"
        label={t("Name")}
        required
        autoFocus
        maxLength={80}
        value={name}
        onChange={event => setName(event.target.value)}
      />
      <TextField
        name="url"
        label={t("Address")}
        required={!hook}
        value={url}
        placeholder={hook ? t("{0} (leave empty to keep it)", hook.url) : "https://…"}
        onChange={event => setUrl(event.target.value)}
      />
      {kindInfo.signed ? (
        <PasswordField
          label={t("Secret (optional)")}
          autoComplete="off"
          value={secret}
          placeholder={hook?.hasSecret ? t("Set. Leave empty to keep it.") : ""}
          onChange={event => setSecret(event.target.value)}
        />
      ) : null}
      <fieldset className="pd-webhook-events">
        <legend>{t("Tell it when")}</legend>
        <div className="pd-webhook-events__list">
          {Object.entries(labels).map(([value, label]) => (
            <CheckboxField
              key={value}
              label={label}
              checked={events.includes(value)}
              onChange={on => toggle(value, on)}
            />
          ))}
        </div>
      </fieldset>
      <SwitchField
        label={t("Include pages only some people can read. Their titles and comments go to wherever this sends.")}
        checked={includeRestricted}
        onChange={setIncludeRestricted}
      />
    </FormDialog>
  );
}

function DeliveriesDialog({ hook, onClose }: { hook: Webhook; onClose: () => void }) {
  const deliveries = useLoaded(() => api.get<Delivery[]>(`webhooks/${hook.id}/deliveries`), [hook.id]);
  const retry = async (id: string) => {
    try {
      await api.send("POST", `webhooks/${hook.id}/deliveries/${id}/retry`);
      deliveries.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const statusText = { pending: t("Waiting"), delivered: t("Sent"), failed: t("Failed") };
  return (
    <Dialog wide title={t("What {0} has been sent", hook.name)} onClose={onClose}>
      <LoadedContent loaded={deliveries}>
        {data =>
          data.length === 0 ? (
            <EmptyState>{t("Nothing yet.")}</EmptyState>
          ) : (
            <table className="pd-table">
              <thead>
                <tr>
                  <th>{t("Event")}</th>
                  <th>{t("Result")}</th>
                  <th>{t("When")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map(item => (
                  <tr key={item.id}>
                    <td>{eventLabels()[item.event] ?? item.event}</td>
                    <td>
                      <span
                        className={
                          item.status === "delivered"
                            ? "pd-status pd-status--done"
                            : item.status === "failed"
                              ? "pd-status pd-status--failed"
                              : "pd-status"
                        }
                      >
                        {statusText[item.status]}
                      </span>
                      {item.error ? <div className="pd-table__note">{item.error}</div> : null}
                    </td>
                    <td className="pd-table__nowrap">{relativeTime(item.createdAt)}</td>
                    <td className="pd-table__actions">
                      {item.status === "failed" ? (
                        <Button variant="outline" size="sm" onClick={() => void retry(item.id)}>
                          {t("Send again")}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </LoadedContent>
    </Dialog>
  );
}

/** Sending things elsewhere: to a chat for people, or to a program as signed JSON. It only goes out; nothing comes back from a chat. */
export function WebhooksView({ space }: { space?: Space }) {
  const base = space ? `spaces/${space.slug}/webhooks` : "webhooks";
  const hooks = useLoaded(() => api.get<Webhook[]>(base), [base]);
  const [editing, setEditing] = React.useState<Webhook | "new" | null>(null);
  const [viewing, setViewing] = React.useState<Webhook | null>(null);
  const test = async (hook: Webhook) => {
    try {
      const result = await api.send<{ ok: boolean; error: string | null }>("POST", `webhooks/${hook.id}/test`);
      toast(
        result.ok ? t("Sent. Check that it arrived.") : (result.error ?? t("It could not be sent")),
        result.ok ? "success" : "error"
      );
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const switchOn = async (hook: Webhook, enabled: boolean) => {
    try {
      await api.send("PATCH", `webhooks/${hook.id}`, { body: { enabled } });
      hooks.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const remove = async (hook: Webhook) => {
    if (
      !(await confirm({
        title: t('Delete the webhook "{0}"?', hook.name),
        description: t("It stops at once, and what it has sent is forgotten."),
        action: t("Delete"),
        danger: true
      }))
    )
      return;
    try {
      await api.send("DELETE", `webhooks/${hook.id}`);
      hooks.reload();
    } catch (error) {
      toast(failureMessage(error), "error");
    }
  };
  const statusOf = (hook: Webhook) => {
    if (!hook.enabled)
      return (
        <span className="pd-status pd-status--failed">
          {hook.consecutiveFailures > 0 ? t("Off after repeated failures") : t("Off")}
        </span>
      );
    if (hook.lastStatus === "failed")
      return (
        <span className="pd-status pd-status--failed">{t("Failing, {0} in a row", hook.consecutiveFailures)}</span>
      );
    return (
      <span className="pd-status pd-status--done">
        {hook.lastDeliveredAt ? t("Last sent {0}", relativeTime(hook.lastDeliveredAt)) : t("Nothing sent yet")}
      </span>
    );
  };
  return (
    <>
      <ManageHead
        title={t("Webhooks")}
        description={
          space
            ? t("Tell a chat or another system what happens in this space.")
            : t("Tell a chat or another system what happens anywhere on this site.")
        }
      >
        <Button onClick={() => setEditing("new")}>{t("New webhook")}</Button>
      </ManageHead>
      <LoadedContent loaded={hooks}>
        {data =>
          data.length === 0 ? (
            <EmptyState>{t("No webhooks yet.")}</EmptyState>
          ) : (
            <table className="pd-table">
              <thead>
                <tr>
                  <th>{t("Name")}</th>
                  <th>{t("Sends to")}</th>
                  <th>{t("Status")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map(hook => (
                  <tr key={hook.id}>
                    <td>
                      {hook.name}
                      <div className="pd-table__note">{hook.url}</div>
                    </td>
                    <td className="pd-table__nowrap">
                      {kinds().find(item => item.value === hook.kind)?.label ?? hook.kind}
                    </td>
                    <td>{statusOf(hook)}</td>
                    <td className="pd-table__actions">
                      <Button variant="outline" size="sm" onClick={() => void test(hook)}>
                        {t("Send a test")}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setViewing(hook)}>
                        {t("Log")}
                      </Button>
                      <Menu.Root>
                        <Menu.Trigger
                          className="pd-icon-button pd-icon-button--small"
                          aria-label={t("Actions for {0}", hook.name)}
                        >
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </Menu.Trigger>
                        <Menu.Content align="end" sideOffset={4}>
                          <Menu.Item onClick={() => setEditing(hook)}>{t("Edit")}</Menu.Item>
                          <Menu.Item onClick={() => void switchOn(hook, !hook.enabled)}>
                            {hook.enabled ? t("Turn off") : t("Turn on")}
                          </Menu.Item>
                          <Menu.Item onClick={() => void remove(hook)}>{t("Delete")}</Menu.Item>
                        </Menu.Content>
                      </Menu.Root>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </LoadedContent>
      {editing ? (
        <HookDialog
          base={base}
          hook={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            hooks.reload();
          }}
        />
      ) : null}
      {viewing ? <DeliveriesDialog hook={viewing} onClose={() => setViewing(null)} /> : null}
    </>
  );
}
