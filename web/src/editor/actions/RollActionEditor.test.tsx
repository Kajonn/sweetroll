import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../../api/client.js";
import { RollActionEditor, type RollActionV1 } from "./RollActionEditor.js";

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(responses: Array<() => Response>): ReturnType<typeof vi.fn> {
  let i = 0;
  return vi.fn(async () => {
    const resp = responses[i] ?? responses[responses.length - 1];
    if (resp === undefined) throw new Error("no response configured");
    i += 1;
    return resp();
  });
}

function emptySnapshotResponse(): Response {
  return new Response(
    JSON.stringify({
      snapshot: {
        snapshotId: "snap-1",
        systemId: "s1",
        sourceRevision: 5,
        package: { expressions: [] },
        expiresAt: "2026-01-01T00:00:00Z",
      },
      requestId: "r",
    }),
    { status: 200 },
  );
}

const defaultAction: RollActionV1 = {
  kind: "roll",
  id: "atk",
  label: "Attack",
  expressionId: "atk_expr",
  inputs: [],
  outputTemplate: "Result: {total}",
};

type RenderOptions = {
  fetch_?: ReturnType<typeof vi.fn>;
  action?: RollActionV1;
  expressionSource?: string;
  onExpressionSourceChange?: (next: string) => void;
};

function renderEditor(options: RenderOptions = {}) {
  const {
    fetch_ = setupFetch([emptySnapshotResponse]),
    action: initialAction = defaultAction,
    expressionSource = "",
    onExpressionSourceChange,
  } = options;
  const client: ApiClient = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  let currentAction: RollActionV1 = initialAction;
  const trackedOnChange = (next: RollActionV1) => {
    currentAction = next;
    onChange(next);
  };
  const view = render(
    <RollActionEditor
      client={client}
      systemId="s1"
      action={initialAction}
      onChange={trackedOnChange}
      expressionSource={expressionSource}
      onExpressionSourceChange={onExpressionSourceChange ?? vi.fn()}
      fieldTypes={{}}
    />,
    { wrapper: makeWrapper(qc) },
  );
  const applyChange = () => {
    view.rerender(
      <RollActionEditor
        client={client}
        systemId="s1"
        action={currentAction}
        onChange={trackedOnChange}
        expressionSource={expressionSource}
        onExpressionSourceChange={onExpressionSourceChange ?? vi.fn()}
        fieldTypes={{}}
      />,
    );
  };
  return { ...view, onChange, client, applyChange, current: () => currentAction };
}

