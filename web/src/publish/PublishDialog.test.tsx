import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApiClient } from "../api/client.js";
import buttonStyles from "../ui/Button.module.css";
import { PublishDialog } from "./PublishDialog.js";

type RenderOptions = {
  fetch_?: ReturnType<typeof vi.fn>;
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  expectedRevision?: number;
};

function renderDialog({
  fetch_ = vi.fn(async () => new Response("{}", { status: 200 })),
  open = true,
  onOpenChange = vi.fn(),
  expectedRevision = 5,
}: RenderOptions = {}) {
  const client = createApiClient({ baseUrl: "http://x", fetch: fetch_ as typeof fetch });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PublishDialog
        client={client}
        open={open}
        onOpenChange={onOpenChange}
        systemId="s1"
        expectedRevision={expectedRevision}
      />
    </QueryClientProvider>,
  );
  return { fetch_, onOpenChange };
}

describe("PublishDialog", () => {
  it("renders semver input, release notes textarea, and confirm button", () => {
    renderDialog();
    expect(screen.getByTestId("publish-dialog-semver")).toBeInTheDocument();
    expect(screen.getByTestId("publish-dialog-release-notes")).toBeInTheDocument();
    expect(screen.getByTestId("publish-dialog-submit")).toBeInTheDocument();
  });

  it("publish dialog uses shared Button roles", () => {
    renderDialog();
    // submit button with accessible name /Publish/i using shared Button variant=primary
    const submit = screen.getByRole("button", { name: /publish/i });
    expect(submit).toHaveAttribute("data-testid", "publish-dialog-submit");
    expect(submit.className.split(/\s+/)).toContain(buttonStyles.button);
    expect(submit.className.split(/\s+/)).toContain(buttonStyles.buttonPrimary);
  });

  it("labels each publish field once and consumes semantic tokens only", () => {
    renderDialog();
    const semver = screen.getByTestId("publish-dialog-semver");
    expect(semver.id).not.toBe("");
    expect(document.querySelectorAll(`label[for="${semver.id}"]`)).toHaveLength(1);
    const css = readFileSync(resolve(process.cwd(), "src/publish/PublishDialog.module.css"), "utf8");
    expect(css).not.toMatch(/var\(--color-/);
  });

  it("defaults the semver input to 0.1.0", () => {
    renderDialog();
    expect(screen.getByTestId("publish-dialog-semver")).toHaveValue("0.1.0");
  });

  it("PATCH / MINOR / MAJOR buttons bump the semver input", async () => {
    const user = userEvent.setup();
    renderDialog();
    const input = screen.getByTestId("publish-dialog-semver") as HTMLInputElement;
    await user.click(screen.getByTestId("publish-dialog-bump-patch"));
    expect(input).toHaveValue("0.1.1");
    await user.click(screen.getByTestId("publish-dialog-bump-minor"));
    expect(input).toHaveValue("0.2.0");
    await user.click(screen.getByTestId("publish-dialog-bump-major"));
    expect(input).toHaveValue("1.0.0");
  });

  it("posts the form values to /systems/:id/publish on confirm", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/publish") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            version: {
              versionId: "v1",
              systemId: "s1",
              semanticVersion: "1.0.0",
              checksum: "abc",
              package: {},
              releaseNotes: "first",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
            },
            requestId: "r",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });
    renderDialog({ fetch_, expectedRevision: 3 });
    await user.clear(screen.getByTestId("publish-dialog-semver"));
    await user.type(screen.getByTestId("publish-dialog-semver"), "1.0.0");
    await user.type(screen.getByTestId("publish-dialog-release-notes"), "first release");
    await user.click(screen.getByTestId("publish-dialog-submit"));

    await vi.waitFor(() => expect(fetch_).toHaveBeenCalledTimes(1));
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined];
    expect(call[0]).toContain("/systems/s1/publish");
    expect(call[1]?.method).toBe("POST");
    expect(JSON.parse(call[1]?.body as string)).toMatchObject({
      expectedRevision: 3,
      semanticVersion: "1.0.0",
      releaseNotes: "first release",
      idempotencyKey: expect.any(String),
    });
  });

  it("lists every breaking-change finding returned by the server", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/publish") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_package",
              message: "Breaking changes detected.",
              diagnostics: [
                {
                  code: "breaking_removed_definition",
                  path: "/entities/character/fields/proficient",
                  message: 'Field "proficient" was removed from entity "character".',
                },
                {
                  code: "breaking_required_added",
                  path: "/entities/character/fields/ancestry",
                  message: 'Field "ancestry" is now required.',
                },
              ],
            },
            requestId: "r",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });
    renderDialog({ fetch_ });
    await user.type(screen.getByTestId("publish-dialog-release-notes"), "destructive change");
    await user.click(screen.getByTestId("publish-dialog-submit"));

    const finding1 = await screen.findByTestId(
      "publish-dialog-finding-breaking_removed_definition-/entities/character/fields/proficient",
    );
    expect(finding1).toBeInTheDocument();
    expect(finding1).toHaveTextContent(/breaking_removed_definition/);
    expect(finding1).toHaveTextContent(/\/entities\/character\/fields\/proficient/);

    expect(
      screen.getByTestId(
        "publish-dialog-finding-breaking_required_added-/entities/character/fields/ancestry",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the confirm button disabled until every breaking finding is acknowledged", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/publish") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            error: {
              code: "invalid_package",
              message: "Breaking changes detected.",
              diagnostics: [
                {
                  code: "breaking_removed_definition",
                  path: "/entities/character/fields/proficient",
                  message: 'Field "proficient" was removed from entity "character".',
                },
                {
                  code: "breaking_required_added",
                  path: "/entities/character/fields/ancestry",
                  message: 'Field "ancestry" is now required.',
                },
              ],
            },
            requestId: "r",
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });
    renderDialog({ fetch_ });
    await user.type(screen.getByTestId("publish-dialog-release-notes"), "destructive change");
    await user.click(screen.getByTestId("publish-dialog-submit"));

    const submit = await screen.findByTestId("publish-dialog-submit");
    expect(submit).toBeDisabled();

    await user.click(
      screen.getByTestId(
        "publish-dialog-finding-checkbox-breaking_removed_definition-/entities/character/fields/proficient",
      ),
    );
    expect(submit).toBeDisabled();

    await user.click(
      screen.getByTestId(
        "publish-dialog-finding-checkbox-breaking_required_added-/entities/character/fields/ancestry",
      ),
    );
    expect(submit).not.toBeDisabled();
  });

  it("replaces the form with a success card on a 200 response", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/publish") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            version: {
              versionId: "v1",
              systemId: "s1",
              semanticVersion: "1.0.0",
              checksum: "deadbeef",
              package: {},
              releaseNotes: "init",
              lifecycle: "active",
              createdAt: "2026-01-01T00:00:00Z",
            },
            requestId: "r",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    });
    renderDialog({ fetch_ });
    await user.click(screen.getByTestId("publish-dialog-submit"));
    expect(await screen.findByTestId("publish-dialog-success")).toBeInTheDocument();
    expect(screen.getByTestId("publish-dialog-success")).toHaveTextContent("1.0.0");
    expect(screen.getByTestId("publish-dialog-success")).toHaveTextContent("deadbeef");
  });
});
