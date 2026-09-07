import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useCreationVersions } from "./listCreationVersions.js";

describe("useCreationVersions", () => {
  it("returns the versions array from /characters/creation-versions", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            versions: [
              {
                versionId: "v1",
                systemId: "s1",
                systemName: "D20",
                semanticVersion: "1.0.0",
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                versionId: "v2",
                systemId: "s2",
                systemName: "Cards",
                semanticVersion: "0.9.0",
                createdAt: "2025-12-01T00:00:00Z",
              },
            ],
          },
          requestId: "r",
        }),
        { status: 200 },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreationVersions(client), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    expect(result.current.data?.[0]?.systemName).toBe("D20");
    expect(result.current.data?.[1]?.semanticVersion).toBe("0.9.0");
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/characters/creation-versions");
    expect(call[1]?.method).toBe("GET");
  });

  it("does not fetch when disabled", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(JSON.stringify({ data: { versions: [] }, requestId: "r" }), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useCreationVersions(client, { enabled: false }), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(fetch_).not.toHaveBeenCalled();
  });
});
