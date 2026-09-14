import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import type { SystemSummary } from "../api/server.js";
import { SystemSharing } from "./SystemSharing.js";

const system: SystemSummary = {
  systemId: "s1",
  name: "Quest",
  access: "private",
  lifecycle: "active",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function setup(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetch_ = vi.fn(fetchImpl);
  const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <SystemSharing client={client} system={system} />
    </QueryClientProvider>,
  );
  return { fetch_, ...view };
}

describe("SystemSharing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("confirms widening access and patches on confirm", async () => {
    const user = userEvent.setup();
    const { fetch_ } = setup(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ sharing: { systemId: "s1", access: "link" }, requestId: "r" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const select = screen.getByLabelText(/sharing/i);
    expect(select).toHaveValue("private");
    await user.selectOptions(select, "link");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/anyone with the link/i);
    await user.click(screen.getByRole("button", { name: /share with link/i }));

    await waitFor(() => {
      const patch = fetch_.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
      expect(patch).toBeDefined();
    });
    const patch = fetch_.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH")!;
    expect(patch[0]).toContain("/systems/s1");
    expect(JSON.parse((patch[1] as RequestInit & { body: string }).body)).toEqual({ access: "link" });
  });

  it("cancelling the dialog sends no request", async () => {
    const user = userEvent.setup();
    const { fetch_ } = setup(async () => new Response(JSON.stringify({}), { status: 200 }));

    await user.selectOptions(screen.getByLabelText(/sharing/i), "public");
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(fetch_.mock.calls.filter((c) => (c[1] as RequestInit)?.method === "PATCH")).toHaveLength(0);
  });

  it("narrowing access applies immediately without a dialog", async () => {
    const user = userEvent.setup();
    const wide: SystemSummary = { ...system, access: "public" };
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ sharing: { systemId: "s1", access: "private" }, requestId: "r" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SystemSharing client={client} system={wide} />
      </QueryClientProvider>,
    );

    await user.selectOptions(screen.getByLabelText(/sharing/i), "private");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => {
      const patch = fetch_.mock.calls.find((c) => (c[1] as RequestInit)?.method === "PATCH");
      expect(patch).toBeDefined();
    });
  });
});
