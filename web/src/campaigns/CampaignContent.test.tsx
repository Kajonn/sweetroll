// web/src/campaigns/CampaignContent.test.tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

/** Mirrors the production QueryClient: 30s stale budget, no retries. */
function appLikeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
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

describe("CampaignContentTab revocation revalidation", () => {
  const listRow = { contentId: "n1", title: "Plan", audience: "all_players" };
  const view = {
    contentId: "n1", campaignId: "c1", audience: "all_players", title: "Plan",
    body: "Secret body.", tags: [], revision: 3, grantedUserIds: [], status: "active",
  };
  const listKey = ["campaigns", "content", "c1", "u1", 0];
  const itemKey = [...listKey, "item", "n1"];

  function playerApi() {
    return {
      listContent: vi.fn().mockResolvedValue({ content: [listRow], nextCursor: null, requestId: "r" }),
      openContent: vi.fn().mockResolvedValue({ content: view, requestId: "r" }),
    };
  }

  function renderPlayerTab(api: ReturnType<typeof playerApi>, client: QueryClient, extra = {}) {
    return render(
      <CampaignContentTab
        api={api as never}
        campaignId="c1"
        actorId="u1"
        generation={0}
        online
        {...extra}
      />,
      { wrapper: wrapperWith(client) },
    );
  }

  it("purges the cached body when a refresh proves the note unreadable", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = playerApi();
    const { rerender } = renderPlayerTab(api, client);
    fireEvent.click(await screen.findByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(screen.getByText("Secret body.")).toBeVisible());
    expect(client.getQueryData(itemKey)).toBeDefined();
    // The grant is narrowed elsewhere; reconnecting revalidates and the
    // server now answers 404 for the previously readable note.
    api.openContent.mockRejectedValue({ status: 404 });
    rerender(
      <CampaignContentTab api={api as never} campaignId="c1" actorId="u1" generation={0} online={false} />,
    );
    rerender(
      <CampaignContentTab api={api as never} campaignId="c1" actorId="u1" generation={0} online />,
    );
    await waitFor(() => expect(api.openContent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Secret body.")).toBeNull());
    expect(client.getQueryData(itemKey)).toBeUndefined();
  });

  it("unmounts a mounted reader the list no longer contains", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = playerApi();
    renderPlayerTab(api, client);
    fireEvent.click(await screen.findByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(screen.getByText("Secret body.")).toBeVisible());
    // A list refresh silently drops the narrowed note while its reader is
    // mounted: the stale body must not stay on screen.
    api.listContent.mockResolvedValue({ content: [], nextCursor: null, requestId: "r2" });
    // List-only refetch: the mounted detail query keeps its cached body, so
    // the test proves the reader itself reacts to the list dropping its row.
    // (A prefix refetch would also re-drive the deferred detail read below.)
    await act(async () => {
      await client.refetchQueries({ queryKey: listKey, exact: true });
    });
    await waitFor(() => expect(screen.queryByText("Secret body.")).toBeNull());
    expect(client.getQueryData(itemKey)).toBeUndefined();
  });

  it("revalidates on reopen instead of serving a stale cached body", async () => {
    // The production client keeps reads fresh for 30s; reopening a note
    // inside that window must still revalidate authorization.
    const client = appLikeClient();
    const api = playerApi();
    renderPlayerTab(api, client);
    fireEvent.click(await screen.findByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(screen.getByText("Secret body.")).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: /back to content/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /open plan/i })).toBeVisible());
    api.openContent.mockRejectedValue({ status: 404 });
    fireEvent.click(screen.getByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(api.openContent).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("Secret body.")).toBeNull());
  });

  it("never renders a pre-revocation response that lands late", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveOpen!: (value: { content: typeof view; requestId: string }) => void;
    const pending = new Promise<{ content: typeof view; requestId: string }>((resolve) => {
      resolveOpen = resolve;
    });
    const api = playerApi();
    api.openContent.mockReturnValueOnce(pending);
    renderPlayerTab(api, client);
    fireEvent.click(await screen.findByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(api.openContent).toHaveBeenCalledTimes(1));
    // Revocation lands (list drops the note; the pending read is still in
    // flight) before the stale response arrives.
    api.listContent.mockResolvedValue({ content: [], nextCursor: null, requestId: "r2" });
    await act(async () => {
      await client.refetchQueries({ queryKey: listKey, exact: true });
    });
    // Prove the revoke path completed (list gone, unavailable shown) before
    // letting the stale response land; otherwise the test races the guard.
    await waitFor(() => expect(screen.queryByRole("button", { name: /open plan/i })).toBeNull());
    await act(async () => resolveOpen({ content: view, requestId: "late" }));
    await waitFor(() => expect(api.listContent).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Secret body.")).toBeNull();
  });

  it("does not leak an in-flight read across an account switch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveOpen!: (value: { content: typeof view; requestId: string }) => void;
    const pending = new Promise<{ content: typeof view; requestId: string }>((resolve) => {
      resolveOpen = resolve;
    });
    const api = playerApi();
    api.openContent.mockReturnValueOnce(pending);
    api.openContent.mockRejectedValue({ status: 404 });
    const { rerender } = renderPlayerTab(api, client);
    fireEvent.click(await screen.findByRole("button", { name: /open plan/i }));
    await waitFor(() => expect(api.openContent).toHaveBeenCalledTimes(1));
    // Account A signs out and B signs in on the same client while A's read
    // is still in flight; B cannot read the note.
    rerender(
      <CampaignContentTab api={api as never} campaignId="c1" actorId="u2" generation={0} online />,
    );
    await act(async () => resolveOpen({ content: view, requestId: "late-a" }));
    await waitFor(() => expect(api.openContent).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Secret body.")).toBeNull();
  });
});
