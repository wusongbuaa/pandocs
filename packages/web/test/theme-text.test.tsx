// @vitest-environment happy-dom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { applyBootstrap } from "../src/data/bootstrap";
import { renderHtmlOrText, renderInlineMarkdown } from "../src/theme/text";
import { renderInlineMarkdown as vendorInlineMarkdown } from "../vendor/rspress/theme/logic/utils";
import { bootstrap } from "./support";

afterEach(cleanup);

const PAYLOADS = [
  '<img src=x onerror="window.__xss=1"/>',
  '标题<img src=x onerror="window.__xss=1"/>',
  '<b onmouseover="window.__xss=1">x</b>',
  "<script>window.__xss=1</script>",
  '<a href="javascript:window.__xss=1">x</a>',
  '<svg onload="window.__xss=1"></svg>',
  '&lt;img src=x onerror="window.__xss=1"/&gt;',
  '`a` <img src=x onerror="window.__xss=1"/> `b`',
  '\\`<img src=x onerror="window.__xss=1"/>\\`',
  '`` ` <img src=x onerror="window.__xss=1"/> `',
  '**<img src=x onerror="window.__xss=1"/>**',
  '<code onclick="window.__xss=1">x</code>',
  '\u0000<img src=x onerror="window.__xss=1"/>\u00000\u0000'
];

function parsed(html: string): Element {
  const box = document.createElement("div");
  box.innerHTML = html;
  return box;
}

const htmlOf = (result: ReturnType<typeof renderInlineMarkdown>) => result.dangerouslySetInnerHTML.__html;

describe("text on its way to the theme", () => {
  it.each(PAYLOADS)("cannot become markup: %s", payload => {
    const box = parsed(htmlOf(renderInlineMarkdown(payload)));
    for (const element of box.querySelectorAll("*")) {
      expect(["STRONG", "EM", "DEL", "CODE"]).toContain(element.tagName);
      expect(element.attributes).toHaveLength(0);
    }
    expect(renderHtmlOrText(payload)).toEqual({ children: payload });
  });

  it("shows the words someone typed, angle brackets included", () => {
    expect(parsed(htmlOf(renderInlineMarkdown("标题<b>粗</b>"))).textContent).toBe("标题<b>粗</b>");
    expect(parsed(htmlOf(renderInlineMarkdown("A & B &amp; C"))).textContent).toBe("A & B &amp; C");
    expect(parsed(htmlOf(renderInlineMarkdown("泛型 Array<string>"))).textContent).toBe("泛型 Array<string>");
  });

  it.each([
    "普通文字",
    "A & B",
    "**粗** 和 *斜* 和 ~~删~~",
    "`code` 和 `a<b`",
    "`` a`b ``",
    "\\*不是斜体\\*",
    "没有闭合的 ` 反引号",
    "**`粗体里的代码`**"
  ])("formats ordinary text exactly as the theme does: %s", text => {
    expect(htmlOf(renderInlineMarkdown(text))).toBe(vendorInlineMarkdown(text).dangerouslySetInnerHTML.__html);
  });

  it("treats everything as text where the theme would have allowed HTML", () => {
    expect(renderHtmlOrText("A &amp; B")).toEqual({ children: "A &amp; B" });
    expect(renderHtmlOrText(3)).toEqual({ children: "3" });
    expect(renderHtmlOrText("")).toEqual({ children: null });
    expect(renderHtmlOrText(undefined)).toEqual({ children: null });
  });
});

