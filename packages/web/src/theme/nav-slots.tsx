import * as React from "react";
import { Menu } from "../ui/menu";
import { Grip } from "lucide-react";
import { useLocation, useNavigate } from "@rspress/core/runtime";
import { canManage, manageRoute } from "../data/manage";
import { pageUrl } from "../data/paths";
import { app } from "../data/runtime-data";
import { toast } from "../ui/toast";
import { PersonMark } from "../ui/avatar";
import { NavInbox } from "./inbox";
import { askToSignIn, isVisitor, loginPageFor } from "./sign-in";
import { t } from "../i18n";

/** The grid left of the logo on the official site; here it leads to the applications next to this one. */
export function AppSwitch() {
  const links = app.bootstrap.site.appLinks;
  if (links.length === 0) return null;
  return (
    <Menu.Root>
      <Menu.Trigger className="pd-app-switch" aria-label={t("Switch apps")}>
        <Grip size={20} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Content align="start" sideOffset={8}>
        {links.map(link => (
          <Menu.LinkItem key={link.link} href={link.link}>
            {link.text}
          </Menu.LinkItem>
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}

/** The host ends the session; coming back to the page sends the person to its login. */
async function signOut(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}"
  }).catch(() => null);
  if (response?.ok) location.reload();
  else toast(t("Could not sign out. Please try again."), "error");
}

/** A plain click signs in over the page. The address still works in a new tab, and where there is no dialog to open. */
function SignIn() {
  const { pathname, search } = useLocation();
  const open = (event: React.MouseEvent) => {
    if (!isVisitor() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    askToSignIn();
  };
  return (
    <a className="pd-btn" href={loginPageFor(pageUrl(`${pathname}${search}`))} onClick={open}>
      {t("Sign in")}
    </a>
  );
}

export function NavAccount() {
  const {
    me,
    site: { logoutUrl }
  } = app.bootstrap;
  const navigate = useNavigate();
  if (me.anonymous)
    return (
      <div className="pd-nav-account">
        <SignIn />
      </div>
    );
  return (
    <div className="pd-nav-account">
      <NavInbox />
      <Menu.Root>
        <Menu.Trigger
          className="pd-avatar pd-avatar--nav"
          title={me.displayName}
          aria-label={t("Account menu of {0}", me.displayName)}
        >
          <PersonMark id={me.id} size={28} />
        </Menu.Trigger>
        <Menu.Content align="end" sideOffset={10}>
          <div className="pd-nav-menu-name">{me.displayName}</div>
          <Menu.Item onClick={() => navigate(manageRoute("inbox"))}>{t("Notifications")}</Menu.Item>
          {canManage(app.bootstrap) ? (
            <Menu.Item onClick={() => navigate(manageRoute("spaces"))}>{t("Manage documents")}</Menu.Item>
          ) : null}
          <Menu.Item onClick={() => navigate(manageRoute("drafts"))}>{t("My drafts")}</Menu.Item>
          <Menu.Item onClick={() => navigate(manageRoute("account"))}>{t("Account and tokens")}</Menu.Item>
          {me.isAdmin ? (
            <Menu.Item onClick={() => navigate(manageRoute("site"))}>{t("Site settings")}</Menu.Item>
          ) : null}
          {logoutUrl ? <Menu.Item onClick={() => void signOut(logoutUrl)}>{t("Sign out")}</Menu.Item> : null}
        </Menu.Content>
      </Menu.Root>
    </div>
  );
}
