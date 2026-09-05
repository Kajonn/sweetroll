import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient, type ApiClient } from "../api/client.js";
import { VersionHistory } from "./VersionHistory.js";

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

function renderHistory(fetch_: ReturnType<typeof vi.fn>, systemId = "s1") {
  const client: ApiClient = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <VersionHistory client={client} systemId={systemId} />
    </QueryClientProvider>,
  );
  return { client, qc };
}

const TWO_VERSIONS = {
  versions: [
    {
      versionId: "v1",
      systemId: "s1",
      semanticVersion: "1.0.0",
      checksum: "abc",
      releaseNotes: "first",
      lifecycle: "active",
      createdAt: "2026-01-02T00:00:00Z",
    },
    {
      versionId: "v2",
      systemId: "s1",
      semanticVersion: "0.9.0",
      checksum: "def",
      releaseNotes: "older",
      lifecycle: "deprecated",
      createdAt: "2025-12-01T00:00:00Z",
    },
  ],
  requestId: "r",
};

describe("VersionHistory", () => {
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

  it("renders a loading indicator, then rows for each version", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/systems/s1/versions", body: TWO_VERSIONS },
    ]);
    renderHistory(fetch_);

    expect(await screen.findByTestId("version-history-table")).toBeInTheDocument();
    expect(screen.getByTestId("version-history-row-v1")).toHaveTextContent("1.0.0");
    expect(screen.getByTestId("version-history-row-v2")).toHaveTextContent("0.9.0");
    expect(screen.getByTestId("version-history-lifecycle-v1")).toHaveTextContent("Active");
    expect(screen.getByTestId("version-history-lifecycle-v2")).toHaveTextContent("Deprecated");
  });

  it("shows an empty state when there are no versions", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/systems/s1/versions", body: { versions: [], requestId: "r" } },
    ]);
    renderHistory(fetch_);
    expect(await screen.findByTestId("version-history-empty")).toBeInTheDocument();
  });

  it("exports a version: GET /system-versions/:id/export and triggers a download", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/systems/s1/versions", body: TWO_VERSIONS },
      {
        urlIncludes: "/system-versions/v1/export",
        body: { schemaVersion: "1.0", mediaType: "x", exportedAt: "2026", package: {} },
      },
    ]);
    const click = vi.fn();
    const originalCreate = document.createElement.bind(document);
    const createSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tag: string) => {
        const el = originalCreate(tag);
        if (tag === "a") (el as HTMLAnchorElement).click = click;
        return el;
      }) as typeof document.createElement);
    renderHistory(fetch_);

    await screen.findByTestId("version-history-table");
    await userEvent.click(screen.getByTestId("version-history-export-v1"));

    await waitFor(() => expect(click).toHaveBeenCalled());
    createSpy.mockRestore();
    const exportCall = fetch_.mock.calls.find(
      (c) => (c[0] as string).includes("/system-versions/v1/export") && c[1]?.method === "GET",
    );
    expect(exportCall).toBeDefined();
  });

  it("deprecates a version after confirmation", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/systems/s1/versions", body: TWO_VERSIONS },
      {
        urlIncludes: "/system-versions/v1",
        method: "PATCH",
        body: {
          lifecycle: { kind: "version", versionId: "v1", systemId: "s1", lifecycle: "deprecated" },
          requestId: "r",
        },
      },
    ]);
    renderHistory(fetch_);

    await screen.findByTestId("version-history-table");
    await userEvent.click(screen.getByTestId("version-history-deprecate-v1"));
    expect(await screen.findByTestId("version-history-deprecate-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("version-history-deprecate-confirm"));

    await waitFor(() =>
      expect(
        fetch_.mock.calls.some(
          (c) =>
            (c[0] as string).includes("/system-versions/v1") &&
            c[1]?.method === "PATCH" &&
            JSON.parse(c[1]?.body as string).lifecycle === "deprecated",
        ),
      ).toBe(true),
    );
  });

  it("disables the deprecate button for already deprecated versions", async () => {
    const fetch_ = makeFetch([
      { urlIncludes: "/systems/s1/versions", body: TWO_VERSIONS },
    ]);
    renderHistory(fetch_);
    await screen.findByTestId("version-history-table");
    expect(screen.getByTestId("version-history-deprecate-v2")).toBeDisabled();
    expect(screen.getByTestId("version-history-deprecate-v1")).not.toBeDisabled();
  });
});
