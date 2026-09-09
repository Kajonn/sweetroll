import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, test, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import type { DocumentAssessment } from "../api/server.js";
import { blankDocument, type SystemDocumentV1 } from "../state/documentReducer.js";
import { DocumentEditorBody, type CreatorTabId } from "./DocumentEditor.js";

type BodyProps = React.ComponentProps<typeof DocumentEditorBody>;

function stubAssessment(): DocumentAssessment {
  return {
    ok: false,
    diagnostics: [
      { code: "invalid_definition_id", path: "/entities/0/id", message: "ID is invalid." },
      { code: "missing_reference", path: "/entities/0/fields/0", message: "Missing reference." },
    ],
  } as unknown as DocumentAssessment;
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
    draft: {
      revision: 7,
      document: blankDocument(),
      sourceChecksum: "abc",
      updatedBy: "u1",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    versions: [
      {
        versionId: "v1",
        systemId: "s1",
        semanticVersion: "1.0.0",
        checksum: "c",
        releaseNotes: "",
        lifecycle: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    assessment: stubAssessment(),
  } as unknown as BodyProps["ws"];
}

function okWorkspace(revision: number) {
  return {
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
        document: blankDocument(),
        sourceChecksum: "abc",
        updatedBy: "u1",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      versions: [],
      assessment: { ok: true, diagnostics: [] },
    },
    requestId: "r",
  };
}

function conflictResponse(latestRevision: number) {
  return new Response(
    JSON.stringify({
      error: {
        code: "conflict",
        message: "The draft was modified by another request.",
        latestRevision,
      },
      requestId: "r",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

function renderBody(fetch_: ReturnType<typeof vi.fn>, ws: BodyProps["ws"]) {
  const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  function Harness() {
    const [active, setActive] = useState<CreatorTabId>("basics");
    return (
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DocumentEditorBody
          client={client}
          ws={ws}
          active={active}
          onActiveChange={setActive}
          initialDoc={blankDocument()}
          assessment={ws.assessment}
        />
      </QueryClientProvider>
    );
  }
  return render(<Harness />);
}

function okFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const target = typeof input === "string" ? input : input.toString();
    if (target.includes("/versions")) {
      return new Response(JSON.stringify({ versions: stubWs().versions, requestId: "r" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(okWorkspace(7)), { status: 200 });
  });
}

describe("publish readiness (G5 task 5)", () => {
  test("readiness panel shows draft rev, unsaved state, diagnostics, and latest published version", () => {
    renderBody(okFetch(), stubWs());

    const panel = screen.getByTestId("document-editor-readiness");
    expect(panel).toHaveTextContent(/Draft rev 7/);
    expect(panel).toHaveTextContent(/Not saved yet/);
    expect(panel).toHaveTextContent(/2 issues/);
    expect(panel).toHaveTextContent(/Latest published 1\.0\.0/);

    // Publish stays disabled and the reason is visible text, not tooltip-only.
    const publish = screen.getByTestId("document-editor-publish");
    expect(publish).toBeDisabled();
    expect(screen.getByTestId("document-editor-publish-reason")).toHaveTextContent(
      /2 error diagnostics must be resolved/,
    );
  });

  test("readiness diagnostics action opens the drawer and versions action opens history", async () => {
    const user = userEvent.setup();
    renderBody(okFetch(), stubWs());

    await user.click(screen.getByTestId("document-editor-readiness-diagnostics"));
    expect(screen.getByTestId("document-editor-diagnostics")).toBeInTheDocument();

    await user.click(screen.getByTestId("document-editor-readiness-versions"));
    expect(screen.getByTestId("version-history")).toBeInTheDocument();
  });

  test("lifecycle chip reads draft (unpublished) before the first publish", () => {
    const ws = stubWs();
    renderBody(okFetch(), { ...ws, versions: [] } as unknown as BodyProps["ws"]);
    expect(screen.getByTestId("document-editor-lifecycle")).toHaveTextContent(/Draft \(unpublished\)/);
  });

  test("conflict actions stay explicit replace/reload (never Merge) via the G1 owner", async () => {
    const fetch_ = vi
      .fn()
      .mockImplementationOnce(async () => conflictResponse(9))
      .mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof _input === "string" && _input.includes("/versions")) {
          return new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 });
        }
        if (init?.method === "PUT") return new Response(JSON.stringify(okWorkspace(10)), { status: 200 });
        return new Response(JSON.stringify(okWorkspace(7)), { status: 200 });
      });
    const doc: SystemDocumentV1 = {
      ...blankDocument(),
      metadata: { ...blankDocument().metadata, name: "Mine" },
    } as unknown as SystemDocumentV1;
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    function Harness() {
      const [active, setActive] = useState<CreatorTabId>("basics");
      const ws = stubWs();
      return (
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <DocumentEditorBody
            client={client}
            ws={ws}
            active={active}
            onActiveChange={setActive}
            initialDoc={doc}
            assessment={{ ok: true, diagnostics: [] } as unknown as DocumentAssessment}
          />
        </QueryClientProvider>
      );
    }
    render(<Harness />);

    // The 600ms autosave debounce fires the first PUT, which 409s.
    const banner = await screen.findByTestId("conflict-banner", undefined, { timeout: 5000 });
    expect(banner).toHaveTextContent(/revision 9/);
    expect(screen.getByRole("button", { name: /reload theirs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace server version/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();

    // Keep-mine replaces against the conflict revision, never null.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /replace server version/i }));
    await waitFor(
      () => {
        const puts = fetch_.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
        expect(puts.length).toBeGreaterThanOrEqual(2);
        const last = puts[puts.length - 1]?.[1] as RequestInit | undefined;
        expect(JSON.parse(last?.body as string)).toMatchObject({ expectedRevision: 9 });
      },
      { timeout: 5000 },
    );
  });
});
