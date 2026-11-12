import { describe, expect, it } from "vitest";

import { decodeSystemDocument, decodeSystemPackage } from "../package/codec.js";
import { emberRoadDocument } from "../package/fixtures/card-decks.js";
import type { SystemDocumentV1 } from "../package/schema/index.js";
import { compileDocument } from "../rules/compile-document.js";
import { formatRollBreakdown } from "../rules/result.js";
import { createSystemRuntime, type DeckState, type RuntimeStateV1 } from "../../runtime.js";
import { shuffledOrder } from "./decks.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const versionId = "00000000-0000-4000-8000-000000000001";
const ids = { systemId: "00000000-0000-4000-8000-000000000000", versionId, semanticVersion: "1.0.0" };
const execution = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

function publish(document: SystemDocumentV1) {
  const decoded = decodeSystemDocument(document);
  if (!decoded.ok) return decoded;
  return compileDocument(decoded.value, ids);
}

function change(edit: (document: SystemDocumentV1) => void) {
  const document = structuredClone(emberRoadDocument);
  edit(document);
  return publish(document);
}

async function table() {
  const compiled = publish(emberRoadDocument);
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics));
  const runtime = createSystemRuntime({ loadPackage: async () => compiled.value, authoritativeRollSecret: SECRET });
  const created = await runtime.resolve({ versionId, entityId: "character", intent: { kind: "initialize" } });
  if (!created.ok) throw new Error(created.error.message);
  const state: RuntimeStateV1 = created.value.state;
  const act = async (actionId: string, n: number, deck?: DeckState | null) => runtime.resolve({
    versionId, entityId: "character", state,
    intent: {
      kind: "action", actionId, inputs: {}, executionId: execution(n),
      ...(deck === undefined ? {} : { deck: { state: deck } }),
    },
  });
  return { act, compiled: compiled.value, runtime, projection: created.value.projection };
}

