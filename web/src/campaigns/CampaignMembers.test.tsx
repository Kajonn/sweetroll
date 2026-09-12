// web/src/campaigns/CampaignMembers.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignMembersTab, ownRole } from "./CampaignMembers.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const members = [
  { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
  { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
];

describe("ownRole", () => {
  it("derives the actor role from the roster", () => {
    expect(ownRole(members as never, "u1")).toBe("owner");
    expect(ownRole(members as never, "u2")).toBe("player");
    expect(ownRole(members as never, "u9")).toBeNull();
  });
});

describe("CampaignMembersTab", () => {
  it("changes a member role behind confirmation with revision + fresh key", async () => {
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members, nextCursor: null, requestId: "r" }),
      changeMemberRole: vi.fn().mockResolvedValue({ member: members[1], requestId: "r2" }),
    };
    render(<CampaignMembersTab api={api as never} campaignId="c1" actorId="u1" campaignRevision={4} generation={0} online onChanged={() => {}} onAccessRevoked={() => {}} />, { wrapper: wrapper() });
    expect(await screen.findByText(/co-gm/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /change role/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm role change/i }));
    await vi.waitFor(() => expect(api.changeMemberRole).toHaveBeenCalledWith("c1", "u2", expect.objectContaining({
      expectedCampaignRevision: 4,
    })));
    const body = (api.changeMemberRole as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("hides management actions from player-role actors", async () => {
    const api = {
      listMembers: vi.fn().mockResolvedValue({ members, nextCursor: null, requestId: "r" }),
    };
    render(<CampaignMembersTab api={api as never} campaignId="c1" actorId="u2" campaignRevision={4} generation={0} online onChanged={() => {}} onAccessRevoked={() => {}} />, { wrapper: wrapper() });
    await screen.findByText(/owner/i);
    expect(screen.queryByRole("button", { name: /change role/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });
});
