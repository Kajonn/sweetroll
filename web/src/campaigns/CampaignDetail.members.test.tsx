// web/src/campaigns/CampaignDetail.members.test.tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignDetail } from "./CampaignDetail.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const campaign = {
  campaignId: "c1", ownerId: "u1", systemVersionId: "v1",
  title: "North Watch", description: "A border fort.",
  status: "active", revision: 4, accessRevision: 1, archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};

describe("CampaignDetail members tab", () => {
  it("shows roster and invitations without settings to the campaign owner", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [{ campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }],
        nextCursor: null, requestId: "r2",
      }),
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r3" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    const tab = await screen.findByRole("tab", { name: /members/i });
    tab.click();
    expect(await screen.findByText(/^invitations$/i)).toBeVisible();
    expect(screen.queryByText(/campaign settings/i)).toBeNull();
  });

  it("shows a Settings tab with management sections to the campaign owner", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [{ campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }],
        nextCursor: null, requestId: "r2",
      }),
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r3" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    const tab = await screen.findByRole("tab", { name: /settings/i });
    tab.click();
    expect(await screen.findByText(/campaign settings/i)).toBeVisible();
  });

  it("hides the Settings tab from players", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
          { campaignId: "c1", userId: "u2", role: "member", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r3" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u2" onLeft={() => {}} />, { wrapper: wrapper() });
    await screen.findByRole("tab", { name: /members/i });
    expect(screen.queryByRole("tab", { name: /settings/i })).toBeNull();
  });
});
