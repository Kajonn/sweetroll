import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useListVersions } from "./listVersions.js";

describe("useListVersions", () => {
  it("returns the versions array from /systems/:id/versions", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          versions: [
            {
              versionId: "v1",
              systemId: "s1",
              semanticVersion: "1.0.0",
              checksum: "abc",
              releaseNotes: "first",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
            },
            {
              versionId: "v2",
              systemId: "s1",
              semanticVersion: "0.9.0",
              checksum: "def",
              releaseNotes: "older",
              lifecycle: "deprecated",
              createdAt: "2025-12-01T00:00:00Z",
            },
          ],
          requestId: "r",
        }),
        { status: 200 },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useListVersions(client, "s1"), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data?.length).toBe(2));
    expect(result.current.data?.[0]?.semanticVersion).toBe("1.0.0");
    expect(result.current.data?.[1]?.lifecycle).toBe("deprecated");
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/systems/s1/versions");
    expect(call[1]?.method).toBe("GET");
  });

  it("does not fetch when disabled", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(JSON.stringify({ versions: [], requestId: "r" }), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useListVersions(client, "s1", { enabled: false }), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(fetch_).not.toHaveBeenCalled();
  });
});
