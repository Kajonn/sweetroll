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

it.each(["accept", "decline"] as const)("retains a manually reviewed token through %s", async (kind) => {
  const user = userEvent.setup();
  const api = {
    reviewInvitation: vi.fn().mockResolvedValue({ review: {
      invitationId: "i1", campaignId: "c1", campaignTitle: "Manual campaign",
      systemVersionId: "v1", inviterDisplayName: "Ada", intendedRole: "player",
      expiresAt: "2026-12-01T00:00:00Z", invitationRevision: 2, accessRevision: 4,
    }}),
    acceptInvitation: vi.fn().mockResolvedValue({}),
    declineInvitation: vi.fn().mockResolvedValue({}),
  };
  render(<InvitationReviewView api={api as never} actorId="player" token="" />);
  await user.type(screen.getByLabelText("Invitation token"), "manual-secret");
  await user.click(screen.getByRole("button", { name: "Review invitation" }));
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${kind}`, "i") }));
  expect(api[kind === "accept" ? "acceptInvitation" : "declineInvitation"]).toHaveBeenCalledWith(
    expect.objectContaining({ token: "manual-secret", expectedInvitationRevision: 2, reviewedAccessRevision: 4 }),
  );
  expect(document.body.textContent).not.toContain("manual-secret");
  expect(api.reviewInvitation).toHaveBeenCalledTimes(1);
});

it("ignores a stale review when navigation supplies a new URL token", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  const review = { campaignId: "c2", campaignTitle: "New invitation", inviterDisplayName: "Ada", intendedRole: "player", expiresAt: "2026-12-01", invitationRevision: 3, accessRevision: 8 };
  const api = { reviewInvitation: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ review }), acceptInvitation: vi.fn().mockResolvedValue({}) };
  const view = render(<InvitationReviewView api={api as never} actorId="p1" token="old-secret" />);
  view.rerender(<InvitationReviewView api={api as never} actorId="p1" token="new-secret" />);
  await screen.findByText("New invitation");
  finish({ review: { ...review, campaignTitle: "Stale invitation" } });
  await user.click(screen.getByRole("button", { name: "Accept" }));
  expect(api.acceptInvitation).toHaveBeenCalledWith(expect.objectContaining({ token: "new-secret", campaignId: "c2" }));
  expect(screen.queryByText("Stale invitation")).toBeNull();
});

it("allows correcting an invalid manually entered token without echoing it", async () => {
  const user = userEvent.setup();
  const api = { reviewInvitation: vi.fn().mockRejectedValueOnce({ status: 404 }).mockResolvedValue({ review: { campaignTitle: "Corrected", inviterDisplayName: "Ada" } }) };
  render(<InvitationReviewView api={api as never} actorId="p1" token="" />);
  await user.type(screen.getByLabelText("Invitation token"), "bad-secret");
  await user.click(screen.getByRole("button", { name: "Review invitation" }));
  await user.click(await screen.findByRole("button", { name: "Enter another invitation" }));
  await user.type(screen.getByLabelText("Invitation token"), "corrected-secret");
  await user.click(screen.getByRole("button", { name: "Review invitation" }));
  expect(await screen.findByText("Corrected")).toBeVisible();
  expect(api.reviewInvitation).toHaveBeenLastCalledWith({ token: "corrected-secret" });
});

it("does not apply a late mutation to another invitation and safely unmounts pending review", async () => {
  const user = userEvent.setup();
  let finish!: (value: unknown) => void;
  const api = { reviewInvitation: vi.fn().mockResolvedValue({ review: { campaignId: "c1", campaignTitle: "Original", inviterDisplayName: "Ada" } }), acceptInvitation: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) };
  const view = render(<InvitationReviewView api={api as never} actorId="p1" token="first" />);
  await user.click(await screen.findByRole("button", { name: "Accept" }));
  view.rerender(<InvitationReviewView api={api as never} actorId="p1" token="" />);
  finish({});
  expect(await screen.findByLabelText("Invitation token")).toBeVisible();
  expect(screen.queryByRole("link", { name: "Open campaign" })).toBeNull();
  view.unmount();
});
