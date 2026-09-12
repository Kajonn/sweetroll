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

describe("CampaignDetail session tab", () => {
  it("shows the session tab to the campaign owner and hides it from players", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
          { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
    };
    const { unmount } = render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    expect(await screen.findByRole("tab", { name: /session/i })).toBeVisible();
    unmount();
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u2" onLeft={() => {}} />, { wrapper: wrapper() });
    await screen.findByRole("tab", { name: /members/i });
    expect(screen.queryByRole("tab", { name: /session/i })).toBeNull();
  });
});
