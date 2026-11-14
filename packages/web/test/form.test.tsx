// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/client";
import { CheckboxField, Form, SearchSelect, SelectField, SwitchField, TextField } from "../src/ui/form";

afterEach(cleanup);

function Example({
  onSubmit,
  fieldFor
}: {
  onSubmit: () => void | Promise<void>;
  fieldFor?: (error: ApiError) => string | undefined;
}) {
  const [title, setTitle] = React.useState("");
  const [email, setEmail] = React.useState("");
  return (
    <Form onSubmit={onSubmit} {...(fieldFor ? { fieldFor } : {})}>
      <TextField name="title" label="标题" required value={title} onChange={event => setTitle(event.target.value)} />
      <TextField
        name="email"
        label="邮箱"
        type="email"
        value={email}
        onChange={event => setEmail(event.target.value)}
      />
      <button type="submit">提交</button>
    </Form>
  );
}

describe("a form", () => {
  it("says what is missing next to the field, and does not ask the server", async () => {
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(screen.getByText("必填")).toBeTruthy();
    expect(screen.getByLabelText("标题").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("标题"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not take spaces for an answer", async () => {
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("标题"), "   {Enter}");
    expect(screen.getByText("必填")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears a problem once the field changes, and Enter submits", async () => {
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    await userEvent.click(screen.getByRole("button", { name: "提交" }));
    await userEvent.type(screen.getByLabelText("标题"), "新页面");
    expect(screen.queryByText("必填")).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("checks what a field's type says", async () => {
    const onSubmit = vi.fn();
    render(<Example onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("标题"), "页面");
    await userEvent.type(screen.getByLabelText("邮箱"), "不是邮箱{Enter}");
    expect(screen.getByText("请输入邮箱地址")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("puts what the server found next to the field it is about", async () => {
    render(
      <Example
        onSubmit={() => {
          throw new ApiError(422, "INPUT_INVALID", "请求不正确", [{ path: ["email"], message: "这个邮箱不能用" }]);
        }}
      />
    );
    await userEvent.type(screen.getByLabelText("标题"), "页面{Enter}");
    expect(await screen.findByText("这个邮箱不能用")).toBeTruthy();
    expect(screen.getByLabelText("邮箱").getAttribute("aria-invalid")).toBe("true");
  });

  it("knows which field an answer is about when the caller says", async () => {
    render(
      <Example
        fieldFor={error => (error.code === "TAKEN" ? "title" : undefined)}
        onSubmit={() => {
          throw new ApiError(409, "TAKEN", "这个标题已经有了");
        }}
      />
    );
    await userEvent.type(screen.getByLabelText("标题"), "页面{Enter}");
    expect(await screen.findByText("这个标题已经有了")).toBeTruthy();
    expect(screen.getByLabelText("标题").getAttribute("aria-invalid")).toBe("true");
  });

  it("only submits once while it is still working", async () => {
    let finish = () => undefined as void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    render(<Example onSubmit={onSubmit} />);
    await userEvent.type(screen.getByLabelText("标题"), "页面{Enter}{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    finish();
    await waitFor(() => undefined);
  });
});

describe("fields", () => {
  it("names a switch by its label, and the label works it", async () => {
    const onChange = vi.fn();
    render(<SwitchField label="公开" checked={false} onChange={onChange} />);
    expect(screen.getByRole("switch", { name: "公开" })).toBeTruthy();
    await userEvent.click(screen.getByText("公开"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("names a checkbox by its label, and the label works it", async () => {
    const onChange = vi.fn();
    render(<CheckboxField label="这个页面" checked={false} onChange={onChange} />);
    expect(screen.getByRole("checkbox", { name: "这个页面" })).toBeTruthy();
    await userEvent.click(screen.getByText("这个页面"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("offers what a dropdown lists, under the label's name", async () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="权限"
        value="a"
        onChange={onChange}
        choices={[
          { value: "a", label: "可阅读" },
          { value: "b", label: "可编辑" }
        ]}
      />
    );
    const dropdown = screen.getByRole("combobox", { name: "权限" });
    expect(dropdown.textContent).toContain("可阅读");
    await userEvent.click(dropdown);
    await userEvent.click(await screen.findByRole("option", { name: "可编辑" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("narrows a long list down to what is typed", async () => {
    const onChange = vi.fn();
    render(
      <SearchSelect
        label="页面"
        value="a"
        onChange={onChange}
        choices={[
          { value: "a", label: "快速开始" },
          { value: "b", label: "权限", depth: 1 }
        ]}
      />
    );
    await userEvent.click(
      screen.getByRole("combobox", { name: "页面" }).closest("button") ?? screen.getByLabelText("页面")
    );
    await userEvent.type(await screen.findByRole("combobox", { name: "搜索" }), "权");
    await waitFor(() => expect(screen.queryByRole("option", { name: "快速开始" })).toBeNull());
    await userEvent.click(screen.getByRole("option", { name: "权限" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("a filter", () => {
  it("goes back to everything, though that one's value is empty", async () => {
    const { Filter } = await import("../src/ui/filter");
    function Example() {
      const [value, setValue] = React.useState("page");
      return (
        <>
          <Filter
            label="类型"
            value={value}
            items={[
              { value: "", label: "全部" },
              { value: "page", label: "页面" }
            ]}
            onChange={setValue}
          />
          <output>{value || "全部"}</output>
        </>
      );
    }
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "全部" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("全部"));
    expect(screen.getByRole("button", { name: "全部" }).getAttribute("aria-pressed")).toBe("true");
  });
});
