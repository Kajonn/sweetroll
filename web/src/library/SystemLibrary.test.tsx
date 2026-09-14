import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import { registerAppRouter, resetAppRouter } from "../shell/appNavigation.js";
import { SystemLibrary } from "./SystemLibrary.js";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

describe("SystemLibrary", () => {
  afterEach(() => {
    resetAppRouter();
  });

  it("renders a row per system", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ systems: [{ systemId: "s1", name: "A", lifecycle: "active", updatedAt: "2026-01-01T00:00:00Z" }, { systemId: "s2", name: "B", lifecycle: "active", updatedAt: "2026-01-02T00:00:00Z" }], nextCursor: null, requestId: "r" }), { status: 200 }));
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SystemLibrary client={client} /></QueryClientProvider>);
    expect(await screen.findByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
  });

  it("client-navigates the row link", async () => {
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ systems: [{ systemId: "s1", name: "D20", lifecycle: "active", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: null, requestId: "r" }), { status: 200 }));
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><SystemLibrary client={client} /></QueryClientProvider>);
    await userEvent.setup().click(await screen.findByRole("link", { name: "D20" }));
    expect(push).toHaveBeenCalledWith("/systems/s1");
  });
});
