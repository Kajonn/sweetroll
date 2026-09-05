import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { DocumentEditor } from "./DocumentEditor.js";

function renderEditor(url = "http://localhost/") {
  const fetch_ = vi.fn(async () =>
    new Response(
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
          draft: null,
          versions: [],
          assessment: { ok: true, diagnostics: [] },
        },
        requestId: "r",
      }),
      { status: 200 },
    ),
  );
  const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // jsdom doesn't implement navigation; install a stub for window.location.search
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: new URL(url).search },
    });
  }
  render(
    <QueryClientProvider client={qc}>
      <DocumentEditor client={client} systemId="s1" />
    </QueryClientProvider>,
  );
  return { fetch_ };
}

describe("DocumentEditor", () => {
  it("renders the tab nav and a header with system name", async () => {
    renderEditor();

    expect(await screen.findByTestId("document-editor-name")).toHaveTextContent("Test System");
    expect(screen.getByTestId("document-editor-lifecycle")).toHaveTextContent("Active");
    expect(screen.getByTestId("document-editor-autosave")).toHaveTextContent("Saved");
    for (const label of ["Metadata", "Entities", "Sheets", "Actions", "Validations", "Reference data"]) {
      expect(screen.getByRole("link", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the EntityList inside the entities tab when tab=entities", async () => {
    renderEditor("http://localhost/?tab=entities");

    expect(await screen.findByTestId("document-editor-name")).toBeInTheDocument();
    expect(screen.getByTestId("entity-list-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("entity-list-empty")).toBeInTheDocument();
  });
});
