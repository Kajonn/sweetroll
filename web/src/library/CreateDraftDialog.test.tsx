import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import buttonStyles from "../ui/Button.module.css";
import { CreateDraftDialog } from "./CreateDraftDialog.js";

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

describe("CreateDraftDialog", () => {
  beforeEach(() => {
    navigateMock.mockReset();
  });

  it("posts a blank draft on submit", async () => {
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/systems") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            workspace: {
              system: {
                systemId: "s1",
                name: "Untitled system",
                access: "owner",
                lifecycle: "active",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
              },
              draft: null,
              versions: [],
              assessment: { ok: true, diagnostics: [] },
            },
            requestId: "r",
          }),
          { status: 201 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CreateDraftDialog client={client} open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByTestId("create-draft-submit"));
    expect(fetch_).toHaveBeenCalledWith(expect.stringContaining("/systems"), expect.objectContaining({ method: "POST" }));
    await vi.waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith(
        expect.objectContaining({ to: "/systems/$systemId", params: { systemId: "s1" } }),
      );
    });
  });

  it("exposes three source radio options", () => {    const client = createApiClient({ baseUrl: "http://x", fetch: vi.fn() as typeof fetch });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <CreateDraftDialog client={client} open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("create-draft-kind-blank")).toBeInTheDocument();
    expect(screen.getByTestId("create-draft-kind-clone")).toBeInTheDocument();
    expect(screen.getByTestId("create-draft-kind-import")).toBeInTheDocument();
  });

  it("submits on the shared primary Button with a single-labeled name field", () => {
    const client = createApiClient({ baseUrl: "http://x", fetch: vi.fn() as typeof fetch });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <CreateDraftDialog client={client} open onOpenChange={() => {}} />
      </QueryClientProvider>,
    );
    const submit = screen.getByTestId("create-draft-submit");
    expect(submit.className.split(/\s+/)).toContain(buttonStyles.button);
    expect(submit.className.split(/\s+/)).toContain(buttonStyles.buttonPrimary);
    const name = screen.getByTestId("create-draft-name");
    expect(name.id).not.toBe("");
    expect(document.querySelectorAll(`label[for="${name.id}"]`)).toHaveLength(1);
    const css = readFileSync(resolve(process.cwd(), "src/library/CreateDraftDialog.module.css"), "utf8");
    expect(css).not.toMatch(/var\(--color-/);
  });
});