import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import {
  buildPreviewPackage,
  DocumentEditor,
  persistExpressionSource,
} from "./DocumentEditor.js";
import { defaultField, EntityList } from "./EntityList.js";
import type { FieldV1 } from "../state/documentFieldTypes.js";
import { ComputedFieldEditor } from "./fields/ComputedFieldEditor.js";

type PutBody = { expectedRevision: number | null; document: any };

function fixtureDocument() {
  return {
    schemaVersion: "1.0",
    metadata: { name: "R1", description: "d", language: "en", defaultDice: "d20" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: [
      { id: "e1", context: "roll", resultType: "number", source: "1 + 1", fallback: 0 },
    ],
    actions: [
      {
        kind: "roll",
        id: "a1",
        label: "Attack",
        expressionId: "e1",
        inputs: [],
        outputTemplate: "Result: {total}",
      },
    ],
    validations: [],
  };
}

function renderActionsEditor(onPut: (body: PutBody) => void) {
  let revision = 1;
  let serverDoc: ReturnType<typeof fixtureDocument> = fixtureDocument();
  const fetch_ = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input.toString();
    if (target.includes("/versions")) {
      return new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 });
    }
    if (target.endsWith("/draft")) {
      const body = JSON.parse(init?.body as string) as PutBody;
      onPut(body);
      revision += 1;
      serverDoc = body.document;
      return new Response(
        JSON.stringify({
          workspace: {
            system: {
              systemId: "s1",
              name: "Test System",
              access: "private",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            draft: {
              revision,
              document: serverDoc,
              sourceChecksum: "c",
              updatedBy: "u",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            versions: [],
            assessment: { ok: true, diagnostics: [] },
          },
          requestId: "r",
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        workspace: {
          system: {
            systemId: "s1",
            name: "Test System",
            access: "private",
            lifecycle: "active",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          draft: {
            revision,
            document: serverDoc,
            sourceChecksum: "c",
            updatedBy: "u",
            updatedAt: "2026-01-01T00:00:00Z",
          },
          versions: [],
          assessment: { ok: true, diagnostics: [] },
        },
        requestId: "r",
      }),
      { status: 200 },
    );
  });
  const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, search: "?tab=actions" },
  });
  render(
    <QueryClientProvider client={qc}>
      <DocumentEditor client={client} systemId="s1" />
    </QueryClientProvider>,
  );
}

