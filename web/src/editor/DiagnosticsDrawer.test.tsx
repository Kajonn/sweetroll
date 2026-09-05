import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DocumentAssessment } from "../api/server.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";

function assessmentWith(
  diagnostics: DocumentAssessment["diagnostics"],
): DocumentAssessment {
  return { ok: diagnostics.length === 0, diagnostics };
}

describe("DiagnosticsDrawer", () => {
  it("renders the drawer header with a diagnostics count", () => {
    render(
      <DiagnosticsDrawer
        assessment={assessmentWith([
          { code: "missing_field", path: "/entities/char/fields/0", message: "Field is required" },
          { code: "invalid_expression", path: "/expressions/2", message: "Unexpected token" },
        ])}
      />,
    );
    expect(screen.getByTestId("diagnostics-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-drawer-title")).toHaveTextContent(/Diagnostics/);
    expect(screen.getByTestId("diagnostics-drawer-count")).toHaveTextContent(/2/);
  });

  it("renders each diagnostic with the correct code and message", () => {
    render(
      <DiagnosticsDrawer
        assessment={assessmentWith([
          {
            code: "missing_field",
            path: "/entities/char/fields/0",
            message: "Field is required",
          },
          {
            code: "invalid_expression",
            path: "/expressions/2",
            message: "Unexpected token",
          },
          { code: "duplicate_id", path: "/entities/char", message: "ID already used" },
        ])}
      />,
    );
    const items = screen.getAllByTestId(/^diagnostic-item-/);
    expect(items).toHaveLength(3);
    expect(screen.getByTestId("diagnostic-code-missing_field")).toHaveTextContent("missing_field");
    expect(screen.getByTestId("diagnostic-message-missing_field")).toHaveTextContent(
      "Field is required",
    );
    expect(screen.getByTestId("diagnostic-code-invalid_expression")).toHaveTextContent(
      "invalid_expression",
    );
    expect(screen.getByTestId("diagnostic-message-invalid_expression")).toHaveTextContent(
      "Unexpected token",
    );
    expect(screen.getByTestId("diagnostic-code-duplicate_id")).toHaveTextContent("duplicate_id");
  });

  it("renders one Jump to button per diagnostic", () => {
    render(
      <DiagnosticsDrawer
        assessment={assessmentWith([
          { code: "missing_field", path: "/entities/char/fields/0", message: "Field is required" },
          { code: "invalid_expression", path: "/expressions/2", message: "Unexpected token" },
        ])}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: /Jump to/i });
    expect(buttons).toHaveLength(2);
  });

  it("dispatches a focus-editor:{path} event when Jump to is clicked", async () => {
    const user = userEvent.setup();
    const target = window;
    const listener = vi.fn();
    target.addEventListener("focus-editor:/entities/char/fields/0", listener as EventListener);
    render(
      <DiagnosticsDrawer
        assessment={assessmentWith([
          {
            code: "missing_field",
            path: "/entities/char/fields/0",
            message: "Field is required",
          },
        ])}
      />,
    );
    await user.click(screen.getByTestId("diagnostic-jump-/entities/char/fields/0"));
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0] as CustomEvent | undefined;
    expect(event).toBeDefined();
    expect(event?.type).toBe("focus-editor:/entities/char/fields/0");
    target.removeEventListener("focus-editor:/entities/char/fields/0", listener as EventListener);
  });

  it("uses different event names per diagnostic path", async () => {
    const user = userEvent.setup();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    window.addEventListener("focus-editor:/entities/char/fields/0", firstListener as EventListener);
    window.addEventListener("focus-editor:/expressions/2", secondListener as EventListener);
    render(
      <DiagnosticsDrawer
        assessment={assessmentWith([
          {
            code: "missing_field",
            path: "/entities/char/fields/0",
            message: "Field is required",
          },
          {
            code: "invalid_expression",
            path: "/expressions/2",
            message: "Unexpected token",
          },
        ])}
      />,
    );
    await user.click(screen.getByTestId("diagnostic-jump-/entities/char/fields/0"));
    await user.click(screen.getByTestId("diagnostic-jump-/expressions/2"));
    expect(firstListener).toHaveBeenCalledTimes(1);
    expect(secondListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(
      "focus-editor:/entities/char/fields/0",
      firstListener as EventListener,
    );
    window.removeEventListener("focus-editor:/expressions/2", secondListener as EventListener);
  });

  it("shows an empty state when there are no diagnostics", () => {
    render(<DiagnosticsDrawer assessment={assessmentWith([])} />);
    expect(screen.getByTestId("diagnostics-drawer-empty")).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-drawer-count")).toHaveTextContent(/0/);
  });

  it("uses a stable drawer data-testid for the parent container", () => {
    render(<DiagnosticsDrawer assessment={assessmentWith([])} />);
    expect(screen.getByTestId("diagnostics-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-drawer-count")).toHaveTextContent(/0/);
  });
});