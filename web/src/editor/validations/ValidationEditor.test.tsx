import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../../api/client.js";
import {
  ValidationEditor,
  type ValidationExpressionOption,
  type ValidationTargetOption,
  type ValidationV1,
} from "./ValidationEditor.js";

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(
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
    ),
  );
}

const defaultExpressions: ReadonlyArray<ValidationExpressionOption> = [
  { id: "low_hp", label: "Low HP" },
  { id: "overencumbered", label: "Over-encumbered" },
];

const defaultTargets: ReadonlyArray<ValidationTargetOption> = [
  { id: "character", label: "Character" },
  { id: "item", label: "Item" },
];

const defaultValidation: ValidationV1 = {
  id: "warn_low_hp",
  expressionId: "low_hp",
  severity: "warning",
  message: "validation.characterHealthLow",
  targetId: "character",
};

type RenderOptions = {
  validation?: ValidationV1;
  availableExpressions?: ReadonlyArray<ValidationExpressionOption>;
  availableTargets?: ReadonlyArray<ValidationTargetOption>;
  expressionSource?: string;
};

function renderEditor(options: RenderOptions = {}) {
  const {
    validation: initialValidation = defaultValidation,
    availableExpressions = defaultExpressions,
    availableTargets = defaultTargets,
    expressionSource = "fields.hp < 5",
  } = options;
  const onChange = vi.fn();
  const onExpressionSourceChange = vi.fn();
  const fetch_ = setupFetch();
  const client: ApiClient = createApiClient({
    baseUrl: "http://x",
    fetch: fetch_ as typeof fetch,
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <ValidationEditor
      client={client}
      systemId="s1"
      validation={initialValidation}
      onChange={onChange}
      expressionSource={expressionSource}
      onExpressionSourceChange={onExpressionSourceChange}
      availableExpressions={availableExpressions}
      availableTargets={availableTargets}
    />,
    { wrapper: makeWrapper(qc) },
  );
  return { ...view, onChange, onExpressionSourceChange };
}

function lastCallPayload(
  onChange: ReturnType<typeof vi.fn>,
): ValidationV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("ValidationEditor", () => {
  it("renders the severity, expressionId, targetId, and message controls", () => {
    renderEditor();
    expect(screen.getByTestId("validation-warn_low_hp")).toBeInTheDocument();
    expect(
      screen.getByTestId("validation-severity-warn_low_hp"),
    ).toHaveValue("warning");
    expect(
      screen.getByTestId("validation-expression-id-warn_low_hp"),
    ).toHaveValue("low_hp");
    expect(
      screen.getByTestId("validation-target-id-warn_low_hp"),
    ).toHaveValue("character");
    expect(screen.getByTestId("validation-message-warn_low_hp")).toHaveValue(
      "validation.characterHealthLow",
    );
  });

  it("renders the ExpressionEditor for the condition source", () => {
    renderEditor({ expressionSource: "fields.hp < 5" });
    expect(screen.getByTestId("expression-editor")).toBeInTheDocument();
    expect(screen.getByTestId("expression-editor-source")).toHaveValue(
      "fields.hp < 5",
    );
  });

  it("commits severity changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("validation-severity-warn_low_hp"), {
      target: { value: "error" },
    });
    const last = lastCallPayload(onChange);
    expect(last?.severity).toBe("error");
  });

  it("commits expressionId changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(
      screen.getByTestId("validation-expression-id-warn_low_hp"),
      { target: { value: "overencumbered" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.expressionId).toBe("overencumbered");
  });

  it("commits message changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("validation-message-warn_low_hp"), {
      target: { value: "validation.encumbered" },
    });
    const last = lastCallPayload(onChange);
    expect(last?.message).toBe("validation.encumbered");
  });

  it("commits targetId changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("validation-target-id-warn_low_hp"), {
      target: { value: "item" },
    });
    const last = lastCallPayload(onChange);
    expect(last?.targetId).toBe("item");
  });

  it("lists every available expression in the expressionId select", () => {
    renderEditor();
    const select = screen.getByTestId(
      "validation-expression-id-warn_low_hp",
    ) as HTMLSelectElement;
    const optionIds = Array.from(select.options).map((o) => o.value);
    expect(optionIds).toEqual(["", "low_hp", "overencumbered"]);
  });

  it("lists every available target in the targetId select", () => {
    renderEditor();
    const select = screen.getByTestId(
      "validation-target-id-warn_low_hp",
    ) as HTMLSelectElement;
    const optionIds = Array.from(select.options).map((o) => o.value);
    expect(optionIds).toEqual(["", "character", "item"]);
  });

  it("provides a datalist of i18n keys for the message input", () => {
    renderEditor();
    const datalist = screen.getByTestId(
      "validation-message-options-warn_low_hp",
    );
    expect(datalist.tagName.toLowerCase()).toBe("datalist");
    expect(datalist.querySelectorAll("option").length).toBeGreaterThan(0);
  });

  it("forwards expression source changes to onExpressionSourceChange", () => {
    const { onExpressionSourceChange } = renderEditor();
    fireEvent.change(screen.getByTestId("expression-editor-source"), {
      target: { value: "fields.hp < 2" },
    });
    expect(onExpressionSourceChange).toHaveBeenCalledWith("fields.hp < 2");
  });

  it("disables every control when disabled=true", () => {
    const fetch_ = setupFetch();
    const client: ApiClient = createApiClient({
      baseUrl: "http://x",
      fetch: fetch_ as typeof fetch,
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <ValidationEditor
        client={client}
        systemId="s1"
        validation={defaultValidation}
        onChange={vi.fn()}
        expressionSource=""
        onExpressionSourceChange={vi.fn()}
        availableExpressions={defaultExpressions}
        availableTargets={defaultTargets}
        disabled={true}
      />,
      { wrapper: makeWrapper(qc) },
    );
    expect(
      screen.getByTestId("validation-severity-warn_low_hp"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("validation-expression-id-warn_low_hp"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("validation-target-id-warn_low_hp"),
    ).toBeDisabled();
    expect(screen.getByTestId("validation-message-warn_low_hp")).toBeDisabled();
    expect(screen.getByTestId("expression-editor-source")).toBeDisabled();
  });
});
