import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";
import { useSaveDraft } from "./saveDraft.js";

describe("useSaveDraft", () => {
  afterEach(() => vi.restoreAllMocks());

  const makeWrapper = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return wrapper;
  };

  it("PUTs the draft body and returns the workspace on success", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspace: {
            system: {
              systemId: "s1",
              name: "Test",
              access: "private",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            draft: {
              revision: 3,
              document: { metadata: { name: "Test" } },
              sourceChecksum: "abc",
              updatedBy: "u1",
              updatedAt: "2026-01-01T00:00:00Z",
            },
            versions: [],
            assessment: { ok: true, diagnostics: [] },
          },
          requestId: "r",
        }),
        { status: 200 },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => useSaveDraft(client), { wrapper: makeWrapper() });

    result.current.mutate({
      systemId: "s1",
      expectedRevision: 2,
      document: { metadata: { name: "Test" } },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.draft?.revision).toBe(3);

    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/systems/s1/draft");
    expect(call[1]?.method).toBe("PUT");
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      expectedRevision: 2,
      document: { metadata: { name: "Test" } },
    });
  });

  it("accepts expectedRevision: null on first save", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          workspace: {
            system: {
              systemId: "s1",
              name: "Test",
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
    const { result } = renderHook(() => useSaveDraft(client), { wrapper: makeWrapper() });

    result.current.mutate({
      systemId: "s1",
      expectedRevision: null,
      document: { metadata: { name: "First save" } },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ expectedRevision: null });
  });

  it("exposes the 409 conflict on error", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "conflict",
            message: "The draft was modified by another request.",
            latestRevision: 7,
          },
          requestId: "r",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => useSaveDraft(client), { wrapper: makeWrapper() });

    result.current.mutate({ systemId: "s1", expectedRevision: 5, document: {} });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const err = result.current.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).latestRevision).toBe(7);
  });
});
