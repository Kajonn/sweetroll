// web/src/campaigns/CampaignContentPreview.test.tsx
// Preview-as-member mode (GM-only): picker over active members, persistent
// banner, preview-driven list + reader with no mutation affordances, and
// purge-on-exit/unmount of the preview cache family.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CampaignContentTab } from "./CampaignContent.js";
import type { CampaignMember } from "./types.js";

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapperWith(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function member(userId: string, role: CampaignMember["role"], status: CampaignMember["status"]): CampaignMember {
  return {
    campaignId: "c1",
    userId,
    role,
    status,
    generation: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const MEMBERS = [
  member("gm-1", "owner", "active"),
  member("player-1", "player", "active"),
  member("removed-1", "player", "removed"),
];

const SHARED_ROW = { contentId: "n1", title: "Shared", audience: "all_players" };
const SECRET_ROW = { contentId: "n2", title: "Secret", audience: "gm_only" };
const SHARED_VIEW = {
  contentId: "n1",
  campaignId: "c1",
  creatorId: "gm-1",
  audience: "all_players",
  title: "Shared",
  body: "Shared body.",
  tags: [],
  revision: 1,
  accessRevision: 1,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  grantedUserIds: [],
};

function gmApi(overrides: Record<string, unknown> = {}) {
  return {
    listContent: vi.fn().mockImplementation((_campaignId: string, query?: { status?: string }) =>
      Promise.resolve({
        content: query?.status === "deleted" ? [] : [SHARED_ROW, SECRET_ROW],
        nextCursor: null,
        requestId: "gm-list",
      }),
    ),
    openContent: vi.fn().mockResolvedValue({ content: SHARED_VIEW, requestId: "gm-item" }),
    previewContent: vi.fn().mockImplementation((_campaignId: string, body: { contentId?: string }) =>
      body.contentId === undefined
        ? Promise.resolve({ content: [SHARED_ROW], nextCursor: null, requestId: "preview-list" })
        : Promise.resolve({ content: SHARED_VIEW, requestId: "preview-item" }),
    ),
    ...overrides,
  };
}

function renderGmTab(api: ReturnType<typeof gmApi>, client: QueryClient, extra: Record<string, unknown> = {}) {
  return render(
    <CampaignContentTab
      api={api as never}
      campaignId="c1"
      actorId="gm-1"
      generation={0}
      online
      isGm
      members={MEMBERS}
      {...(extra as object)}
    />,
    { wrapper: wrapperWith(client) },
  );
}

describe("CampaignContentTab preview-as-member picker", () => {
  it("lists active members regardless of role, and stays hidden from non-GMs", async () => {
    const client = testClient();
    const api = gmApi();
    const first = renderGmTab(api, client);
    // GM list resolves before the picker asserts.
    await screen.findByRole("button", { name: /open shared/i });
    const picker = screen.getByLabelText(/preview as/i);
    expect(picker).toBeVisible();
    expect(screen.getByRole("option", { name: "gm-1" })).toBeDefined();
    expect(screen.getByRole("option", { name: "player-1" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "removed-1" })).toBeNull();

    first.unmount();
    render(
      <CampaignContentTab
        api={api as never}
        campaignId="c1"
        actorId="player-1"
        generation={0}
        online
        members={MEMBERS}
      />,
      { wrapper: wrapperWith(testClient()) },
    );
    await screen.findByRole("button", { name: /open shared/i });
    expect(screen.queryByLabelText(/preview as/i)).toBeNull();
  });

  it("enters preview on select: banner, preview rows, no mutation affordances", async () => {
    const client = testClient();
    const api = gmApi();
    renderGmTab(api, client);
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });

    // Persistent banner names the target.
    expect(await screen.findByText(/previewing as player-1/i)).toBeVisible();
    expect(api.previewContent).toHaveBeenCalledWith("c1", { targetUserId: "player-1" });
    // Preview rows render (the GM-only note the target cannot read is gone).
    await waitFor(() => expect(screen.getByRole("button", { name: /open shared/i })).toBeVisible());
    expect(screen.queryByRole("button", { name: /open secret/i })).toBeNull();
    // No mutation affordance may render in preview.
    expect(screen.queryByText("New note")).toBeNull();
    expect(screen.queryByRole("button", { name: /save note/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /edit shared/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /hide shared/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^hidden$/i })).toBeNull();
    expect(screen.queryByText(/share with/i)).toBeNull();
  });

  it("exit restores GM controls and purges the preview cache", async () => {
    const client = testClient();
    const api = gmApi();
    renderGmTab(api, client);
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });
    await screen.findByText(/previewing as player-1/i);
    await waitFor(() =>
      expect(client.getQueryData(["campaigns", "preview", "c1", "player-1"])).toBeDefined(),
    );

    fireEvent.click(screen.getByRole("button", { name: /exit preview/i }));
    // GM view is restored.
    expect(await screen.findByText("New note")).toBeVisible();
    expect(screen.getByRole("button", { name: /save note/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /open secret/i })).toBeVisible();
    expect(screen.queryByText(/previewing as player-1/i)).toBeNull();
    // Preview cache keys are removed on exit.
    expect(client.getQueriesData({ queryKey: ["campaigns", "preview", "c1"] })).toEqual([]);
  });

  it("keeps preview data across parent re-renders (purge runs on unmount only)", async () => {
    const client = testClient();
    const api = gmApi();
    const tabProps = {
      api: api as never,
      campaignId: "c1",
      actorId: "gm-1",
      generation: 0,
      online: true,
      isGm: true,
      members: MEMBERS,
    };
    const rendered = render(<CampaignContentTab {...tabProps} />, { wrapper: wrapperWith(client) });
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });
    await screen.findByRole("button", { name: /open shared/i });
    expect(api.previewContent).toHaveBeenCalledTimes(1);
    // An unrelated parent re-render must not purge the preview cache.
    rendered.rerender(<CampaignContentTab {...tabProps} />);
    await screen.findByRole("button", { name: /open shared/i });
    expect(api.previewContent).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["campaigns", "preview", "c1", "player-1"])).toBeDefined();
  });

  it("purges the preview cache on unmount", async () => {
    const client = testClient();
    const api = gmApi();
    const rendered = renderGmTab(api, client);
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });
    await screen.findByText(/previewing as player-1/i);
    await waitFor(() =>
      expect(client.getQueryData(["campaigns", "preview", "c1", "player-1"])).toBeDefined(),
    );
    rendered.unmount();
    expect(client.getQueriesData({ queryKey: ["campaigns", "preview", "c1"] })).toEqual([]);
  });

  it("surfaces an error state and purges preview data when preview fails", async () => {
    const client = testClient();
    const api = gmApi({
      previewContent: vi.fn().mockRejectedValue({ status: 404, code: "not_found" }),
    });
    renderGmTab(api, client);
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });
    // The target was removed mid-preview (or any preview failure): an error
    // state replaces the preview, never the GM list, and preview data is purged.
    expect(await screen.findByText(/preview could not be loaded/i)).toBeVisible();
    expect(client.getQueriesData({ queryKey: ["campaigns", "preview", "c1"] })).toEqual([]);
    // Exit still restores the GM view.
    fireEvent.click(screen.getByRole("button", { name: /exit preview/i }));
    expect(await screen.findByRole("button", { name: /open secret/i })).toBeVisible();
  });

  it("opens notes through the preview item query, never openContent", async () => {
    const client = testClient();
    const api = gmApi();
    renderGmTab(api, client);
    await screen.findByRole("button", { name: /open secret/i });
    fireEvent.change(screen.getByLabelText(/preview as/i), { target: { value: "player-1" } });
    fireEvent.click(await screen.findByRole("button", { name: /open shared/i }));
    expect(await screen.findByText("Shared body.")).toBeVisible();
    expect(api.previewContent).toHaveBeenCalledWith("c1", { targetUserId: "player-1", contentId: "n1" });
    expect(api.openContent).not.toHaveBeenCalled();
  });
});
