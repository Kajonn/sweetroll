import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useDeprecateVersion } from "./deprecateVersion.js";

describe("useDeprecateVersion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("PATCHes lifecycle=deprecated to /system-versions/:versionId", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          lifecycle: { kind: "version", versionId: "v1", systemId: "s1", lifecycle: "deprecated" },
          requestId: "r",
        }),
        { status: 200 },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const mut = renderHook(() => useDeprecateVersion(client), { wrapper });
    mut.result.current.mutate({ versionId: "v1" });

    await waitFor(() => expect(mut.result.current.isSuccess).toBe(true));
    expect(mut.result.current.data?.lifecycle).toBe("deprecated");

    const calls = fetch_.mock.calls as unknown as [string, RequestInit | undefined][];
    const patchCall = calls.find((c) => c[1]?.method === "PATCH");
    if (patchCall === undefined) throw new Error("expected a PATCH call");
    expect(patchCall[0]).toContain("/system-versions/v1");
    expect(JSON.parse(patchCall[1]?.body as string)).toEqual({ lifecycle: "deprecated" });
  });
});
