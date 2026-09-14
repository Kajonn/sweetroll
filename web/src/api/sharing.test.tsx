import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useSystemLibrary } from "./listSystems.js";
import { useChangeSharing } from "./sharing.js";

describe("useChangeSharing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("patches the system access and invalidates the library query", async () => {
    let libraryHits = 0;
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            sharing: { systemId: "s1", access: "link" },
            requestId: "r",
          }),
          { status: 200 },
        );
      }
      libraryHits += 1;
      return new Response(
        JSON.stringify({
          systems: [
            {
              systemId: "s1",
              name: "A",
              access: "private",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          ],
          nextCursor: null,
          requestId: "r",
        }),
        { status: 200 },
      );
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const library = renderHook(() => useSystemLibrary(client), { wrapper });
    await waitFor(() => {
      expect(library.result.current.data).toBeDefined();
    });
    const hitsBefore = libraryHits;

    const mut = renderHook(() => useChangeSharing(client), { wrapper });
    mut.result.current.mutate({ systemId: "s1", access: "link" });

    await waitFor(() => {
      expect(mut.result.current.isSuccess).toBe(true);
    });

    const calls: [string, RequestInit | undefined][] = fetch_.mock.calls as [
      string,
      RequestInit | undefined,
    ][];
    const patchCall = calls.find(
      (call): call is [string, RequestInit & { method: string; body: string }] =>
        call[1]?.method === "PATCH",
    );
    if (patchCall === undefined) throw new Error("expected a PATCH call");
    expect(patchCall[0]).toContain("/systems/s1");
    expect(JSON.parse(patchCall[1].body)).toEqual({ access: "link" });

    await waitFor(() => {
      expect(libraryHits).toBeGreaterThan(hitsBefore);
    });
  });
});
