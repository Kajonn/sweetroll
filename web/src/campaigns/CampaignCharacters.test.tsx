// web/src/campaigns/CampaignCharacters.test.tsx
import { fireEvent, render, screen } from "@testing-library/react";
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

describe("CampaignCharactersView", () => {
  it("marks claimable sheets and claims with a fresh idempotency key", async () => {
    const api = { claimCharacter: vi.fn().mockResolvedValue({ character: {}, requestId: "r" }) };
    const onChanged = vi.fn();
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[{ characterId: "s1", campaignId: "c1", name: "Bram", entityDefinitionId: "hero",
        systemVersionId: "v1", revision: 4, lifecycle: "active", placementGeneration: 1,
        controllers: [], updatedAt: "2026-09-01T00:00:00Z", claimable: true } as never]}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={() => {}} onChanged={onChanged} />);
    expect(screen.getByText(/available to claim/i)).toBeVisible();
    const button = screen.getByRole("button", { name: /claim bram/i });
    button.click();
    // Claim discloses campaign custody behind a confirm dialog; the first
    // click only opens it.
    const confirm = await screen.findByRole("button", { name: /confirm claim/i });
    fireEvent.click(confirm);
    await vi.waitFor(() => expect(api.claimCharacter).toHaveBeenCalled());
    const body = (api.claimCharacter as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(body.expectedCampaignRevision).toBe(2);
    expect(typeof body.idempotencyKey).toBe("string");
  });

  it("marks sheets the actor controls and offers no claim action", () => {
    const api = { claimCharacter: vi.fn() };
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      actorId="u1" characters={[sheet({ controllers: ["u1"] })] as never}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={() => {}} />);
    expect(screen.getByText(/you control this character/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /claim bram/i })).toBeNull();
  });

  it("flips a row to view-only and reloads when claim reports not designated (404)", async () => {
    const api = {
      claimCharacter: vi.fn().mockRejectedValue({ code: "not_found", status: 404, message: "not designated" }),
    };
    const onChanged = vi.fn();
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[sheet()] as never}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={() => {}} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: /claim bram/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm claim/i }));
    expect(await screen.findByText(/not designated for you/i)).toBeVisible();
    expect(screen.getByText(/view-only/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /claim bram/i })).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it("reloads and retries with a fresh key after a claim conflict (409), never merging", async () => {
    const api = {
      claimCharacter: vi.fn().mockRejectedValueOnce({ code: "conflict", status: 409, message: "taken" })
        .mockResolvedValueOnce({ character: {}, requestId: "r2" }),
    };
    const onChanged = vi.fn();
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[sheet()] as never}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={() => {}} onChanged={onChanged} />);
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

  it("opens sheets through the shared renderer callback, never a second renderer", () => {
    const api = { claimCharacter: vi.fn() };
    const onOpenCharacter = vi.fn();
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[sheet()] as never}
      characterRevisionById={{ s1: 4 }} onOpenCharacter={onOpenCharacter} />);
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
    render(<CampaignCharactersView api={api as never} campaignId="c1" campaignRevision={2}
      characters={[]} characterRevisionById={{}} onOpenCharacter={onOpenCharacter} onChanged={onChanged} />);
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
});
