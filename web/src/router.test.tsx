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

  it("matches static /characters/new before dynamic /characters/$characterId", async () => {
    const actor = "00000000-0000-4000-8000-0000000000a1";
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: actor }));
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/characters/new");
      expect(await screen.findByLabelText("System version ID")).toBeVisible();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });

  it("renders the system editor on /systems/$systemId", async () => {
    const fetch_ = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "anonymous" }));
      }
      return new Promise<Response>(() => {});
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      renderAt("/systems/sys-1");
      expect(await screen.findByTestId("document-editor-loading")).toBeInTheDocument();
    } finally {
      globalThis.fetch = originalFetch;
      window.history.pushState({}, "", "/");
    }
  });
});