function lastCallPayload(onChange: ReturnType<typeof vi.fn>): RollActionV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("RollActionEditor", () => {
  it("renders the label, expression id, output template, and Try it button", () => {
    renderEditor();
    expect(screen.getByTestId("roll-action-atk")).toBeInTheDocument();
    expect(screen.getByTestId("roll-action-label-atk")).toHaveValue("Attack");
    expect(screen.getByTestId("roll-action-expression-id-atk")).toHaveValue("atk_expr");
    expect(screen.getByTestId("roll-action-output-atk")).toHaveValue("Result: {total}");
    expect(screen.getByTestId("roll-action-try-atk")).toBeInTheDocument();
  });

  it("renders an empty-inputs marker when no inputs are declared", () => {
    renderEditor();
    expect(screen.getByTestId("roll-action-inputs-empty-atk")).toBeInTheDocument();
  });

  it("adds a new input when the Add button is clicked", () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByTestId("roll-action-inputs-add-atk"));
    const last = lastCallPayload(onChange);
    expect(last?.kind).toBe("roll");
    if (last?.kind === "roll") expect(last.inputs.length).toBe(1);
  });

  it("removes an input when its remove button is clicked", () => {
    const { onChange } = renderEditor({
      action: {
        kind: "roll",
        id: "atk",
        label: "Attack",
        expressionId: "atk_expr",
        inputs: [
          { id: "mod", label: "Mod", valueType: "integer", required: false, default: 0 },
          { id: "prof", label: "Prof", valueType: "integer", required: false, default: 2 },
        ],
        outputTemplate: "Result: {total}",
      },
    });
    fireEvent.click(screen.getByTestId("roll-action-input-remove-mod"));
    const last = lastCallPayload(onChange);
    if (last?.kind !== "roll") throw new Error("expected roll action");
    expect(last.inputs.map((i) => i.id)).toEqual(["prof"]);
  });

  it("updates the label through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("roll-action-label-atk"), { target: { value: "Strike" } });
    const last = lastCallPayload(onChange);
    if (last?.kind !== "roll") throw new Error("expected roll action");
    expect(last.label).toBe("Strike");
  });

  it("updates the expression id through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("roll-action-expression-id-atk"), { target: { value: "strike_expr" } });
    const last = lastCallPayload(onChange);
    if (last?.kind !== "roll") throw new Error("expected roll action");
    expect(last.expressionId).toBe("strike_expr");
  });

  it("updates the output template through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("roll-action-output-atk"), { target: { value: "Hit {total}" } });
    const last = lastCallPayload(onChange);
    if (last?.kind !== "roll") throw new Error("expected roll action");
    expect(last.outputTemplate).toBe("Hit {total}");
  });

  it("shows the empty marker until Try it is clicked", () => {
    renderEditor();
    expect(screen.getByTestId("roll-action-try-empty-atk")).toBeInTheDocument();
  });

  it("renders diagnostics when the source is invalid", async () => {
    renderEditor({ expressionSource: "@@" });
    fireEvent.click(screen.getByTestId("roll-action-try-atk"));
    await waitFor(() => {
      expect(screen.getByTestId("roll-action-try-result-atk")).toBeInTheDocument();
    });
    expect(screen.getByTestId("roll-action-try-audience-atk")).toHaveTextContent("Preview");
    const diagnostic = screen.getByTestId("roll-action-try-diagnostic-atk");
    expect(diagnostic).toBeInTheDocument();
    expect(diagnostic).toHaveAttribute("data-code", "invalid_syntax");
  });

  it("renders an arithmetic roll result with dice, modifiers, total, and formatted output", async () => {
    renderEditor({
      action: {
        kind: "roll",
        id: "atk",
        label: "Attack",
        expressionId: "atk_expr",
        inputs: [
          { id: "mod", label: "Mod", valueType: "integer", required: false, default: 5 },
        ],
        outputTemplate: "Hit {total}",
      },
      expressionSource: "d20 + inputs.mod",
    });
    fireEvent.click(screen.getByTestId("roll-action-try-atk"));
    await waitFor(() => {
      expect(screen.getByTestId("roll-action-try-result-atk")).toBeInTheDocument();
    });
    expect(screen.getByTestId("roll-action-try-audience-atk")).toHaveTextContent("Preview");
    expect(screen.getByTestId("roll-action-try-expression-atk")).toHaveTextContent("d20");
    expect(screen.getByTestId("roll-action-try-die-atk")).toBeInTheDocument();
    expect(screen.getByTestId("roll-action-try-modifiers-atk")).toHaveTextContent("5");
    expect(screen.getByTestId("roll-action-try-total-atk")).toBeInTheDocument();
    expect(screen.getByTestId("roll-action-try-formatted-atk")).toHaveTextContent("Hit ");
  });

  it("uses input defaults as bindings when evaluating", async () => {
    renderEditor({
      action: {
        kind: "roll",
        id: "sav",
        label: "Save",
        expressionId: "sav_expr",
        inputs: [
          { id: "mod", label: "Mod", valueType: "integer", required: false, default: 7 },
        ],
        outputTemplate: "{total}",
      },
      expressionSource: "10 + inputs.mod",
    });
    fireEvent.click(screen.getByTestId("roll-action-try-sav"));
    await waitFor(() => {
      expect(screen.getByTestId("roll-action-try-total-sav")).toHaveTextContent("17");
    });
  });

  it("commits input label, default, and required changes through onChange", () => {
    const { applyChange, current } = renderEditor({
      action: {
        kind: "roll",
        id: "atk",
        label: "Attack",
        expressionId: "atk_expr",
        inputs: [
          { id: "mod", label: "Mod", valueType: "integer", required: false, default: 0 },
        ],
        outputTemplate: "{total}",
      },
    });
    fireEvent.change(screen.getByTestId("roll-action-input-label-mod"), { target: { value: "Modifier" } });
    applyChange();
    fireEvent.change(screen.getByTestId("roll-action-input-default-mod"), { target: { value: "3" } });
    applyChange();
    fireEvent.click(screen.getByTestId("roll-action-input-required-mod"));
    applyChange();
    const final = current();
    if (final.kind !== "roll") throw new Error("expected roll action");
    expect(final.inputs[0]?.label).toBe("Modifier");
    expect(final.inputs[0]?.default).toBe(3);
    expect(final.inputs[0]?.required).toBe(true);
  });
});
