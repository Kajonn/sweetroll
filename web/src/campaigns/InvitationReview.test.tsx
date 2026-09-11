// web/src/campaigns/InvitationReview.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InvitationReviewView } from "./InvitationReview.js";

describe("InvitationReviewView", () => {
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
});
