// web/src/campaigns/InvitationManager.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { InvitationManager } from "./InvitationManager.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const issued = (token: string | null) => ({
  invitation: token === null
    ? { invitationId: "i1", campaignId: "c1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, issuedBy: "u1", tokenUnavailable: true as const }
    : { invitationId: "i1", campaignId: "c1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, issuedBy: "u1", token: token },
  requestId: "r",
});

describe("InvitationManager", () => {
  it("issues an invitation and shows the token once", async () => {
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r0" }),
      issueInvitation: vi.fn().mockResolvedValue(issued("secret-token")),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /issue invitation/i }));
    await vi.waitFor(() => expect(api.issueInvitation).toHaveBeenCalledWith("c1", expect.objectContaining({
      intendedRole: "player",
      expectedCampaignRevision: 4,
    })));
    expect(await screen.findByText("secret-token")).toBeVisible();
    expect(screen.getByText(/shown once/i)).toBeVisible();
  });

  it("reports tokenUnavailable replays without leaking a token", async () => {
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [], nextCursor: null, requestId: "r0" }),
      issueInvitation: vi.fn().mockResolvedValue(issued(null)),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /issue invitation/i }));
    expect(await screen.findByText(/cannot be recovered/i)).toBeVisible();
  });

  it("revokes behind a confirmation dialog", async () => {
    const pending = { invitationId: "i1", intendedRole: "player", status: "pending", expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 2, issuedBy: "u1", createdAt: "2026-09-01T00:00:00Z" };
    const api = {
      listInvitations: vi.fn().mockResolvedValue({ invitations: [pending], nextCursor: null, requestId: "r0" }),
      revokeInvitation: vi.fn().mockResolvedValue({ invitation: pending, requestId: "r2" }),
    };
    render(<InvitationManager api={api as never} campaignId="c1" campaignRevision={4} actorId="u1" generation={0} online onChanged={() => {}} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /revoke/i }));
    fireEvent.click(await screen.findByRole("button", { name: /revoke invitation/i }));
    await vi.waitFor(() => expect(api.revokeInvitation).toHaveBeenCalledWith("c1", "i1", expect.objectContaining({
      expectedInvitationRevision: 2,
      expectedCampaignRevision: 4,
    })));
  });
});
