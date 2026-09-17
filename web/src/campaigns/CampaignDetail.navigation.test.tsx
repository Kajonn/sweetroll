// web/src/campaigns/CampaignDetail.navigation.test.tsx
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

function apiAs(role: "owner" | "member", actorId: string) {
  const members =
    role === "owner"
      ? [{ campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }]
      : [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
          { campaignId: "c1", userId: "u2", role: "member", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ];
  return {
    openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
    listMembers: vi.fn().mockResolvedValue({ members, nextCursor: null, requestId: "r2" }),
    listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r3" }),
  };
}

/**
 * Section 4 consistency lock (GUI plan G7, accepted 2026-09-17): the
 * campaign detail exposes every §4 GM surface — Session, Content,
 * Characters, Members, Settings — with Session/Settings GM-gated, plus
 * Activity as a documented additional tab. Tab order intentionally keeps
 * Characters first (landing tab for all roles) rather than the §4
 * document order; see docs/acceptance/gui-2026-09-17-g7-section4-nav.md.
 */
describe("CampaignDetail section-4 navigation", () => {
  it("shows all five section-4 surfaces plus Activity to the campaign owner", async () => {
    render(<CampaignDetail api={apiAs("owner", "u1") as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, {
      wrapper: wrapper(),
    });
    for (const name of ["Characters", "Content", "Members", "Activity", "Session", "Settings"]) {
      expect(await screen.findByRole("tab", { name })).toBeVisible();
    }
  });

  it("shows the shared surfaces but gates Session and Settings from players", async () => {
    render(<CampaignDetail api={apiAs("member", "u2") as never} campaignId="c1" actorId="u2" onLeft={() => {}} />, {
      wrapper: wrapper(),
    });
    for (const name of ["Characters", "Content", "Members", "Activity"]) {
      expect(await screen.findByRole("tab", { name })).toBeVisible();
    }
    expect(screen.queryByRole("tab", { name: "Session" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();
  });
});
