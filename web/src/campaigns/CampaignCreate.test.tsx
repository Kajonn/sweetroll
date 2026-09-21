// web/src/campaigns/CampaignCreate.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignCreate } from "./CampaignCreate.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const versions = [
  { versionId: "v1", systemId: "s1", systemName: "D20 System", semanticVersion: "1.0.0", createdAt: "2026-09-01T00:00:00Z" },
];

describe("CampaignCreate", () => {
  it("distinguishes versions with the same system name and number", async () => {
    const api = { createCampaign: vi.fn().mockResolvedValue({ campaign: { campaignId: "c9" } }) };
    const versionsApi = { listCreationVersions: vi.fn().mockResolvedValue({ data: { versions: [
      { ...versions[0], versionId: "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { ...versions[0], versionId: "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb", createdAt: "2026-09-02T00:00:00Z" },
    ], nextCursor: null } }) };
    render(<CampaignCreate api={api as never} versionsApi={versionsApi as never} actorId="u1" online navigation={{ onCreated: () => {} }} />, { wrapper: wrapper() });
    const choices = await screen.findAllByRole("button", { name: /d20 system 1\.0\.0/i });
    expect(choices).toHaveLength(2);
    expect(choices[0]).toHaveAccessibleName(/11111111/);
    expect(choices[1]).toHaveAccessibleName(/22222222/);
    fireEvent.click(choices[1]!);
    fireEvent.change(screen.getByLabelText(/campaign title/i), { target: { value: "North Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    await vi.waitFor(() => expect(api.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ systemVersionId: "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb" })));
  });
  it("creates a campaign from the selected version with a fresh idempotency key", async () => {
    const api = { createCampaign: vi.fn().mockResolvedValue({ campaign: { campaignId: "c9" }, requestId: "r" }) };
    const versionsApi = { listCreationVersions: vi.fn().mockResolvedValue({ data: { versions, nextCursor: null }, requestId: "r" }) };
    const onCreated = vi.fn();
    render(<CampaignCreate api={api as never} versionsApi={versionsApi as never} actorId="u1" online navigation={{ onCreated }} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /d20 system 1\.0\.0/i }));
    fireEvent.change(screen.getByLabelText(/campaign title/i), { target: { value: "North Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    await vi.waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
    const body = (api.createCampaign as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(body).toMatchObject({ systemVersionId: "v1", title: "North Watch" });
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onCreated).toHaveBeenCalledWith("c9");
  });

  it("retries with a fresh key after a create conflict (409), never merging", async () => {
    const api = {
      createCampaign: vi.fn()
        .mockRejectedValueOnce({ code: "conflict", status: 409, message: "taken" })
        .mockResolvedValueOnce({ campaign: { campaignId: "c9" }, requestId: "r2" }),
    };
    const versionsApi = { listCreationVersions: vi.fn().mockResolvedValue({ data: { versions, nextCursor: null }, requestId: "r" }) };
    render(<CampaignCreate api={api as never} versionsApi={versionsApi as never} actorId="u1" online navigation={{ onCreated: () => {} }} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /d20 system 1\.0\.0/i }));
    fireEvent.change(screen.getByLabelText(/campaign title/i), { target: { value: "North Watch" } });
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    expect(await screen.findByText(/something changed/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /create campaign/i }));
    await vi.waitFor(() => expect(api.createCampaign).toHaveBeenCalledTimes(2));
    const [first, second] = (api.createCampaign as ReturnType<typeof vi.fn>).mock.calls;
    expect(first![0].idempotencyKey).not.toBe(second![0].idempotencyKey);
  });
});
