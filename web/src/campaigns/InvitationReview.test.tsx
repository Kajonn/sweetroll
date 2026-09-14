// web/src/campaigns/InvitationReview.test.tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppRouter, resetAppRouter } from "../shell/appNavigation.js";
import { InvitationReviewView } from "./InvitationReview.js";

describe("InvitationReviewView", () => {
  afterEach(() => {
    resetAppRouter();
  });

  it("shows campaign identity and confirm/decline actions after review", async () => {
    const api = {
      reviewInvitation: vi.fn().mockResolvedValue({
        review: {
          invitationId: "i1", campaignId: "c1", campaignTitle: "Thursday Knights",
          systemVersionId: "v1", inviterDisplayName: "Ada", intendedRole: "player",
          expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, accessRevision: 3,
        },
        requestId: "r1",
      }),
    };
    render(<InvitationReviewView api={api as never} actorId="u1" token="tok" />);
    expect(await screen.findByText("Thursday Knights")).toBeVisible();
    expect(screen.getByRole("button", { name: /accept/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /decline/i })).toBeVisible();
  });

  it("maps unknown/expired tokens to an unavailable state, never the token", async () => {
    const api = {
      reviewInvitation: vi.fn().mockRejectedValue({ code: "not_found", status: 404, message: "nope" }),
    };
    const { container } = render(<InvitationReviewView api={api as never} actorId="u1" token="tok" />);
    expect(await screen.findByText(/unavailable|expired|revoked/i)).toBeVisible();
    expect(container.textContent).not.toContain("tok");
  });

  it("client-navigates the accepted-open link", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    const api = {
      reviewInvitation: vi.fn().mockResolvedValue({
        review: {
          invitationId: "i1", campaignId: "c1", campaignTitle: "Thursday Knights",
          systemVersionId: "v1", inviterDisplayName: "Ada", intendedRole: "player",
          expiresAt: "2026-10-01T00:00:00Z", invitationRevision: 1, accessRevision: 3,
        },
        requestId: "r1",
      }),
      acceptInvitation: vi.fn().mockResolvedValue({ requestId: "r2" }),
    };
    render(<InvitationReviewView api={api as never} actorId="u1" token="tok" />);
    await user.click(await screen.findByRole("button", { name: /accept/i }));
    await user.click(await screen.findByRole("link", { name: /open campaign/i }));
    expect(push).toHaveBeenCalledWith("/campaigns/c1");
  });
});
