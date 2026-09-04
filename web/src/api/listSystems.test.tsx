import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useSystemLibrary } from "./listSystems.js";

describe("useSystemLibrary", () => {
  it("returns pages of systems", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ systems: [{ systemId: "s1", name: "A", lifecycle: "active", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null, requestId: "r" }), { status: 200 }));
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSystemLibrary(client), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.data?.pages[0]?.systems[0]?.name).toBe("A"));
  });
});
