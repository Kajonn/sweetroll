import type { DeckContext, DeckState, NormalizedRoll, RuntimeResult } from "../../runtime.js";
import type { DrawActionV1, ShuffleActionV1, SystemPackageV1 } from "../package/schema/index.js";
import { createDeterministicRng } from "./deterministic-rng.js";

export type DeckAction = DrawActionV1 | ShuffleActionV1;

/**
 * Design 6.4 (C13). The order of a deck follows from the roll secret and the
 * shuffle ID alone, so a stored order can be checked again later.
 */
export function shuffledOrder(secret: string, deckId: string, shuffleId: string, cardIds: readonly string[]): string[] {
  const rng = createDeterministicRng(secret, `deck:${deckId}:${shuffleId}`);
  const order = [...cardIds];
  for (let index = order.length - 1; index > 0; index -= 1) {
    const other = Math.floor(rng() * (index + 1));
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return order;
}

/**
 * Draws from, or shuffles, the deck state the caller read under its lock.
 * `context.state` is null until the deck is first used; the first draw then
 * shuffles a full deck. Cards a later rules version removed are skipped.
 */
export function resolveDeckAction(input: {
  packageValue: SystemPackageV1;
  action: DeckAction;
  context: DeckContext | undefined;
  executionId: string;
  secret: string;
}): RuntimeResult<{ deck: DeckState; roll: NormalizedRoll | null }> {
  const { action, packageValue } = input;
  const deck = packageValue.decks?.find(candidate => candidate.id === action.deckId);
  const dataset = packageValue.referenceData.find(candidate => candidate.id === deck?.datasetId);
  if (deck === undefined || dataset === undefined || dataset.records.length === 0) {
    return {
      ok: false,
      error: { code: "invalid_package", message: "Published package runtime references are invalid.", definitionId: action.deckId },
    };
  }
  if (input.context === undefined) {
    return { ok: false, error: { code: "bad_request", message: "A deck action needs the deck state.", definitionId: action.id } };
  }
  const cards = new Map(dataset.records.map(record => [record.id, record]));
  const fresh = (): DeckState => ({
    deckId: deck.id,
    shuffleId: input.executionId,
    remaining: shuffledOrder(input.secret, deck.id, input.executionId, [...cards.keys()]),
    total: cards.size,
  });
  if (action.kind === "shuffle") return { ok: true, value: { deck: fresh(), roll: null } };

  const stored = input.context.state;
  const current = stored === null
    ? fresh()
    : { deckId: deck.id, shuffleId: stored.shuffleId, remaining: stored.remaining.filter(id => cards.has(id)), total: cards.size };
  if (current.remaining.length === 0) {
    return {
      ok: false,
      error: { code: "deck_empty", message: `${deck.label} has no cards left. Shuffle it to draw again.`, definitionId: deck.id },
    };
  }
  const drawn = current.remaining.slice(0, action.count).map(id => {
    const record = cards.get(id)!;
    return { id: record.id, label: record.label, values: { ...record.values } };
  });
  const remaining = current.remaining.slice(drawn.length);
  return {
    ok: true,
    value: {
      deck: { ...current, remaining },
      roll: {
        actionId: action.id,
        expression: `draw(${deck.id}, ${action.count})`,
        dice: [],
        bindings: [],
        total: drawn.length,
        output: `${action.label}: ${drawn.map(card => card.label).join(", ")}`,
        audience: "owner_only",
        breakdown: {
          version: "1.0",
          rootId: "cards",
          cards: { deckId: deck.id, deckLabel: deck.label, remaining: remaining.length, drawn },
          groups: [],
          terms: [{ id: "cards", operation: "literal", operandIds: [], value: drawn.length }],
        },
      },
    },
  };
}
