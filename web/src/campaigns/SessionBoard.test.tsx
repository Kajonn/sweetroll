// web/src/campaigns/SessionBoard.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionBoard } from "./SessionBoard.js";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const sheet = (overrides = {}) => ({
  characterId: "s1", ownerId: null, campaignId: "c1", controllers: [], placementGeneration: 1,
  returnOwnerId: null, name: "Bram", systemVersionId: "v1", entityDefinitionId: "hero",
  revision: 7, lifecycle: "active", archivedAt: null,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  state: { schemaVersion: "1.0", values: {} }, derivedValues: {},
  validations: [],
  projection: {
    projectionVersion: "1.0", systemId: "s", versionId: "v1", packageChecksum: "p",
    entityId: "hero", entityLabel: "Hero",
    sheets: [{ id: "sh", label: "Sheet", sections: [{ id: "sec", label: "Sec", elements: [
      { kind: "resource", id: "e1", resourceId: "hp", label: "Health", value: { current: 3, max: 5 }, min: 0, max: 5, step: 1, resetTo: "max", validations: [] },
      { kind: "action", id: "e2", actionId: "a1", label: "Strike", actionKind: "roll", inputs: [], validations: [] },
    ] }] }],
    derivedValues: {}, validations: [],
  },
  reconciliation: { characterId: "s1", baseRevision: null, revision: 7 },
  ...overrides,
});

describe("SessionBoard", () => {
  it("bumps a resource with revision + fresh key and reloads the sheet", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = {
      open: vi.fn().mockResolvedValue({ character: sheet(), requestId: "r3" }),
      bumpCharacterResource: vi.fn().mockResolvedValue({ result: {}, requestId: "r4" }),
    };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /increase health/i }));
    await vi.waitFor(() => expect(charactersApi.bumpCharacterResource).toHaveBeenCalledWith("s1", "hp", expect.objectContaining({
      direction: "up",
      expectedRevision: 7,
    })));
    const body = (charactersApi.bumpCharacterResource as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("filters the directory by name without new requests", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
        { characterId: "s2", campaignId: "c1", name: "Mira", entityDefinitionId: "hero", systemVersionId: "v1", revision: 2, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = { open: vi.fn() };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    await screen.findByRole("button", { name: /mira/i });
    fireEvent.change(screen.getByLabelText(/filter characters/i), { target: { value: "bram" } });
    expect(screen.queryByRole("button", { name: /mira/i })).toBeNull();
    expect(screen.getByRole("button", { name: /bram/i })).toBeVisible();
    expect(campaignsApi.listCampaignCharacters).toHaveBeenCalledTimes(1);
  });

  it("rolls with the selected audience and fresh key", async () => {
    const campaignsApi = {
      listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null, requestId: "r0" }),
      listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null, requestId: "r1" }),
      listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [
        { characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero", systemVersionId: "v1", revision: 7, lifecycle: "active", placementGeneration: 1, controllers: [], updatedAt: "2026-09-01T00:00:00Z" },
      ], nextCursor: null, requestId: "r2" }),
    };
    const charactersApi = {
      open: vi.fn().mockResolvedValue({ character: sheet(), requestId: "r3" }),
      executeCharacterAction: vi.fn().mockResolvedValue({ result: { roll: "13" }, requestId: "r4" }),
    };
    render(<SessionBoard campaignsApi={campaignsApi as never} charactersApi={charactersApi as never}
      campaignId="c1" actorId="u1" generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />,
      { wrapper: wrapper() });
    fireEvent.click(await screen.findByRole("button", { name: /bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /roll strike/i }));
    await vi.waitFor(() => expect(charactersApi.executeCharacterAction).toHaveBeenCalledWith("s1", "a1", expect.objectContaining({
      audience: "campaign",
      expectedRevision: 7,
    })));
  });
});
