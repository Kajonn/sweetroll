import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { CampaignProposals } from "./CampaignProposals.js";
import type {
  CampaignProposalsApi,
  CampaignProposal,
} from "./campaignProposalApi.js";
const proposal: CampaignProposal = {
  proposalId: "p",
  campaignId: "c",
  submitterId: "player",
  kind: "item",
  content: { name: "Tower key", notes: "Private text", defaultQuantity: 2 },
  status: "pending",
  revision: 1,
  createdAt: "2026-10-31T00:00:00Z",
  updatedAt: "2026-10-31T00:00:00Z",
  decision: null,
  approvedTemplateId: null,
};
function setup(isGm = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const api: CampaignProposalsApi = {
    list: vi
      .fn()
      .mockResolvedValue({
        proposals: [
          {
            ...proposal,
            ...(isGm
              ? { eligibility: { canApprove: true, reason: null } }
              : {}),
          },
        ],
        nextCursor: null,
      }),
    submit: vi.fn().mockResolvedValue({ proposal }),
    approve: vi
      .fn()
      .mockResolvedValue({ proposal: { ...proposal, status: "approved" } }),
    reject: vi
      .fn()
      .mockResolvedValue({ proposal: { ...proposal, status: "rejected" } }),
  };
  const props = {
    api,
    campaignId: "c",
    actorId: "player",
    generation: 1,
    isGm,
    online: true,
    readOnly: false,
    onAccessRevoked: vi.fn(),
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = render(<CampaignProposals {...props} />, { wrapper });
  return { api, client, props, ...view, user: userEvent.setup() };
}
it("submits data-only text and retries the exact frozen request after response loss", async () => {
  const { api, user } = setup();
  vi.mocked(api.submit).mockRejectedValueOnce(new TypeError("Response lost"));
  await user.click(
    await screen.findByRole("button", { name: "Suggest a template" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "New key");
  await user.click(screen.getByRole("button", { name: "Submit suggestion" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("New key");
  expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Retry exact request" }));
  await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.submit).mock.calls[1]).toEqual(
    vi.mocked(api.submit).mock.calls[0],
  );
  expect(vi.mocked(api.submit).mock.calls[0]![1]).toMatchObject({
    kind: "item",
    content: { name: "New key" },
    expectedProposalRevision: 0,
  });
});
it("requires exact-content GM confirmation and supports rejection without publication", async () => {
  const { api, user } = setup(true);
  await user.click(
    await screen.findByRole("button", { name: "Review suggestion" }),
  );
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("Private text")).toBeInTheDocument();
  expect(api.approve).not.toHaveBeenCalled();
  await user.click(
    within(dialog).getByRole("button", {
      name: "Approve and publish to all members",
    }),
  );
  await waitFor(() =>
    expect(api.approve).toHaveBeenCalledWith(
      "c",
      "p",
      expect.objectContaining({ expectedProposalRevision: 1 }),
    ),
  );
});
it("discards a delayed GM list and removes private review data when demoted", async () => {
  const { api, client, props, rerender } = setup(true);
  await screen.findByText("Private text");
  let resolve!: (v: {
    proposals: CampaignProposal[];
    nextCursor: null;
  }) => void;
  vi.mocked(api.list).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  void client.invalidateQueries({ queryKey: ["campaigns", "proposals"] });
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  vi.mocked(api.list).mockResolvedValue({ proposals: [], nextCursor: null });
  rerender(<CampaignProposals {...props} isGm={false} />);
  resolve({
    proposals: [{ ...proposal, content: { name: "Secret late reply" } }],
    nextCursor: null,
  });
  await waitFor(() => expect(screen.queryByText("Private text")).toBeNull());
  expect(screen.queryByText("Secret late reply")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Review suggestion" }),
  ).toBeNull();
});
it("requires explicit refresh after conflicts and never posts on reload or offline", async () => {
  const { api, user, props, rerender } = setup();
  vi.mocked(api.submit).mockRejectedValue({ status: 409 });
  await user.click(
    await screen.findByRole("button", { name: "Suggest a template" }),
  );
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Conflict");
  await user.click(screen.getByRole("button", { name: "Submit suggestion" }));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Refresh and review" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry exact request" }),
  ).toBeNull();
  rerender(<CampaignProposals {...props} online={false} />);
  expect(
    screen.getByRole("button", { name: "Submit suggestion" }),
  ).toBeDisabled();
  expect(api.submit).toHaveBeenCalledTimes(1);
});
