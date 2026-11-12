import * as React from "react";
import { routePathToMdPath, useI18n, usePageData, useSite } from "@rspress/core/runtime";
import { copyToClipboard, IconDown, IconLink, SvgWrapper } from "@rspress/core/theme-original";
import { Menu } from "../ui/menu";
import { t } from "../i18n";

type Option =
  | string
  | { readonly title: string; readonly icon?: React.ReactNode; readonly onClick?: () => void; readonly href?: string };

interface Item {
  readonly title: string;
  readonly icon?: React.ReactNode;
  readonly onClick?: (() => void) | undefined;
  readonly href?: string | undefined;
}

/**
 * What a page offers besides reading it, from the setting the theme's own menu reads. That one is a button with the
 * menu inside it, which a keyboard cannot open or move through, and which a screen reader hears as a button with no
 * name. This is a menu, in the same look.
 */
export function PageMenu() {
  const { site } = useSite();
  const { page } = usePageData();
  const themeText = useI18n();
  const llmsUI = site.themeConfig?.llmsUI;
  const options = (
    typeof llmsUI === "object" && Array.isArray(llmsUI.viewOptions) ? llmsUI.viewOptions : []
  ) as readonly Option[];
  const items = options.flatMap((option): Item[] => {
    if (option === "markdownLink") {
      return [
        {
          title: themeText("copyMarkdownLinkText"),
          icon: <SvgWrapper icon={IconLink} />,
          onClick: () => void copyToClipboard(new URL(routePathToMdPath(page.routePath), location.origin).toString())
        }
      ];
    }
    return typeof option === "object" && option.title && (option.onClick || option.href) ? [option] : [];
  });
  if (items.length === 0) return null;
  const inside = (item: Item) => (
    <>
      <span className="rp-llms-view-options__item-icon">{item.icon}</span>
      {item.title}
    </>
  );
  return (
    <Menu.Root>
      <Menu.Trigger className="rp-llms-button rp-llms-view-options__trigger" aria-label={t("More for this page")}>
        <SvgWrapper icon={IconDown} className="rp-llms-view-options__arrow" />
      </Menu.Trigger>
      <Menu.Content align="start" sideOffset={6} className="pd-page-menu">
        {items.map(item =>
          item.href ? (
            <Menu.LinkItem key={item.title} href={item.href} target="_blank" rel="noopener noreferrer">
              {inside(item)}
            </Menu.LinkItem>
          ) : (
            <Menu.Item key={item.title} onClick={item.onClick}>
              {inside(item)}
            </Menu.Item>
          )
        )}
      </Menu.Content>
    </Menu.Root>
  );
}
