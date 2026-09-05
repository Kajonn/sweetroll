import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";
import { useAssessDraft } from "./assessDraft.js";

describe("useAssessDraft", () => {
  afterEach(() => vi.restoreAllMocks());

  const makeWrapper = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return wrapper;
  };

  it("POSTs to /systems/:systemId/preview and returns the snapshot", async () => {
    const fetch_ = vi.fn(async () =>
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
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => useAssessDraft(client), { wrapper: makeWrapper() });

    result.current.mutate("s1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.snapshot.snapshotId).toBe("snap-1");

    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/systems/s1/preview");
    expect(call[1]?.method).toBe("POST");
  });

  it("exposes the 422 invalid_package error with diagnostics on failure", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_package",
            message: "Package too large",
            diagnostics: [
              { code: "limit_exceeded", path: "expressions[0]", message: "expression exceeds node budget" },
            ],
          },
          requestId: "r",
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => useAssessDraft(client), { wrapper: makeWrapper() });

    result.current.mutate("s1");

    await waitFor(() => expect(result.current.isError).toBe(true));
    const err = result.current.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).diagnostics[0]?.code).toBe("limit_exceeded");
  });
});
