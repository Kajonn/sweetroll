import type { SystemDocumentV1 } from "../schema/index.js";
import { d20Document } from "./d20.js";

const suits = [["ember", "Ember"], ["tide", "Tide"], ["gale", "Gale"]] as const;
const ranks = [["first", "First", 1], ["second", "Second", 2], ["third", "Third", 3], ["crown", "Crown", 4]] as const;

/** Ember Road: an original omen deck of twelve cards, drawn two at a time (matrix row M9, cards). */
export const emberRoadDocument: SystemDocumentV1 = structuredClone(d20Document);
emberRoadDocument.metadata.name = "Ember Road";
emberRoadDocument.metadata.description = "An original example of a shared omen deck.";
emberRoadDocument.referenceData.push({
  id: "omens",
  label: "Omens",
  records: suits.flatMap(([suitId, suit]) => ranks.map(([rankId, rank, value]) => ({
    id: `${suitId}_${rankId}`,
    label: `${rank} of ${suit}`,
    values: { suit, rank: value },
  }))),
});
emberRoadDocument.decks = [{ id: "omen_deck", label: "Omen deck", datasetId: "omens" }];
emberRoadDocument.actions.push(
  { kind: "draw", id: "read_omens", label: "Read the omens", deckId: "omen_deck", count: 2 },
  { kind: "shuffle", id: "gather_omens", label: "Gather the omens", deckId: "omen_deck" },
);
emberRoadDocument.sheets[0]!.sections.at(-1)!.elements.push(
  { kind: "action", id: "read_omens_element", actionId: "read_omens" },
  { kind: "action", id: "gather_omens_element", actionId: "gather_omens" },
);
