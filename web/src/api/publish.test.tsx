import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";
import { usePublish } from "./publish.js";

describe("usePublish", () => {
  const makeWrapper = () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  };

  it("POSTs to /systems/:id/publish and returns the published version", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          version: {
            versionId: "v1",
            systemId: "s1",
            semanticVersion: "1.0.0",
            checksum: "abc",
            package: {},
            releaseNotes: "init",
            lifecycle: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
          requestId: "r",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => usePublish(client), { wrapper: makeWrapper() });

    result.current.mutate({
      systemId: "s1",
      expectedRevision: 5,
      semanticVersion: "1.0.0",
      releaseNotes: "first",
      idempotencyKey: "k-1",
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.versionId).toBe("v1");
    expect(result.current.data?.semanticVersion).toBe("1.0.0");

    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/systems/s1/publish");
    expect(call[1]?.method).toBe("POST");
    expect(JSON.parse(call[1]?.body as string)).toEqual({
      expectedRevision: 5,
      semanticVersion: "1.0.0",
      releaseNotes: "first",
      idempotencyKey: "k-1",
    });
  });

  it("exposes 422 invalid_package diagnostics on error", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "invalid_package",
            message: "Breaking changes detected.",
            diagnostics: [
              {
                code: "breaking_removed_definition",
                path: "/entities/character/fields/proficient",
                message: 'Field "proficient" was removed from entity "character".',
              },
            ],
          },
          requestId: "r",
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { result } = renderHook(() => usePublish(client), { wrapper: makeWrapper() });

    result.current.mutate({
      systemId: "s1",
      expectedRevision: 5,
      semanticVersion: "1.0.0",
      releaseNotes: "destructive",
      idempotencyKey: "k-2",
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    const err = result.current.error;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("invalid_package");
    expect((err as ApiError).status).toBe(422);
    expect((err as ApiError).diagnostics[0]?.code).toBe("breaking_removed_definition");
    expect((err as ApiError).diagnostics[0]?.path).toBe("/entities/character/fields/proficient");
  });
});
