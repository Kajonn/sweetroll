import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { openSystemKey, useOpenSystem } from "./openSystem.js";

function workspace(name: string) {
  return {
    workspace: {
      system: {
        systemId: "s1",
        name,
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
  };
}

function makeSetup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe("openSystem account scoping", () => {
  it("keys the open-system entry by actor and generation", () => {
    expect(openSystemKey("s1", { actorId: "user-a", generation: 2 })).toEqual([
      "system",
      "open",
      "s1",
      "user-a",
      2,
    ]);
    expect(openSystemKey("s1", { actorId: null, generation: 0 })).toEqual([
      "system",
      "open",
      "s1",
      "signed-out",
      0,
    ]);
    expect(openSystemKey("s1")).toEqual(["system", "open", "s1", "signed-out", 0]);
  });

  it("does not serve A's cached system to B without a refetch", async () => {
    const fetch_ = vi.fn(
      async () => new Response(JSON.stringify(workspace("A-doc")), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { qc, wrapper } = makeSetup();
    const scopeA = { actorId: "user-a", generation: 1 };
    const scopeB = { actorId: "user-b", generation: 1 };

    const hookA = renderHook(() => useOpenSystem(client, "s1", scopeA), { wrapper });
    await waitFor(() => expect(hookA.result.current.data).toBeDefined());
    expect(fetch_).toHaveBeenCalledTimes(1);

    // B has no entry under its own key before it mounts: A's cache is not visible.
    expect(qc.getQueryData(openSystemKey("s1", scopeB))).toBeUndefined();
    const hookB = renderHook(() => useOpenSystem(client, "s1", scopeB), { wrapper });
    expect(hookB.result.current.data).toBeUndefined();
    await waitFor(() => expect(hookB.result.current.data).toBeDefined());
    expect(fetch_).toHaveBeenCalledTimes(2);
  });

  it("does not let A's late response overwrite B", async () => {
    const releases: Array<(response: Response) => void> = [];
    const fetch_ = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const { wrapper } = makeSetup();

    const hookA = renderHook(() => useOpenSystem(client, "s1", { actorId: "user-a", generation: 1 }), {
      wrapper,
    });
    const hookB = renderHook(() => useOpenSystem(client, "s1", { actorId: "user-b", generation: 1 }), {
      wrapper,
    });
    await waitFor(() => expect(releases.length).toBe(2));

    releases[0]?.(new Response(JSON.stringify(workspace("A-doc")), { status: 200 }));
    releases[1]?.(new Response(JSON.stringify(workspace("B-doc")), { status: 200 }));

    await waitFor(() => expect(hookA.result.current.data).toBeDefined());
    await waitFor(() => expect(hookB.result.current.data).toBeDefined());
    expect(hookA.result.current.data?.system.name).toBe("A-doc");
    expect(hookB.result.current.data?.system.name).toBe("B-doc");
  });
});
