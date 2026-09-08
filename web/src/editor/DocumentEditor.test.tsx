import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { DocumentEditor } from "./DocumentEditor.js";

type AssessmentLike = {
  ok: boolean;
  diagnostics: Array<{ code: string; path: string; message: string }>;
};

function renderEditor(
  url = "http://localhost/",
  assessment: AssessmentLike = { ok: true, diagnostics: [] },
) {
  const fetch_ = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === "string" ? input : input.toString();
    if (target.includes("/versions")) {
      return new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 });
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
          draft: null,
          versions: [],
          assessment,
        },
        requestId: "r",
      }),
      { status: 200 },
    );
  });
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

  it("renders a publish button in the header", async () => {
    renderEditor();
    expect(await screen.findByTestId("document-editor-publish")).toBeInTheDocument();
  });

  it("enables the publish button when the assessment has no diagnostics", async () => {
    renderEditor();
    const button = await screen.findByTestId("document-editor-publish");
    expect(button).not.toBeDisabled();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  it("disables the publish button when the assessment contains error diagnostics", async () => {
    renderEditor("http://localhost/", {
      ok: false,
      diagnostics: [
        { code: "invalid_definition_id", path: "/entities/0/id", message: "ID is invalid." },
        { code: "missing_reference", path: "/entities/0/fields/0", message: "Missing reference." },
      ],
    });
    const button = await screen.findByTestId("document-editor-publish");
    expect(button).toBeDisabled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(
      "Publish disabled — 2 error diagnostics must be resolved.",
    );
  });

  it("renders preview, diagnostics, and version-history toggle buttons in the header", async () => {
    renderEditor();
    expect(await screen.findByTestId("document-editor-preview-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("document-editor-diagnostics-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("document-editor-version-history-toggle")).toBeInTheDocument();
  });

  it("opens the diagnostics drawer when the diagnostics toggle is clicked", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByTestId("document-editor-diagnostics-toggle"));
    expect(screen.getByTestId("diagnostics-drawer")).toBeInTheDocument();
  });

  it("opens the version history panel when the versions toggle is clicked", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByTestId("document-editor-version-history-toggle"));
    expect(screen.getByTestId("version-history")).toBeInTheDocument();
  });

  it("opens the publish dialog when the publish button is clicked", async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByTestId("document-editor-publish"));
    expect(screen.getByTestId("publish-dialog")).toBeInTheDocument();
  });

  it("renders the metadata editor inside the metadata tab body", async () => {
    renderEditor();
    expect(await screen.findByTestId("metadata-editor")).toBeInTheDocument();
  });

  it("renders the sheets tab body with an Add sheet button", async () => {
    renderEditor("http://localhost/?tab=sheets");
    expect(await screen.findByTestId("sheet-add-button")).toBeInTheDocument();
    expect(screen.getByTestId("sheets-tab")).toBeInTheDocument();
  });

  it("renders the actions tab body with Add roll + Add resource bump buttons", async () => {
    renderEditor("http://localhost/?tab=actions");
    expect(await screen.findByTestId("actions-add-roll")).toBeInTheDocument();
    expect(screen.getByTestId("actions-add-resource-bump")).toBeInTheDocument();
  });

  it("renders the validations tab body with an Add validation button", async () => {
    renderEditor("http://localhost/?tab=validations");
    expect(await screen.findByTestId("validations-add-button")).toBeInTheDocument();
  });

  it("renders the reference-data tab body with an Add reference-data button", async () => {
    renderEditor("http://localhost/?tab=referenceData");
    expect(await screen.findByTestId("reference-data-add-button")).toBeInTheDocument();
  });

  it("scrolls into view when a focus-editor:{path} event fires for an element with matching data-path", async () => {
    renderEditor("http://localhost/?tab=sheets");
    const addButton = await screen.findByTestId("sheet-add-button");
    addButton.setAttribute("data-path", "/sheets/0");
    const scrollIntoView = vi.fn();
    addButton.scrollIntoView = scrollIntoView;
    window.dispatchEvent(new CustomEvent("focus-editor:/sheets/0"));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("preserves an edit made during a slow save instead of adopting the stale echo", async () => {
    const user = userEvent.setup();
    // Pin the tab: earlier tests stub window.location with other tabs.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, search: "" },
    });
    // Stateful server with the production revision check.
    let revision = 1;
    let serverName = "R1";
    const docFor = (name: string) => ({
      schemaVersion: "1.0",
      metadata: { name, description: "d", language: "en", defaultDice: "d20" },
      entities: [],
      referenceData: [],
      sheets: [],
      expressions: [],
      actions: [],
      validations: [],
    });
    const workspace = (rev: number, name: string) => ({
      system: {
        systemId: "s1",
        name: "Test System",
        access: "private",
        lifecycle: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      draft: {
        revision: rev,
        document: docFor(name),
        sourceChecksum: "c",
        updatedBy: "u",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      versions: [],
      assessment: { ok: true, diagnostics: [] },
    });
    const errorBody = (latestRevision: number) => JSON.stringify({
      error: { code: "conflict", message: "stale", latestRevision },
      requestId: "r",
    });
    let puts = 0;
    let releaseFirstPut!: () => void;
    const firstPutGate = new Promise<void>((resolve) => { releaseFirstPut = resolve; });
    let releaseSecondPut!: () => void;
    const secondPutGate = new Promise<void>((resolve) => { releaseSecondPut = resolve; });
    const getCalls: Array<unknown> = [];
    const fetch_ = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/versions")) {
        return new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 });
      }
      if (target.endsWith("/draft")) {
        puts += 1;
        const body = JSON.parse(init?.body as string) as { expectedRevision: number | null; document: { metadata: { name: string } } };
        if (puts === 1) await firstPutGate;
        if (puts === 2) await secondPutGate;
        if (body.expectedRevision !== revision) {
          return new Response(errorBody(revision), { status: 409, headers: { "content-type": "application/json" } });
        }
        revision += 1;
        serverName = body.document.metadata.name;
        return new Response(JSON.stringify({ workspace: workspace(revision, serverName), requestId: "r" }), { status: 200 });
      }
      getCalls.push(target);
      return new Response(JSON.stringify({ workspace: workspace(revision, serverName), requestId: "r" }), { status: 200 });
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DocumentEditor client={client} systemId="s1" />
      </QueryClientProvider>,
    );

    // Mount autosave fires the slow first PUT; edit while it is in flight.
    await waitFor(() => expect(puts).toBe(1), { timeout: 10_000 });
    const nameInput = await screen.findByTestId("metadata-name");
    expect(nameInput).toHaveValue("R1");
    await user.type(nameInput, " + local");
    nameInput.blur();
    releaseFirstPut();

    // The first save's echo refetch must not clobber the newer local edit.
    await waitFor(() => expect(getCalls.length).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
    expect(screen.getByTestId("metadata-name")).toHaveValue("R1 + local");

    // The stashed edit then saves cleanly against the fresh revision.
    releaseSecondPut();
    await waitFor(() => expect(puts).toBe(2), { timeout: 10_000 });
    await waitFor(
      () => expect(screen.getByTestId("document-editor-autosave")).toHaveTextContent("Saved"),
      { timeout: 10_000 },
    );
    expect(screen.queryByTestId("conflict-banner")).not.toBeInTheDocument();
    expect(screen.getByTestId("metadata-name")).toHaveValue("R1 + local");
  }, 20_000);
});
