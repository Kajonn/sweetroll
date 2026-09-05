import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { CloneFromTemplate } from "./CloneFromTemplate.js";

describe("CloneFromTemplate", () => {
  it("renders one button per template", () => {
    const client = createApiClient({ baseUrl: "http://x", fetch: vi.fn() as typeof fetch });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <CloneFromTemplate client={client} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("clone-from-template-d20")).toBeInTheDocument();
    expect(screen.getByTestId("clone-from-template-pbta2d6")).toBeInTheDocument();
    expect(screen.getByTestId("clone-from-template-d6SuccessPool")).toBeInTheDocument();
  });

  it("posts a clone draft with the d20 version id on click", async () => {
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && url.endsWith("/systems")) {
        return new Response(
          JSON.stringify({
            workspace: {
              system: {
                systemId: "new-system",
                name: "Clone of d20",
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
          { status: 201 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CloneFromTemplate client={client} />
      </QueryClientProvider>,
    );

    // jsdom does not implement navigation; location.assign logs a warning but
    // does not throw, so we just exercise the click path.
    await userEvent.click(screen.getByTestId("clone-from-template-d20"));

    await vi.waitFor(() => {
      expect(fetch_.mock.calls.length).toBeGreaterThan(0);
    });
    const calls = fetch_.mock.calls as [string, RequestInit | undefined][];
    const postCall = calls.find(
      (call): call is [string, RequestInit & { method: string; body: string }] =>
        call[1]?.method === "POST",
    );
    if (postCall === undefined) throw new Error("expected a POST call");
    const body = postCall[1].body;
    if (typeof body !== "string") throw new Error("expected POST body");
    expect(JSON.parse(body).source).toEqual({
      kind: "clone",
      versionId: "11111111-1111-1111-1111-111111111a01",
    });
    expect(JSON.parse(body).idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });
});