// @vitest-environment happy-dom
import * as React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBootstrap } from "../src/data/bootstrap";
import { termsInMarkdown } from "../src/manage/glossary-view";
import { bootstrap, entry, space } from "./support";

const DRAFT = {
  documentId: "guide",
  lang: "",
  title: "指南",
  path: "guide",
  spaceSlug: "handbook",
  spaceName: "手册",
  updatedAt: "2026-11-06T08:00:00.000Z"
};

function respond(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return stored.size;
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key)
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("embed apps", () => {
  const HELPDESK = {
    slug: "helpdesk",
    name: "服务台",
    allowedOrigins: ["https://helpdesk.example.com"],
    status: "active",
    lastUsedAt: null,
    group: "embed:helpdesk"
  };

  it("shows who may embed, and what to add to a space for them to see it", async () => {
    const { EmbedAppsView } = await import("../src/manage/embed-view");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond([HELPDESK]))
    );
    render(<EmbedAppsView />);
    expect(await screen.findByText("服务台")).toBeTruthy();
    expect(screen.getByText("https://helpdesk.example.com")).toBeTruthy();
    expect(screen.getByText("embed:helpdesk")).toBeTruthy();
  });

  it("shows a new secret once, after adding", async () => {
    const { EmbedAppsView } = await import("../src/manage/embed-view");
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "POST") {
          sent.push(JSON.parse(String(init.body)));
          return respond({ app: HELPDESK, secret: "pda_shown_once" });
        }
        return respond(sent.length > 0 ? [HELPDESK] : []);
      })
    );
    render(<EmbedAppsView />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "添加应用" }));
    const add = screen.getByRole("button", { name: "添加" });
    await user.click(add);
    expect(screen.getAllByText("必填")).toHaveLength(2);
    expect(sent).toEqual([]);
    await user.type(screen.getByLabelText("名字"), "服务台");
    await user.type(screen.getByLabelText(/标识/u), "helpdesk");
    await user.type(screen.getByLabelText(/允许嵌入的网站/u), "https://helpdesk.example.com");
    await user.click(add);
    expect(await screen.findByText("pda_shown_once")).toBeTruthy();
    expect(sent).toEqual([{ name: "服务台", slug: "helpdesk", allowedOrigins: ["https://helpdesk.example.com"] }]);
    await user.click(screen.getByRole("button", { name: "我已保存" }));
    await waitFor(() => expect(screen.queryByText("pda_shown_once")).toBeNull());
  });
});

describe("terms from a page", () => {
  it("reads tables as term and explanation, and leaves out headers and half-filled rows", () => {
    const markdown =
      "说明\n\n| 术语 | 解释 | 备注 |\n| --- | --- | --- |\n| 项目 | 团队的**日常**项目 | 无 |\n| 空的 |  |  |\n\n# 另一张\n\n| 词 | 意思 |\n| --- | --- |\n| `EA` | 企业账号 |\n";
    expect(termsInMarkdown(markdown)).toEqual([
      { term: "项目", definition: "团队的日常项目" },
      { term: "EA", definition: "企业账号" }
    ]);
    expect(termsInMarkdown("没有表格\n")).toEqual([]);
  });

  it("adds what is new to the list, and saving is still a separate step", async () => {
    const handbook = {
      ...space("handbook", [entry("terms")]),
      role: "admin" as const,
      glossary: [{ term: "项目", definition: "已有的解释" }]
    };
    applyBootstrap(bootstrap({ spaces: [handbook] }));
    const { GlossaryView } = await import("../src/manage/glossary-view");
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        asked.push(`${init.method ?? "GET"} ${url}`);
        if (url.endsWith("/tree")) return respond([entry("terms", { title: "术语页" })]);
        return respond({ markdown: "| 术语 | 解释 |\n| --- | --- |\n| 项目 | 新解释 |\n| 书脊 | 企业环境 |\n" });
      })
    );
    render(<GlossaryView space={handbook as never} />);
    await waitFor(() => expect(asked.some(line => line.endsWith("/tree"))).toBe(true));
    await userEvent.click(screen.getByLabelText("从页面的表格导入"));
    await userEvent.click(await screen.findByRole("option", { name: "术语页" }));
    await userEvent.click(screen.getByRole("button", { name: "导入" }));
    await waitFor(() =>
      expect((screen.getAllByRole("textbox") as HTMLInputElement[]).some(box => box.value === "书脊")).toBe(true)
    );
    const values = (screen.getAllByRole("textbox") as HTMLInputElement[]).map(box => box.value);
    expect(values).toContain("已有的解释");
    expect(values).not.toContain("新解释");
    expect(asked.some(line => line.startsWith("PATCH"))).toBe(false);
  });
});

