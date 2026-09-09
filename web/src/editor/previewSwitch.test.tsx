import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import type { DocumentAssessment } from "../api/server.js";
import { blankDocument, type SystemDocumentV1 } from "../state/documentReducer.js";
import { DocumentEditorBody, type CreatorTabId } from "./DocumentEditor.js";
import editorStyles from "./DocumentEditor.module.css";

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

function renderBody(initialDoc: SystemDocumentV1, initialTab: CreatorTabId = "basics") {
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

function previewableDoc(): SystemDocumentV1 {
  return {
    ...blankDocument(),
    entities: [{ id: "e1", label: "Entity", fields: [] }],
  } as unknown as SystemDocumentV1;
}

describe("phone editor/preview switch (G5 task 4)", () => {
  test("phone widths get an editor/preview switch, desktop keeps side-by-side", async () => {
    const user = userEvent.setup();
    renderBody(previewableDoc());

    // Open the preview: the existing show/hide toggle stays the entry point.
    await user.click(screen.getByTestId("document-editor-preview-toggle"));
    expect(await screen.findByTestId("document-editor-preview")).toBeInTheDocument();

    // Narrow layouts get an explicit Editor/Preview switch with pressed semantics.
    const group = screen.getByTestId("document-editor-preview-switch");
    expect(group).toHaveAttribute("role", "group");
    expect(group.getAttribute("aria-label")).toMatch(/Editor|Preview/i);
    const options = within(group).getAllByRole("button");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/Editor/i), expect.stringMatching(/Preview/i)]),
    );
    const editorOption = screen.getByTestId("document-editor-preview-view-editor");
    const previewOption = screen.getByTestId("document-editor-preview-view-preview");
    // Keyboard reachable by construction: native enabled buttons.
    for (const option of [editorOption, previewOption]) {
      expect(option.tagName).toBe("BUTTON");
      expect(option).not.toBeDisabled();
    }

    const body = screen.getByTestId("document-editor-body-basics");

    // Activating Preview selects the preview view; activating Editor reverses it.
    await user.click(previewOption);
    expect(body).toHaveAttribute("data-mobile-view", "preview");
    expect(previewOption).toHaveAttribute("aria-pressed", "true");
    expect(editorOption).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("document-editor-preview")).toBeInTheDocument();

    await user.click(editorOption);
    expect(body).toHaveAttribute("data-mobile-view", "editor");
    expect(editorOption).toHaveAttribute("aria-pressed", "true");
    expect(previewOption).toHaveAttribute("aria-pressed", "false");
    expect(within(screen.getByTestId("document-editor-editor-pane")).getByTestId("basics-tab")).toBeInTheDocument();

    // Desktop keeps the side-by-side split: both panes stay mounted and the
    // split class remains applied while the preview is open.
    expect(body.classList.contains(editorStyles.bodySplit as string)).toBe(true);
    expect(screen.getByTestId("document-editor-editor-pane")).toBeInTheDocument();
    expect(screen.getByTestId("document-editor-preview")).toBeInTheDocument();
  });
});
