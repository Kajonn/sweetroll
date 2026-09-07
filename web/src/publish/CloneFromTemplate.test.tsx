import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../api/client.js";
import { CloneFromTemplate } from "./CloneFromTemplate.js";

type FakeResponse = {
  urlIncludes: string;
  method?: string;
  status?: number;
  body: unknown;
};

function makeFetch(responses: FakeResponse[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    for (const r of responses) {
      if (!url.includes(r.urlIncludes)) continue;
      if (r.method !== undefined && init?.method !== r.method) continue;
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: { code: "not_found", message: "no mock" }, requestId: "r" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  });
}

function renderPicker(fetch_: ReturnType<typeof vi.fn>) {
  const client: ApiClient = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CloneFromTemplate client={client} />
    </QueryClientProvider>,
  );
  return { client };
}

const TEMPLATES = {
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
};

describe("CloneFromTemplate (publish)", () => {
  it("renders a button for each template returned by /templates", async () => {
    const fetch_ = makeFetch([{ urlIncludes: "/templates", body: TEMPLATES }]);
    renderPicker(fetch_);

    expect(await screen.findByTestId("clone-from-template-d20")).toBeInTheDocument();
    expect(screen.getByTestId("clone-from-template-pbta2d6")).toBeInTheDocument();
    expect(screen.getByTestId("clone-from-template-d6success")).toBeInTheDocument();
    expect(screen.getByTestId("clone-from-template-item-d20")).toHaveTextContent("d20 sample");
    expect(screen.getByTestId("clone-from-template-item-pbta2d6")).toHaveTextContent("PbtA 2d6 sample");
    expect(screen.getByTestId("clone-from-template-item-d6success")).toHaveTextContent("d6 success pool sample");
  });

  it("shows a loading state and then the list once /templates resolves", async () => {
    const fetch_ = makeFetch([{ urlIncludes: "/templates", body: TEMPLATES }]);
    renderPicker(fetch_);

    await waitFor(() =>
      expect(screen.queryByTestId("clone-from-template-loading")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("clone-from-template-list")).toBeInTheDocument();
  });

  it("shows an empty state when /templates returns zero entries", async () => {
    const fetch_ = makeFetch([{ urlIncludes: "/templates", body: { templates: [], requestId: "r" } }]);
    renderPicker(fetch_);

    expect(await screen.findByTestId("clone-from-template-empty")).toBeInTheDocument();
  });

  it("shows an error message when /templates fails", async () => {
    const fetch_ = makeFetch([
      {
        urlIncludes: "/templates",
        status: 500,
        body: { error: { code: "internal", message: "boom" }, requestId: "r" },
      },
    ]);
    renderPicker(fetch_);

    expect(await screen.findByTestId("clone-from-template-error")).toBeInTheDocument();
  });

  it("posts a clone draft with the d20 version id when the d20 button is clicked", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/templates", body: TEMPLATES },
      {
        urlIncludes: "/systems",
        method: "POST",
        body: {
          workspace: {
            system: {
              systemId: "new-system",
              name: "Clone of d20",
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
        },
      },
    ]);
    renderPicker(fetch_);

    const button = await screen.findByTestId("clone-from-template-d20");
    await userEvent.click(button);

    await waitFor(() => {
      const postCall = fetch_.mock.calls.find(
        (c) =>
          (c[0] as string).endsWith("/systems") && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse((postCall?.[1] as { body: string }).body);
      expect(body.source).toEqual({
        kind: "clone",
        versionId: "a0000000-0000-5000-8000-000000000002",
      });
      expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    });
  });

  it("surfaces a per-template error message when the clone request fails", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/templates", body: TEMPLATES },
      {
        urlIncludes: "/systems",
        method: "POST",
        status: 500,
        body: { error: { code: "internal", message: "boom" }, requestId: "r" },
      },
    ]);
    renderPicker(fetch_);

    const button = await screen.findByTestId("clone-from-template-d20");
    await userEvent.click(button);

    expect(await screen.findByTestId("clone-from-template-error-d20")).toBeInTheDocument();
  });

  it("issues a GET request to /templates on mount", async () => {
    const fetch_ = makeFetch([{ urlIncludes: "/templates", body: TEMPLATES }]);
    renderPicker(fetch_);

    await screen.findByTestId("clone-from-template-list");
    const call = fetch_.mock.calls.find((c) => (c[0] as string).endsWith("/templates"));
    expect(call).toBeDefined();
    expect((call?.[1] as RequestInit | undefined)?.method).toBe("GET");
  });
});