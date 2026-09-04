import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useMe } from "./hooks.js";

describe("useMe", () => {
  it("returns anonymous when no session", async () => {
    const client = createApiClient({ baseUrl: "http://x", fetch: vi.fn(async () => new Response(JSON.stringify({ state: "anonymous" }), { status: 200 })) as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useMe(client), { wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider> });
    await waitFor(() => expect(result.current.data).toEqual({ state: "anonymous" }));
  });
});