describe("adding a member", () => {
  it("finds someone as you type, grants the role chosen, and is ready for the next", async () => {
    const { MemberEditor } = await import("../src/manage/member-editor");
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "PUT") {
          sent.push(JSON.parse(String(init.body)));
          return respond({});
        }
        return respond(url.includes("directory") ? [{ id: "u1", name: "唐宁" }] : []);
      })
    );
    render(<MemberEditor path="spaces/handbook/members" />);
    const search = (await screen.findByRole("combobox", { name: "添加成员" })) as HTMLInputElement;
    await userEvent.type(search, "唐");
    await userEvent.click(await screen.findByRole("option", { name: "唐宁" }));
    await waitFor(() => expect(sent).toEqual([{ subject: "user:u1", role: "viewer" }]));
    await waitFor(() => expect(search.value).toBe(""));
  });
});

describe("my drafts", () => {
  it("lists what is on the server and what only this computer has", async () => {
    applyBootstrap(
      bootstrap({
        spaces: [space("handbook", [entry("guide", { title: "指南" }), entry("offline", { title: "没联网时写的" })])]
      })
    );
    localStorage.setItem(
      "pandocs:draft:me:offline:",
      JSON.stringify({ markdown: "写到一半", baseRevision: 1, updatedAt: "2026-11-06T09:00:00.000Z" })
    );
    localStorage.setItem(
      "pandocs:draft:someone:other:",
      JSON.stringify({ markdown: "别人的", baseRevision: 1, updatedAt: "2026-11-06T09:00:00.000Z" })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond([DRAFT]))
    );
    const { DraftsView } = await import("../src/manage/drafts-view");
    render(
      <MemoryRouter>
        <DraftsView />
      </MemoryRouter>
    );
    expect((await screen.findByRole("link", { name: "指南" })).getAttribute("href")).toContain(
      "/handbook/guide?mode=edit"
    );
    expect(screen.getByRole("link", { name: "没联网时写的" })).toBeTruthy();
    expect(screen.getByText(/只在这台电脑上/u)).toBeTruthy();
    expect(screen.queryByText("别人的")).toBeNull();
  });
});

describe("publishing an import", () => {
  const JOB = {
    id: "job1",
    filename: "returns.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    route: "document-extract",
    persist: "draft",
    status: "succeeded",
    errorMessage: null,
    draftMarkdown: "先登记。",
    draftTitle: "退货流程",
    documentId: null,
    proposalId: null,
    target: { parentPath: "guides", slug: "returns-v2" },
    createdName: "测试用户",
    createdAt: "2026-11-10T08:00:00.000Z",
    report: {}
  };

  it("starts from where the import asked to go, and publishes to what the form shows", async () => {
    applyBootstrap(bootstrap());
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (init.method === "POST") {
          sent.push(JSON.parse(String(init.body)));
          return respond(JOB);
        }
        if (url.includes("/tree")) return respond([entry("guides", { title: "指南" })]);
        return respond(url.includes("/imports") ? [JOB] : []);
      })
    );
    const { ImportsView } = await import("../src/manage/imports-view");
    render(
      <MemoryRouter>
        <ImportsView space={space("handbook", [])} />
      </MemoryRouter>
    );
    await userEvent.click(await screen.findByRole("button", { name: /returns\.docx/u }));
    const detail = within(screen.getByRole("region", { name: "导入详情" }));
    await waitFor(() => expect(detail.getByLabelText("放在").textContent).toContain("指南"));
    expect((detail.getByRole("textbox", { name: "地址（可选）" }) as HTMLInputElement).value).toBe("returns-v2");
    await userEvent.click(detail.getByRole("button", { name: "发布" }));
    await waitFor(() => expect(sent).toEqual([{ title: "退货流程", parentPath: "guides", slug: "returns-v2" }]));
  });
});
