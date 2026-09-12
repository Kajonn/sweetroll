import { fireEvent, render, screen } from "@testing-library/react";
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

describe("CampaignDetail session tab", () => {
  it("shows the session tab to the campaign owner and hides it from players", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
          { campaignId: "c1", userId: "u2", role: "player", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
    };
    const { unmount } = render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, { wrapper: wrapper() });
    expect(await screen.findByRole("tab", { name: /session/i })).toBeVisible();
    unmount();
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u2" onLeft={() => {}} />, { wrapper: wrapper() });
    await screen.findByRole("tab", { name: /members/i });
    expect(screen.queryByRole("tab", { name: /session/i })).toBeNull();
  });

  it("renders the board when the character surface is supplied and an unavailable state otherwise", async () => {
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
    };
    const charactersApi = {
      open: vi.fn(),
      bumpCharacterResource: vi.fn(),
      executeCharacterAction: vi.fn(),
    };
    const { unmount } = render(
      <CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} charactersApi={charactersApi as never} />,
      { wrapper: wrapper() },
    );
    fireEvent.click(await screen.findByRole("tab", { name: /session/i }));
    expect(await screen.findByRole("heading", { name: /latest content/i })).toBeVisible();
    unmount();
    // A metadata-only handle must never reach the board as a silent cast.
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} metadataApi={{} as never} />, { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("tab", { name: /session/i }));
    expect(await screen.findByText(/session data could not be loaded/i)).toBeVisible();
  });

  it("purges actor-scoped content keys when detail reports access revoked", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function RevokeWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const listKey = ["campaigns", "content", "c1", "u1", 2];
    const itemKey = [...listKey, "item", "n1"];
    client.setQueryData(listKey, { content: [] });
    client.setQueryData(itemKey, { content: { contentId: "n1" } });
    client.setQueryData(["campaigns", "content", "c2", "u1", 2], { content: [] });
    const api = {
      openCampaign: vi.fn().mockRejectedValue({ status: 404, code: "not_found" }),
      listMembers: vi.fn(),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={() => {}} />, {
      wrapper: RevokeWrapper,
    });
    await screen.findByText(/access to this campaign changed/i);
    expect(client.getQueryData(listKey)).toBeUndefined();
    expect(client.getQueryData(itemKey)).toBeUndefined();
    expect(client.getQueryData(["campaigns", "content", "c2", "u1", 2])).toBeDefined();
  });

  it("purges actor-scoped content keys on leave", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function LeaveWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const listKey = ["campaigns", "content", "c1", "u1", 2];
    const itemKey = [...listKey, "item", "n1"];
    const onLeft = vi.fn();
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
      leaveCampaign: vi.fn().mockResolvedValue({ requestId: "r6" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={onLeft} />, {
      wrapper: LeaveWrapper,
    });
    await screen.findByText("North Watch");
    client.setQueryData(listKey, { content: [] });
    client.setQueryData(itemKey, { content: { contentId: "n1" } });
    fireEvent.click(screen.getByRole("button", { name: /^leave campaign$/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^leave campaign$/i })).at(-1)!);
    await vi.waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(client.getQueryData(listKey)).toBeUndefined();
    expect(client.getQueryData(itemKey)).toBeUndefined();
  });

  it("purges session, member, and invitation keys on leave", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function LeaveWrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }
    const sessionKey = ["campaigns", "session", "c1", "u1", 0, "content"];
    const membersKey = ["campaigns", "members", "c1", "u1", 0];
    const invitationsKey = ["campaigns", "invitations", "c1", "u1", 0];
    const otherSessionKey = ["campaigns", "session", "c2", "u1", 0, "content"];
    const onLeft = vi.fn();
    const api = {
      openCampaign: vi.fn().mockResolvedValue({ campaign, requestId: "r" }),
      listMembers: vi.fn().mockResolvedValue({
        members: [
          { campaignId: "c1", userId: "u1", role: "owner", status: "active", generation: 1, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" },
        ],
        nextCursor: null, requestId: "r2",
      }),
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r3" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r4" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [], nextCursor: null, requestId: "r5" }),
      leaveCampaign: vi.fn().mockResolvedValue({ requestId: "r6" }),
    };
    render(<CampaignDetail api={api as never} campaignId="c1" actorId="u1" onLeft={onLeft} />, {
      wrapper: LeaveWrapper,
    });
    await screen.findByText("North Watch");
    client.setQueryData(sessionKey, { content: [] });
    client.setQueryData(membersKey, { pages: [{ members: [], nextCursor: null }], pageParams: [null] });
    client.setQueryData(invitationsKey, { pages: [{ invitations: [], nextCursor: null }], pageParams: [null] });
    client.setQueryData(otherSessionKey, { content: [] });
    fireEvent.click(screen.getByRole("button", { name: /^leave campaign$/i }));
    fireEvent.click((await screen.findAllByRole("button", { name: /^leave campaign$/i })).at(-1)!);
    await vi.waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(client.getQueryData(sessionKey)).toBeUndefined();
    expect(client.getQueryData(membersKey)).toBeUndefined();
    expect(client.getQueryData(invitationsKey)).toBeUndefined();
    expect(client.getQueryData(otherSessionKey)).toBeDefined();
  });
});
