import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { describe, expect, it } from "vitest";

import { blankDocument, documentReducer, type SystemDocumentV1 } from "../../state/documentReducer.js";
import { collectUsedIds } from "../sheet/slotTypes.js";
import { DeckActionEditor, DeckEditor, type DeckActionV1 } from "./DeckEditor.js";

let latest: SystemDocumentV1;

function Harness({ initial }: { initial: SystemDocumentV1 }) {
  const [document, dispatch] = useReducer(documentReducer, initial);
  latest = document;
  return <DeckEditor decks={document.decks ?? []} datasets={document.referenceData} usedIds={collectUsedIds(document)}
    onChange={(next) => dispatch({ type: "setDecks", ...next })} />;
}

async function open(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByText(name));
}

describe("DeckEditor", () => {
  it("adds a deck with its own card dataset and edits the cards in place", async () => {
    const user = userEvent.setup();
    render(<Harness initial={blankDocument()} />);
    await open(user, "Card decks");
    await user.click(screen.getByRole("button", { name: "Add deck" }));

    expect(latest.decks).toEqual([{ id: "deck_1", label: "Deck", datasetId: "cards_1" }]);
    expect(latest.referenceData).toEqual([{ id: "cards_1", label: "Cards", records: [{ id: "card_1", label: "Card 1", values: {} }] }]);
    const deck = screen.getByTestId("deck-deck_1");
    expect(within(deck).getByTestId("deck-count-deck_1")).toHaveTextContent("1 cards");

    await user.clear(within(deck).getByLabelText("Deck name"));
    await user.type(within(deck).getByLabelText("Deck name"), "Omen deck");
    expect(latest.decks?.[0]?.label).toBe("Omen deck");
    await user.click(within(deck).getByRole("button", { name: "Remove deck" }));
    expect(latest.decks).toEqual([]);
    expect(latest.referenceData).toHaveLength(1);
  });

  it("stops at four decks and reports a deck without cards", async () => {
    const user = userEvent.setup();
    const initial: SystemDocumentV1 = {
      ...blankDocument(),
      referenceData: [{ id: "omens", label: "Omens", records: [] }],
      decks: [1, 2, 3, 4].map(n => ({ id: `deck_${n}`, label: `Deck ${n}`, datasetId: n === 4 ? "missing" : "omens" })),
    };
    render(<Harness initial={initial} />);
    await open(user, "Card decks");
    expect(screen.getByRole("button", { name: "Add deck" })).toBeDisabled();
    expect(screen.getByTestId("deck-count-deck_1")).toHaveTextContent("This deck has 0 cards. A deck needs between 1 and 200.");
    await user.selectOptions(within(screen.getByTestId("deck-deck_4")).getByLabelText("Cards come from"), "omens");
    expect(latest.decks?.[3]?.datasetId).toBe("omens");
  });
});

describe("DeckActionEditor", () => {
  const decks = [{ id: "omen_deck", label: "Omen deck", datasetId: "omens" }, { id: "fate_deck", label: "Fate deck", datasetId: "omens" }];

  it("edits the label, deck and draw size within one to ten cards", async () => {
    const user = userEvent.setup();
    let action: DeckActionV1 = { kind: "draw", id: "read", label: "Read", deckId: "omen_deck", count: 2 };
    const view = render(<DeckActionEditor action={action} decks={decks} onChange={(next) => { action = next; }} />);
    const rerender = () => view.rerender(<DeckActionEditor action={action} decks={decks} onChange={(next) => { action = next; }} />);

    await user.selectOptions(screen.getByLabelText("Deck"), "fate_deck");
    expect(action).toMatchObject({ deckId: "fate_deck", count: 2 });
    rerender();
    const count = screen.getByLabelText("Cards per draw");
    await user.clear(count);
    await user.type(count, "25");
    count.blur();
    expect(action.kind === "draw" && action.count).toBeLessThanOrEqual(10);
    expect(action.kind === "draw" && action.count).toBeGreaterThanOrEqual(1);
  });

  it("offers no draw size for a shuffle and asks for a deck when the reference is gone", () => {
    render(<DeckActionEditor action={{ kind: "shuffle", id: "gather", label: "Gather", deckId: "removed" }} decks={decks} onChange={() => {}} />);
    expect(screen.queryByLabelText("Cards per draw")).toBeNull();
    expect(screen.getByLabelText("Deck")).toHaveDisplayValue("Choose a deck");
    expect(screen.getByLabelText("Shuffle action name")).toHaveValue("Gather");
  });
});