describe("advanced definition round-trip preservation (G5 task 1)", () => {
  it("editing a roll expression source persists it into the document (not a render-local Map)", async () => {
    const puts: PutBody[] = [];
    renderActionsEditor((body) => {
      puts.push(body);
    });

    // The roll action's expression source is served from document.expressions.
    const source = await screen.findByTestId("expression-editor-source");
    expect(source).toHaveValue("1 + 1");

    // Edit the source through the ExpressionEditor.
    fireEvent.change(source, { target: { value: "2 + 3" } });
    expect(screen.getByTestId("expression-editor-source")).toHaveValue("2 + 3");

    // Force a full remount of the actions tab (switch tabs and back). A
    // render-local Map would be rebuilt from the unedited document here and
    // the edit would be lost.
    fireEvent.click(screen.getByRole("link", { name: "Validations" }));
    expect(await screen.findByTestId("validations-tab")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Actions" }));
    expect(await screen.findByTestId("actions-tab")).toBeInTheDocument();
    expect(screen.getByTestId("expression-editor-source")).toHaveValue("2 + 3");

    // The autosaved document must carry the edited source for E1.
    await waitFor(
      () => {
        const last = puts[puts.length - 1];
        expect(last?.document.expressions).toContainEqual(
          expect.objectContaining({ id: "e1", source: "2 + 3" }),
        );
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("persistExpressionSource dispatches the edited source into document.expressions", () => {
    const dispatch = vi.fn();
    const document = fixtureDocument() as any;
    persistExpressionSource(document, dispatch, "e1", "2 + 3");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const action = dispatch.mock.calls[0]?.[0];
    expect(action?.type).toBe("replace");
    expect(action?.document.expressions).toContainEqual(
      expect.objectContaining({ id: "e1", source: "2 + 3" }),
    );
    // Unknown expression ids are left alone (no stray entries created).
    const noop = vi.fn();
    persistExpressionSource(document, noop, "missing", "x");
    expect(noop).not.toHaveBeenCalled();
  });

  it("editing a computed field source writes back to the document on blur", () => {
    const onChange = vi.fn();
    const onExpressionSourceChange = vi.fn();
    const onFallbackChange = vi.fn();
    render(
      <ComputedFieldEditor
        field={{
          kind: "computed",
          id: "modifier",
          label: "Modifier",
          valueType: "number",
          expressionId: "modifier_expr",
        }}
        onChange={onChange}
        expressionSource="1 + 1"
        onExpressionSourceChange={onExpressionSourceChange}
        fallback={0}
        onFallbackChange={onFallbackChange}
      />,
    );
    const textarea = screen.getByTestId("computed-field-source-modifier");
    expect(textarea).toHaveValue("1 + 1");
    fireEvent.change(textarea, { target: { value: "fields.level + 1" } });
    fireEvent.blur(textarea);
    expect(onExpressionSourceChange).toHaveBeenCalledWith("fields.level + 1");

    const fallbackInput = screen.getByTestId("computed-field-fallback-modifier");
    fireEvent.change(fallbackInput, { target: { value: "5" } });
    fireEvent.blur(fallbackInput);
    expect(onFallbackChange).toHaveBeenCalledWith(5);
  });

  it("defaultField preserves resource/computed kinds instead of coercing them to text", () => {
    expect(defaultField("resource")).toMatchObject({ kind: "resource" });
    expect(defaultField("computed")).toMatchObject({ kind: "computed" });
  });

  it("entity edits keep resource/computed fields intact with a preserved note", async () => {
    const resourceField = {
      kind: "resource",
      id: "hp",
      label: "HP",
      default: { current: 5, max: 10 },
      min: 0,
      max: 10,
      step: 1,
      resetTo: "max",
    } as unknown as FieldV1;
    const computedField = {
      kind: "computed",
      id: "modifier",
      label: "Modifier",
      valueType: "number",
      expressionId: "modifier_expr",
    } as unknown as FieldV1;
    const textField = {
      kind: "text",
      id: "name",
      label: "Name",
      default: "",
      required: false,
      minLength: 0,
      maxLength: 120,
    } as unknown as FieldV1;
    const onChange = vi.fn();
    function Controlled() {
      const [entities, setEntities] = useState([
        { id: "hero", label: "Hero", fields: [textField, resourceField, computedField] },
      ]);
      return (
        <EntityList
          entities={entities}
          onChange={(next) => {
            setEntities(next);
            onChange(next);
          }}
          selectedEntityId="hero"
          onSelectEntity={() => {}}
        />
      );
    }
    render(<Controlled />);

    // The computed field renders a read-only summary with an explicit
    // preserved note instead of being rewritten to another kind.
    const unsupported = screen.getByTestId("field-unsupported-modifier");
    expect(unsupported.textContent).toMatch(/preserved/);

    // Editing an unrelated field must not rewrite the resource/computed kinds.
    fireEvent.change(screen.getByTestId("scalar-field-default-name"), {
      target: { value: "X" },
    });
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    const hero = last?.find((e: { id: string }) => e.id === "hero");
    expect(hero?.fields.find((f: FieldV1) => f.id === "hp")).toMatchObject({
      kind: "resource",
      default: { current: 5, max: 10 },
    });
    expect(hero?.fields.find((f: FieldV1) => f.id === "modifier")).toMatchObject({
      kind: "computed",
      expressionId: "modifier_expr",
    });
  });

  it("buildPreviewPackage passes document expressions through instead of dropping them", () => {
    const pkg = buildPreviewPackage({
      ...(fixtureDocument() as any),
      entities: [
        {
          id: "hero",
          label: "Hero",
          fields: [
            {
              kind: "text",
              id: "name",
              label: "Name",
              default: "",
              required: false,
              minLength: 0,
              maxLength: 120,
            },
          ],
        },
      ],
    });
    expect(pkg).not.toBeNull();
    expect(pkg?.expressions.map((e) => e.id)).toContain("e1");
  });
});
