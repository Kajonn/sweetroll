import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useExportVersion } from "./exportVersion.js";

describe("useExportVersion", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    if (!("URL" in globalThis) || typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        value: vi.fn(() => "blob:fake"),
        writable: true,
      });
      Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
    }
  });

  it("GETs /system-versions/:versionId/export and triggers a download", async () => {
    const payload = { schemaVersion: "1.0", mediaType: "x", exportedAt: "2026", package: {} };
    const fetch_ = vi.fn(
      async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const click = vi.fn();
    const originalCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) => {
        const el = originalCreate(tag);
        if (tag === "a") (el as HTMLAnchorElement).click = click;
        return el;
      }) as typeof document.createElement);

    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const mut = renderHook(() => useExportVersion(client), { wrapper });
    await mut.result.current.mutateAsync({
      versionId: "v1",
      filename: "1.0.0.sweetroll.json",
    });

    await waitFor(() => expect(click).toHaveBeenCalled());

    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/system-versions/v1/export");
    expect(call[1]?.method).toBe("GET");

    const anchor = createSpy.mock.results
      .map((r) => r.value)
      .find((el): el is HTMLAnchorElement => el instanceof HTMLAnchorElement);
    expect(anchor?.download).toBe("1.0.0.sweetroll.json");
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    createSpy.mockRestore();
  });
});
