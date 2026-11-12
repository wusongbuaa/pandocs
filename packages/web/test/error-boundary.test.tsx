// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/ui/error-boundary";

function Broken(): never {
  throw new Error("cannot draw this");
}

describe("a part of a page that cannot be drawn", () => {
  afterEach(cleanup);

  it("gives way to what stands in for it, and leaves the rest of the page alone", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <main>
        <p>The text being read</p>
        <ErrorBoundary area="A panel" fallback={<p>The panel could not be shown</p>}><Broken /></ErrorBoundary>
      </main>
    );
    expect(screen.getByText("The text being read")).toBeTruthy();
    expect(screen.getByText("The panel could not be shown")).toBeTruthy();
    expect(quiet.mock.calls.some(call => String(call[0]).includes("A panel could not be shown"))).toBe(true);
    quiet.mockRestore();
  });
});