describe("card decks (design 6.4, C13)", () => {
  it("publishes a deck over a dataset and keeps it in the package", () => {
    const compiled = publish(emberRoadDocument);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.decks).toEqual([{ id: "omen_deck", label: "Omen deck", datasetId: "omens" }]);
    expect(decodeSystemPackage(compiled.value).ok).toBe(true);
  });

  it("rejects a missing dataset, an empty deck, an unknown deck and too many cards or decks", () => {
    expect(change(d => { d.decks![0]!.datasetId = "missing"; })).toMatchObject({ ok: false, diagnostics: [{ code: "missing_reference", path: "/decks/0/datasetId" }] });
    expect(change(d => { d.referenceData[0]!.records = []; })).toMatchObject({ ok: false, diagnostics: [{ code: "limit_exceeded", path: "/decks/0/datasetId" }] });
    expect(change(d => { d.decks = []; })).toMatchObject({ ok: false, diagnostics: [{ path: "/actions/3/deckId" }, { path: "/actions/4/deckId" }] });
    expect(change(d => {
      d.referenceData[0]!.records = Array.from({ length: 201 }, (_, index) => ({
        id: `card_${index}`, label: `Card ${index}`, values: { suit: "Ember", rank: index },
      }));
    })).toMatchObject({ ok: false, diagnostics: [{ code: "limit_exceeded" }] });
    expect(change(d => {
      d.decks = Array.from({ length: 5 }, (_, index) => ({ id: `deck_${index}`, label: "Deck", datasetId: "omens" }));
    }).ok).toBe(false);
    expect(change(d => { (d.actions[3] as { count: number }).count = 11; }).ok).toBe(false);
  });

  it("projects the deck and draw size on the sheet actions", async () => {
    const { projection } = await table();
    const actions = projection.sheets.flatMap(sheet => sheet.sections).flatMap(section => section.elements)
      .filter(element => element.kind === "action");
    expect(actions).toContainEqual(expect.objectContaining({
      actionId: "read_omens", actionKind: "draw", deck: { deckId: "omen_deck", label: "Omen deck", count: 2 },
    }));
    expect(actions).toContainEqual(expect.objectContaining({
      actionId: "gather_omens", actionKind: "shuffle", deck: { deckId: "omen_deck", label: "Omen deck" },
    }));
  });

  it("derives the order from the secret and the shuffle ID", () => {
    const cards = emberRoadDocument.referenceData[0]!.records.map(card => card.id);
    const order = shuffledOrder(SECRET, "omen_deck", execution(1), cards);
    expect(order).toEqual(shuffledOrder(SECRET, "omen_deck", execution(1), cards));
    expect([...order].sort()).toEqual([...cards].sort());
    expect(order).not.toEqual(shuffledOrder(SECRET, "omen_deck", execution(2), cards));
    expect(order).not.toEqual(shuffledOrder(SECRET, "other_deck", execution(1), cards));
  });

  it("shuffles on first use, deals every card once and then reports the empty deck", async () => {
    const { act, runtime } = await table();
    expect((await act("read_omens", 1)).ok).toBe(false);
    expect((await runtime.prepareResolve({ versionId, entityId: "character" }) as { ok: true; value: { deckIdFor(id: string): string | null } })
      .value.deckIdFor("read_omens")).toBe("omen_deck");

    let deck: DeckState | null = null;
    const seen: string[] = [];
    for (let draw = 1; draw <= 6; draw += 1) {
      const result = await act("read_omens", draw, deck);
      if (!result.ok) throw new Error(result.error.message);
      const { roll } = result.value;
      deck = result.value.deck!;
      const cards = roll!.breakdown.cards!;
      expect(cards.drawn).toHaveLength(2);
      expect(cards.remaining).toBe(12 - draw * 2);
      expect(deck).toMatchObject({ deckId: "omen_deck", shuffleId: execution(1), total: 12 });
      expect(deck.remaining).toHaveLength(cards.remaining);
      expect(roll).toMatchObject({ actionId: "read_omens", total: 2, dice: [], audience: "owner_only" });
      expect(roll!.output).toBe(`Read the omens: ${cards.drawn.map(card => card.label).join(", ")}`);
      expect(cards.drawn[0]!.values).toMatchObject({ suit: expect.any(String), rank: expect.any(Number) });
      expect(formatRollBreakdown(roll!.breakdown, [])).toContain(`Omen deck 1: ${cards.drawn[0]!.label} (`);
      expect(result.value.changedDefinitionIds).toEqual([]);
      seen.push(...cards.drawn.map(card => card.id));
    }
    expect(new Set(seen).size).toBe(12);
    expect(await act("read_omens", 7, deck)).toMatchObject({
      ok: false, error: { code: "deck_empty", definitionId: "omen_deck", message: "Omen deck has no cards left. Shuffle it to draw again." },
    });

    const shuffled = await act("gather_omens", 8, deck);
    if (!shuffled.ok) throw new Error(shuffled.error.message);
    expect(shuffled.value.roll).toBeNull();
    expect(shuffled.value.deck).toMatchObject({ shuffleId: execution(8), total: 12 });
    expect(shuffled.value.deck!.remaining).toHaveLength(12);
  });

  it("deals the last card of an odd deck and skips cards the rules no longer define", async () => {
    const { act } = await table();
    const last = await act("read_omens", 1, { deckId: "omen_deck", shuffleId: execution(9), total: 12, remaining: ["removed_card", "tide_crown"] });
    if (!last.ok) throw new Error(last.error.message);
    expect(last.value.roll!.breakdown.cards).toMatchObject({ remaining: 0, drawn: [{ id: "tide_crown", label: "Crown of Tide" }] });
    expect(last.value.deck).toMatchObject({ shuffleId: execution(9), remaining: [] });
  });

  it("refuses inputs and campaign roll context on deck actions", async () => {
    const { runtime, compiled } = await table();
    const created = await runtime.resolve({ versionId: compiled.versionId, entityId: "character", intent: { kind: "initialize" } });
    if (!created.ok) throw new Error(created.error.message);
    const base = { kind: "action" as const, actionId: "read_omens", executionId: execution(1), deck: { state: null } };
    expect(await runtime.resolve({ versionId, entityId: "character", state: created.value.state, intent: { ...base, inputs: { bonus: 1 } } }))
      .toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(await runtime.resolve({
      versionId, entityId: "character", state: created.value.state,
      intent: { ...base, inputs: {}, campaignRoll: { opposed: { rollId: execution(2), total: 3 } } },
    })).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});
