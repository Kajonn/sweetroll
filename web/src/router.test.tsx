import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppRouter } from "./router.js";

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const router = createAppRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe("router", () => {
  afterEach(() => {
    window.history.pushState({}, "", "/");
  });

  it("renders the system library + clone-from-template on /", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }),
        { status: 200 },
      ),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/");
      await waitFor(() => expect(screen.getByTestId("library-route")).toBeInTheDocument());
      expect(screen.getByTestId("clone-from-template")).toBeInTheDocument();
      expect(screen.getByTestId("system-library")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
