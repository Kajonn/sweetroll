import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "./client.js";
import { useListTemplates } from "./listTemplates.js";

describe("useListTemplates", () => {
  it("returns the templates array from /templates", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({
          templates: [
            {
              templateId: "d20",
              label: "d20 sample",
              versionId: "a0000000-0000-5000-8000-000000000002",
            },
            {
              templateId: "pbta2d6",
              label: "PbtA 2d6 sample",
              versionId: "b0000000-0000-5000-8000-000000000002",
            },
            {
              templateId: "d6success",
              label: "d6 success pool sample",
              versionId: "c0000000-0000-5000-8000-000000000002",
            },
          ],
          requestId: "r",
        }),
        { status: 200 },
      ),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useListTemplates(client), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.data?.length).toBe(3));
    expect(result.current.data?.[0]?.templateId).toBe("d20");
    expect(result.current.data?.[0]?.versionId).toBe("a0000000-0000-5000-8000-000000000002");
    expect(result.current.data?.[2]?.templateId).toBe("d6success");
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    if (call === undefined) throw new Error("expected a fetch call");
    expect(call[0]).toContain("/templates");
    expect(call[1]?.method).toBe("GET");
  });

  it("does not fetch when disabled", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(JSON.stringify({ templates: [], requestId: "r" }), { status: 200 }),
    );
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useListTemplates(client, { enabled: false }), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await new Promise((r) => setTimeout(r, 25));
    expect(fetch_).not.toHaveBeenCalled();
  });
});