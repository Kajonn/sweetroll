import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";

import type { DocumentAssessment } from "../api/server.js";
import { createApiClient } from "../api/client.js";
import { blankDocument, type SystemDocumentV1 } from "../state/documentReducer.js";
import { DocumentEditorBody, type CreatorTabId } from "./DocumentEditor.js";

type BodyProps = React.ComponentProps<typeof DocumentEditorBody>;

function stubClient() {
  const workspace = {
    system: {
      systemId: "s1",
      name: "Test System",
      access: "private",
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    draft: null,
    versions: [],
    assessment: { ok: true, diagnostics: [] },
  };
  const fetch_ = vi.fn(async () => new Response(JSON.stringify({ workspace, requestId: "r" }), { status: 200 }));
  return createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
}

function stubWs(): BodyProps["ws"] {
  return {
    system: {
      systemId: "s1",
      name: "Test System",
      access: "private",
      lifecycle: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    draft: null,
    versions: [],
    assessment: { ok: true, diagnostics: [] },
  } as unknown as BodyProps["ws"];
}

function stubAssessment(): DocumentAssessment {
  return { ok: true, diagnostics: [] } as unknown as DocumentAssessment;
}

function renderBody(initialDoc: SystemDocumentV1 = blankDocument(), initialTab: CreatorTabId = "basics") {
  const client = stubClient();
  const ws = stubWs();
  function Harness() {
    const [active, setActive] = useState<CreatorTabId>(initialTab);
    return (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DocumentEditorBody
          client={client}
          ws={ws}
          active={active}
          onActiveChange={setActive}
          initialDoc={initialDoc}
          assessment={stubAssessment()}
        />
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}

describe("basics-first creator workflow (G5 task 2)", () => {
  test("simple system path needs no expression: basics → attributes → dice → sections → preview → publish", async () => {
    const user = userEvent.setup();
    renderBody();

    // Default tab is basics with name/description/language/default-dice fields.
    expect(screen.getByRole("link", { name: "Basics" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("metadata-name")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-description")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-language")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-default-dice")).toBeInTheDocument();

    // Attributes: add an attribute WITHOUT opening any ExpressionEditor.
    await user.click(screen.getByRole("link", { name: "Attributes" }));
    await user.click(screen.getByTestId("entity-list-add"));
    const kindPicker = screen.getByTestId("entity-field-kind-picker-entity_1");
    expect(kindPicker).toHaveValue("text");
    await user.selectOptions(kindPicker, "integer");
    await user.click(screen.getByTestId("entity-add-field-entity_1"));
    expect(screen.getByTestId("scalar-field-field")).toBeInTheDocument();
    expect(screen.queryByTestId("expression-editor-source")).toBeNull();

    // Dice: add a roll action via guided fields only (label/kind/inputs), no grammar input.
    await user.click(screen.getByRole("link", { name: "Dice" }));
    await user.click(screen.getByTestId("actions-add-roll"));
    expect(screen.getByTestId("roll-action-label-action_1")).toBeInTheDocument();
    expect(screen.getByTestId("dice-kind-action_1")).toBeInTheDocument();
    expect(screen.queryByTestId("expression-editor-source")).toBeNull();
    await user.click(screen.getByTestId("roll-action-inputs-add-action_1"));
    expect(screen.getByTestId("roll-action-input-input_1")).toBeInTheDocument();

    // Sections: add + reorder a sheet section with Move buttons and keyboard hints.
    await user.click(screen.getByRole("link", { name: "Sections" }));
    await user.click(screen.getByTestId("sheet-add-button"));
    await user.click(screen.getByTestId("sheet-add-section"));
    await user.click(screen.getByTestId("sheet-add-section"));
    const moveUp = screen.getByTestId("section-row-section_1-move-up");
    const moveDown = screen.getByTestId("section-row-section_1-move-down");
    expect(moveUp).toHaveAttribute("title", "Alt+Up");
    expect(moveDown).toHaveAttribute("title", "Alt+Down");
    expect(screen.getByTestId("section-row-section_1-position")).toHaveTextContent("1");
    await user.click(moveDown);
    expect(screen.getByTestId("section-row-section_1-position")).toHaveTextContent("2");

    // Preview opens for the simple system and publish stays enabled.
    await user.click(screen.getByTestId("document-editor-preview-toggle"));
    expect(screen.getByTestId("document-editor-preview")).toBeInTheDocument();
    expect(screen.getByTestId("document-editor-publish")).not.toBeDisabled();
  });

  test("advanced controls sit behind a labeled disclosure and never block basics", async () => {
    const user = userEvent.setup();
    renderBody({
      ...blankDocument(),
      expressions: [{ id: "e1", context: "roll", resultType: "number", source: "d20", fallback: 0 }],
    });

    // Basics works without touching advanced.
    expect(screen.getByTestId("metadata-name")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Advanced" }));
    const disclosure = screen.getByTestId("advanced-disclosure");
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByText(/Advanced.*expression|validation|reference/i)).toBeInTheDocument();
    expect(screen.queryByTestId("validations-tab")).toBeNull();
    expect(screen.queryByTestId("reference-data-tab")).toBeNull();
    expect(screen.queryByTestId("expression-editor-source")).toBeNull();

    // Expanding reveals validations + reference data + expression editors.
    await user.click(screen.getByTestId("advanced-disclosure-toggle"));
    expect(disclosure).toHaveAttribute("open");
    expect(screen.getByTestId("validations-tab")).toBeInTheDocument();
    expect(screen.getByTestId("reference-data-tab")).toBeInTheDocument();
    expect(screen.getByTestId("expression-editor-source")).toHaveValue("d20");

    // Collapsing hides them again; basics is unaffected.
    await user.click(screen.getByTestId("advanced-disclosure-toggle"));
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.queryByTestId("validations-tab")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Basics" }));
    expect(screen.getByTestId("metadata-name")).toBeInTheDocument();
  });
});
