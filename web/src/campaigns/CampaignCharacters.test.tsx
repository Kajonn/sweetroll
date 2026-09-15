// web/src/campaigns/CampaignCharacters.test.tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CampaignCharactersView } from "./CampaignCharacters.js";

function sheet(overrides = {}) {
  return {
    characterId: "s1",
    campaignId: "c1",
    name: "Bram",
    entityDefinitionId: "hero",
    systemVersionId: "v1",
    revision: 4,
    lifecycle: "active",
    placementGeneration: 1,
    controllers: [],
    updatedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function claimRow(overrides = {}) {
  return {
    characterId: "s1",
    name: "Bram",
    revision: 4,
    lifecycle: "active",
    ...overrides,
  };
}

function viewProps(overrides = {}) {
  return {
    api: { claimCharacter: vi.fn(), createCampaignCharacter: vi.fn() },
    campaignId: "c1",
    campaignRevision: 2,
    characters: [],
    characterRevisionById: {},
    claimable: [],
    claimableStatus: "success" as const,
    onOpenCharacter: () => {},
    ...overrides,
  };
}

describe("CampaignCharactersView", () => {
  it("claims a designated row with a fresh idempotency key and no sheet preload", async () => {
    const api = {
      claimCharacter: vi.fn().mockResolvedValue({ character: {}, requestId: "r" }),
      createCampaignCharacter: vi.fn(),
      open: vi.fn(),
    };
    const onChanged = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({ api, onChanged, claimable: [claimRow()] })}
      />,
    );
    const button = screen.getByRole("button", { name: /claim bram/i });
    button.click();
    const confirm = await screen.findByRole("button", { name: /confirm claim/i });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(api.claimCharacter).toHaveBeenCalled());
    const body = (api.claimCharacter as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(body.expectedCampaignRevision).toBe(2);
    expect(body.expectedCharacterRevision).toBe(4);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(api.open).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /open bram/i })).toBeNull();
  });

  it("marks sheets the actor controls and offers open only for controlled rows", () => {
    const api = { claimCharacter: vi.fn(), createCampaignCharacter: vi.fn() };
    render(
      <CampaignCharactersView
        {...viewProps({
          api,
          actorId: "u1",
          characters: [sheet({ controllers: ["u1"] }), sheet({ characterId: "s2", name: "Wren" })],
        })}
      />,
    );
    expect(screen.getByText(/you control this character/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /open bram/i })).toBeVisible();
    expect(screen.queryByRole("button", { name: /open wren/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /claim wren/i })).toBeNull();
  });

  it("evicts the discovery row without relabelling view-only when claim reports 404", async () => {
    const api = {
      claimCharacter: vi.fn().mockRejectedValue({ code: "not_found", status: 404, message: "gone" }),
      createCampaignCharacter: vi.fn(),
    };
    const onChanged = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({ api, onChanged, claimable: [claimRow()] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /claim bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm claim/i }));
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /claim bram/i })).toBeNull();
    expect(screen.queryByText(/view-only/i)).toBeNull();
  });

  it("reloads and retries with a fresh key after a claim conflict (409), never merging", async () => {
    const api = {
      claimCharacter: vi.fn().mockRejectedValueOnce({ code: "conflict", status: 409, message: "taken" })
        .mockResolvedValueOnce({ character: {}, requestId: "r2" }),
      createCampaignCharacter: vi.fn(),
    };
    const onChanged = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({ api, onChanged, claimable: [claimRow()] })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /claim bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm claim/i }));
    const retry = await screen.findByRole("button", { name: /retry claim/i });
    expect(screen.getByText(/someone else claimed/i)).toBeVisible();
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(retry);
    fireEvent.click(await screen.findByRole("button", { name: /confirm claim/i }));
    await vi.waitFor(() => expect(api.claimCharacter).toHaveBeenCalledTimes(2));
    const first = api.claimCharacter.mock.calls[0]![2];
    const second = api.claimCharacter.mock.calls[1]![2];
    expect(typeof first.idempotencyKey).toBe("string");
    expect(typeof second.idempotencyKey).toBe("string");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it("shows archived designations as unavailable with no claim action", () => {
    const api = { claimCharacter: vi.fn(), createCampaignCharacter: vi.fn() };
    render(
      <CampaignCharactersView
        {...viewProps({ api, claimable: [claimRow({ lifecycle: "archived" })] })}
      />,
    );
    expect(screen.getByText(/archived and cannot be claimed/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /claim bram/i })).toBeNull();
  });

  it("lets GMs open roster sheets they do not control", () => {
    const api = { claimCharacter: vi.fn(), createCampaignCharacter: vi.fn() };
    const onOpenCharacter = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({
          api,
          actorId: "u1",
          isGm: true,
          characters: [sheet({ controllers: [] })],
          onOpenCharacter,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open bram/i }));
    expect(onOpenCharacter).toHaveBeenCalledWith("s1");
  });

  it("opens controlled sheets through the shared renderer callback, never a second renderer", () => {
    const api = { claimCharacter: vi.fn(), createCampaignCharacter: vi.fn() };
    const onOpenCharacter = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({
          api,
          actorId: "u1",
          characters: [sheet({ controllers: ["u1"] })],
          onOpenCharacter,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /open bram/i }));
    expect(onOpenCharacter).toHaveBeenCalledWith("s1");
  });

  it("creates a campaign character with a caller-minted key and opens it", async () => {
    const api = {
      claimCharacter: vi.fn(),
      createCampaignCharacter: vi.fn().mockResolvedValue({
        character: { characterId: "s9" },
        requestId: "r3",
      }),
    };
    const onChanged = vi.fn();
    const onOpenCharacter = vi.fn();
    render(
      <CampaignCharactersView
        {...viewProps({ api, onChanged, onOpenCharacter })}
      />,
    );
    fireEvent.change(screen.getByLabelText(/character name/i), { target: { value: "Wren" } });
    fireEvent.change(screen.getByLabelText(/entity definition/i), { target: { value: "hero" } });
    fireEvent.click(screen.getByRole("button", { name: /new campaign character/i }));
    await vi.waitFor(() => expect(api.createCampaignCharacter).toHaveBeenCalled());
    const firstCall = api.createCampaignCharacter.mock.calls[0]!;
    expect(firstCall[0]).toBe("c1");
    const body = firstCall[1];
    expect(body.name).toBe("Wren");
    expect(body.entityDefinitionId).toBe("hero");
    expect(body.expectedCampaignRevision).toBe(2);
    expect(typeof body.idempotencyKey).toBe("string");
    expect(onOpenCharacter).toHaveBeenCalledWith("s9");
    expect(onChanged).toHaveBeenCalled();
  });

  it("lists npc-kind rows in the NPC section and keeps them out of the main list", () => {
    render(
      <CampaignCharactersView
        {...viewProps({
          isGm: true,
          characters: [
            sheet({ characterId: "s1", name: "Bram", entityDefinitionId: "hero" }),
            sheet({ characterId: "s2", name: "Goblin", entityDefinitionId: "goblin" }),
          ],
          npcEntityIds: { goblin: true },
          onOpenCharacter: () => {},
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: /monsters & npcs/i })).toBeVisible();
    const npcSection = screen.getByRole("region", { name: /monsters & npcs/i });
    expect(within(npcSection).getByRole("button", { name: /open goblin/i })).toBeVisible();
    expect(within(npcSection).queryByRole("button", { name: /open bram/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: /open goblin/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /open bram/i })).toHaveLength(1);
  });

  it("narrows the NPC section by name search and shows an empty state", () => {
    render(
      <CampaignCharactersView
        {...viewProps({
          isGm: true,
          characters: [sheet({ characterId: "s2", name: "Goblin", entityDefinitionId: "goblin" })],
          npcEntityIds: { goblin: true },
          onOpenCharacter: () => {},
        })}
      />,
    );
    fireEvent.change(screen.getByLabelText(/search monsters & npcs/i), { target: { value: "zzz" } });
    expect(screen.getByText(/no monsters or npcs match/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /open goblin/i })).toBeNull();
    fireEvent.change(screen.getByLabelText(/search monsters & npcs/i), { target: { value: "gob" } });
    expect(screen.getByRole("button", { name: /open goblin/i })).toBeVisible();
  });

  it("hides the NPC section when no kinds resolve and keeps every row in the main list", () => {
    render(
      <CampaignCharactersView
        {...viewProps({
          isGm: true,
          characters: [sheet({ name: "Bram" })],
          onOpenCharacter: () => {},
        })}
      />,
    );
    expect(screen.queryByRole("heading", { name: /monsters & npcs/i })).toBeNull();
    expect(screen.getByRole("button", { name: /open bram/i })).toBeVisible();
  });
});
