// web/src/campaigns/CampaignContent.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { audienceLabel, campaignContentKey, CampaignContentTab, CampaignContentView } from "./CampaignContent.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("audienceLabel", () => {
  it("names the audience in plain language for every level", () => {
    expect(audienceLabel("gm_only")).toMatch(/gm|game master/i);
    expect(audienceLabel("all_players")).toMatch(/all players|everyone/i);
    expect(audienceLabel("selected_players")).toMatch(/selected|specific/i);
    expect(audienceLabel("owner_only")).toMatch(/only you|private/i);
  });
});

describe("campaignContentKey", () => {
  it("scopes keys by actor and generation under the revocation prefix", () => {
    expect(campaignContentKey("c1", "u1", 2)).toEqual(["campaigns", "content", "c1", "u1", 2]);
    // The leading ["campaigns", "content", campaignId] prefix is unchanged,
    // so CampaignDetail.handleAccessRevoked purges still cover these keys.
    const [a, b, c] = campaignContentKey("c1", "u1", 2);
    expect([a, b, c]).toEqual(["campaigns", "content", "c1"]);
  });
});

describe("CampaignContentTab online gating", () => {
  it("does not fetch the list while offline or before the actor is known", async () => {
    const api = { listContent: vi.fn() };
    const { unmount } = render(
      <CampaignContentTab api={api as never} campaignId="c1" actorId="u1" online={false} />,
      { wrapper: wrapper() },
    );
    await vi.waitFor(() => expect(screen.getByRole("status")).toBeVisible());
    expect(api.listContent).not.toHaveBeenCalled();
    unmount();
    const api2 = { listContent: vi.fn() };
    render(<CampaignContentTab api={api2 as never} campaignId="c1" actorId={null} online />,
      { wrapper: wrapper() });
    await vi.waitFor(() => expect(screen.getByRole("status")).toBeVisible());
    expect(api2.listContent).not.toHaveBeenCalled();
  });
});

describe("CampaignContentTab list-level Hide", () => {
  it("deletes and reloads without retaining a deleted view for recovery", async () => {
    const view = { contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan", body: "Shh.", tags: [], revision: 3, grantedUserIds: [], status: "active" };
    const api = {
      listContent: vi.fn().mockResolvedValue({ content: [{ contentId: "n1", title: "Plan", audience: "all_players" }], nextCursor: null, requestId: "r" }),
      openContent: vi.fn().mockResolvedValue({ content: view, requestId: "r" }),
      deleteContent: vi.fn().mockResolvedValue({ content: {}, requestId: "r" }),
    };
    const onChanged = vi.fn();
    render(
      <CampaignContentTab api={api as never} campaignId="c1" actorId="u1" generation={0} online isGm members={[]} onChanged={onChanged} />,
      { wrapper: wrapper() },
    );
    fireEvent.click(await screen.findByRole("button", { name: /hide plan/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm hiding/i }));
    await vi.waitFor(() => expect(api.deleteContent).toHaveBeenCalledWith("n1", expect.objectContaining({
      expectedContentRevision: 3,
    })));
    // The dialog closes and the list reloads; unlike the editor path, no
    // deleted view is retained, so no Recover is offered here.
    await vi.waitFor(() => expect(api.listContent).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /confirm hiding/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /recover /i })).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });
});

describe("CampaignContentView", () => {
  it("renders persistent audience markings and hides revoked notes", () => {
    render(<CampaignContentView items={[
      { contentId: "n1", title: "Map", audience: "all_players", revision: 1, status: "active" },
      { contentId: "n2", title: "Secret", audience: "gm_only", revision: 1, status: "active" },
    ] as never} revokedIds={new Set(["n2"])} onOpenContent={() => {}} />);
    expect(screen.getByText(/all players|everyone/i)).toBeVisible();
    expect(screen.queryByText("Secret")).toBeNull();
  });
});
