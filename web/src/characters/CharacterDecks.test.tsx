import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RollBreakdown } from "../rolls/RollBreakdown.js";
import type { CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import { CharacterSheet } from "./CharacterSheet.js";

const deck = { deckId: "omen_deck", label: "Omen deck" };

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  const projection = {
    projectionVersion: "1.0" as const, systemId: "system", versionId: "version", packageChecksum: "checksum", entityId: "hero", entityLabel: "Hero",
    derivedValues: {}, validations: [], completionFields: [],
    sheets: [{ id: "play", label: "Play", sections: [{ id: "omens", label: "Omens", elements: [
      { kind: "action" as const, id: "read", actionId: "read_omens", label: "Read the omens", actionKind: "draw" as const, deck: { ...deck, count: 2 }, inputs: [], validations: [] },
      { kind: "action" as const, id: "gather", actionId: "gather_omens", label: "Gather the omens", actionKind: "shuffle" as const, deck, inputs: [], validations: [] },
    ] }] }],
  };
  return {
    phase: "ready", confirmed: makeView({ characterId: "character", revision: 1, projection }), tentative: null,
    entries: [], editing: { owned: true }, error: null, lastRoll: null, lastNominal: null, pendingOnlineAttempts: [], connected: true, ...overrides,
  };
}

const counts = (remaining: number) => ({ decks: [{ ...deck, total: 12, remaining }], requestId: "r" });

describe("card decks on the character sheet", () => {
  it("shows the cards left and reads them again after a draw or shuffle", async () => {
    const user = userEvent.setup();
    const loadDecks = vi.fn().mockResolvedValueOnce(counts(12)).mockResolvedValueOnce(counts(10)).mockResolvedValue(counts(12));
    const onExecuteAction = vi.fn().mockResolvedValue(undefined);
    render(<CharacterSheet snapshot={snapshot()} loadDecks={loadDecks} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={onExecuteAction} />);

    expect(await screen.findByTestId("deck-count-read")).toHaveTextContent("Omen deck: 12 of 12 cards left");
    expect(loadDecks).toHaveBeenCalledWith("character");
    await user.click(screen.getByRole("button", { name: "Read the omens" }));
    expect(onExecuteAction).toHaveBeenCalledWith("read_omens", {});
    await waitFor(() => expect(screen.getByTestId("deck-count-gather")).toHaveTextContent("Omen deck: 10 of 12 cards left"));
    await user.click(screen.getByRole("button", { name: "Gather the omens" }));
    expect(onExecuteAction).toHaveBeenLastCalledWith("gather_omens", {});
    await waitFor(() => expect(screen.getByTestId("deck-count-read")).toHaveTextContent("Omen deck: 12 of 12 cards left"));
  });

  it("reads the count again when a queued shuffle is acknowledged, not only when it is queued", async () => {
    // Hosted T2 run 2026-11-12: the read made when the command was queued still
    // saw the empty deck, and nothing read it again after the server applied it.
    const user = userEvent.setup();
    let applied = false;
    const loadDecks = vi.fn(async () => counts(applied ? 12 : 0));
    const pendingShuffle = { id: "pending", actorId: "a", characterId: "character", sequence: 0, baseRevision: 1, packageChecksum: "checksum", createdAt: "2026-11-12T00:00:00Z", intent: { kind: "executeAction" as const, actionId: "gather_omens" }, attempt: null };
    const props = { loadDecks, onSetField: vi.fn(), onBump: vi.fn(), onExecuteAction: vi.fn().mockResolvedValue(undefined) };
    const view = render(<CharacterSheet snapshot={snapshot()} {...props} />);
    await expect(screen.findByTestId("deck-count-gather")).resolves.toHaveTextContent("Omen deck: 0 of 12 cards left");

    await user.click(screen.getByRole("button", { name: "Gather the omens" }));
    view.rerender(<CharacterSheet snapshot={snapshot({ entries: [pendingShuffle] })} {...props} />);
    await waitFor(() => expect(loadDecks.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("deck-count-gather")).toHaveTextContent("Omen deck: 0 of 12 cards left");

    applied = true;
    view.rerender(<CharacterSheet snapshot={snapshot()} {...props} />);
    await waitFor(() => expect(screen.getByTestId("deck-count-gather")).toHaveTextContent("Omen deck: 12 of 12 cards left"));
    expect(screen.getByRole("button", { name: "Read the omens" })).toBeEnabled();
  });

  it("stops draws from an empty deck and keeps shuffle available", async () => {
    render(<CharacterSheet snapshot={snapshot()} loadDecks={vi.fn().mockResolvedValue(counts(0))} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    expect(await screen.findByTestId("deck-count-read")).toHaveTextContent("Omen deck has no cards left. Shuffle it to draw again.");
    expect(screen.getByRole("button", { name: "Read the omens" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Gather the omens" })).toBeEnabled();
  });

  it("keeps deck actions online-only and hides counts that cannot be read", async () => {
    const loadDecks = vi.fn().mockRejectedValue(new Error("offline"));
    render(<CharacterSheet snapshot={snapshot({ phase: "offline", connected: false })} loadDecks={loadDecks} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Read the omens" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Gather the omens" })).toBeDisabled();
    expect(loadDecks).not.toHaveBeenCalled();
    expect(screen.queryByTestId("deck-count-read")).toBeNull();
  });

  it("lists each drawn card with its columns and the cards left", () => {
    render(<RollBreakdown roll={{ dice: [], total: 2, breakdown: {
      version: "1.0", rootId: "cards", groups: [], terms: [{ id: "cards", operation: "literal", operandIds: [], value: 2 }],
      cards: { deckId: "omen_deck", deckLabel: "Omen deck", remaining: 10, drawn: [
        { id: "ember_crown", label: "Crown of Ember", values: { suit: "Ember", rank: 4 } },
        { id: "tide_first", label: "First of Tide", values: {} },
      ] },
    } }} />);
    const cards = screen.getByRole("region", { name: "Cards drawn from Omen deck" });
    expect(cards).toHaveTextContent("Crown of Ember (suit: Ember, rank: 4)");
    expect(screen.getByTestId("roll-card-tide_first")).toHaveTextContent("First of Tide");
    expect(cards).toHaveTextContent("Omen deck: 10 cards left");
  });
});