describe("the theme's own components", () => {
  const XSS = '<img src=x onerror="window.__xss=1"/>';

  /** The theme captures its site data when it loads, so nothing imports it before this. */
  async function loadTheme() {
    applyBootstrap(bootstrap());
    const [{ PageContext }, theme] = await Promise.all([
      import("@rspress/core/runtime"),
      import("@rspress/core/theme")
    ]);
    return { PageContext, theme };
  }

  it("get their text from the functions here, through the entry they all import", async () => {
    const { theme } = await loadTheme();
    expect(theme.renderInlineMarkdown).toBe(renderInlineMarkdown);
    expect(theme.renderHtmlOrText).toBe(renderHtmlOrText);
  });

  it("show a hostile title as text", async () => {
    const {
      PageContext,
      theme: { FallbackHeading }
    } = await loadTheme();
    const { container } = render(
      <MemoryRouter>
        <PageContext.Provider value={{ data: { frontmatter: {}, lang: "zh" } as never }}>
          <FallbackHeading level={1} title={`标题${XSS}`} />
        </PageContext.Provider>
      </MemoryRouter>
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(XSS);
  });

  it("show hostile home page text as text", async () => {
    const {
      PageContext,
      theme: { HomeHero }
    } = await loadTheme();
    const data = {
      frontmatter: {
        hero: { name: XSS, text: XSS, tagline: XSS, actions: [{ theme: "brand", text: XSS, link: "/a" }] }
      }
    } as never;
    const { container } = render(
      <MemoryRouter>
        <PageContext.Provider value={{ data }}>
          <HomeHero />
        </PageContext.Provider>
      </MemoryRouter>
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(XSS);
  });

  describe("the outline", () => {
    async function renderOutline(
      toc: readonly { id: string; text: string; depth: number }[],
      headings: React.ReactNode
    ) {
      const {
        PageContext,
        theme: { Toc, useWatchToc }
      } = await loadTheme();
      function Page() {
        const { rspressDocRef } = useWatchToc();
        return (
          <div ref={rspressDocRef} className="rspress-doc">
            {headings}
            <nav>
              <Toc />
            </nav>
          </div>
        );
      }
      const data = { frontmatter: {}, toc } as never;
      const { container } = render(
        <MemoryRouter>
          <PageContext.Provider value={{ data }}>
            <Page />
          </PageContext.Provider>
        </MemoryRouter>
      );
      return container.querySelector("nav")!;
    }

    it("keeps the formatting of a heading, from the document's text rather than the page's HTML", async () => {
      const nav = await renderOutline(
        [{ id: "a", text: "`x` 和 **粗**", depth: 2 }],
        <h2 id="a" className="rp-toc-include">
          <code>x</code> 和 <strong>粗</strong>
        </h2>
      );
      await waitFor(() => expect(nav.querySelector("code")?.textContent).toBe("x"));
      expect(nav.querySelector("strong")?.textContent).toBe("粗");
    });

    it("shows a hostile heading as text, however the outline was collected", async () => {
      const nav = await renderOutline(
        [{ id: "a", text: XSS, depth: 2 }],
        <h2 id="a" className="rp-toc-include">
          {XSS}
        </h2>
      );
      await waitFor(() => expect(nav.textContent).toContain(XSS));
      expect(nav.querySelector("img")).toBeNull();
    });

    it("shows a heading the document's outline does not list, without its markup", async () => {
      const nav = await renderOutline(
        [],
        <h2 id="a" className="rp-toc-include">
          <b>{XSS}</b>
        </h2>
      );
      await waitFor(() => expect(nav.textContent).toContain(XSS));
      expect(nav.querySelector("img, b")).toBeNull();
    });

    it("leaves out what the page is not showing, like the theme does", async () => {
      const nav = await renderOutline(
        [
          { id: "a", text: "看得见", depth: 2 },
          { id: "b", text: "看不见", depth: 2 }
        ],
        <>
          <h2 id="a" className="rp-toc-include">
            看得见
          </h2>
          <h2 id="b" className="rp-toc-include" style={{ display: "none" }}>
            看不见
          </h2>
        </>
      );
      await waitFor(() => expect(nav.textContent).not.toContain("看不见"));
      expect(nav.textContent).toContain("看得见");
    });

    it("is empty on a view of the page without these headings, such as the editor", async () => {
      const nav = await renderOutline([{ id: "a", text: "正文的标题", depth: 2 }], <p>编辑器</p>);
      await waitFor(() => expect(nav.textContent).toBe(""));
    });
  });
});

describe("the theme's route to HTML", () => {
  const ROOT = join(import.meta.dirname, "../vendor/rspress/theme");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/u.test(name) ? [path] : [];
    });
  const relative = (path: string) => path.slice(ROOT.length + 1);

  it("goes through the entry we override, so no component can bypass it", () => {
    for (const path of files(ROOT).filter(file => !/logic\/utils\.tsx$|theme\/index\.ts$/u.test(file))) {
      const source = readFileSync(path, "utf8");
      for (const statement of source.match(
        /import\s*\{[^}]*\b(?:renderHtmlOrText|renderInlineMarkdown)\b[^}]*\}\s*from\s*'[^']+'/gu
      ) ?? []) {
        expect(statement, relative(path)).toContain("'@rspress/core/theme'");
      }
    }
  });

  it("has no other HTML sinks fed with page content; a new one has to be looked at", () => {
    const sinks = files(ROOT)
      .filter(
        file => /dangerouslySetInnerHTML=\{\{/u.test(readFileSync(file, "utf8")) && !file.endsWith("logic/utils.tsx")
      )
      .map(relative)
      .sort();
    expect(sinks).toEqual([
      // A static inline script, not used by any page here.
      "components/Banner/index.tsx",
      "components/PageTabs/index.tsx",
      // Icons from the theme's own list, by name.
      "components/SocialLinks/SocialLink.tsx",
      // Only strings starting with `<svg`; front matter has its angle brackets removed before it gets here.
      "components/SvgWrapper/index.tsx",
      "components/Tag/index.tsx"
    ]);
  });
});
