import type { APIRequestContext } from "@playwright/test";

import { uid } from "../offline/test-auth.js";

/**
 * Full-table journey system fixture (Task 2).
 *
 * A D&D-like system document mirroring the shape and nesting of
 * `src/systems/implementation/package/fixtures/d20.ts` (`entities`,
 * `sheets[].sections[].elements`, `expressions`, `actions`, `validations`)
 * with `entityDefinitionId: "character"`. All labels and descriptions use
 * original wording (no third-party text). Every expression uses only
 * grammar-v0.1 constructs also present in `fixtures/d20.ts:116-173`
 * (binary arithmetic, `d20` dice, `&&` comparisons) plus `round(x, down)`
 * for the ability modifiers — the grammar's only floor operation
 * (`round` with mode `down` evaluates to `Math.floor`; the grammar has no
 * `floor` function).
 *
 * Published through the real System Builder API by `publishJourneySystem`
 * (clone → replace draft → publish); server validation in Task 3 is the
 * gate for this document.
 */

export const JOURNEY_CODES = {
  gm: "code-journey-gm",
  players: ["code-journey-p1", "code-journey-p2", "code-journey-p3", "code-journey-p4", "code-journey-p5"],
} as const;

const ABILITIES = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] as const;

function abilityLabel(ability: string): string {
  return ability.charAt(0).toUpperCase() + ability.slice(1);
}

export const JOURNEY_DOCUMENT = {
  schemaVersion: "1.0",
  metadata: {
    name: "Table Journey System",
    description: "Original trial system for the full-table journey test: six ability scores with derived modifiers, two tracked resources, and simple combat actions.",
    language: "en",
    defaultDice: "d20",
  },
  entities: [
    {
      id: "character",
      label: "Character",
      fields: [
        ...ABILITIES.map((ability) => ({
          kind: "integer",
          id: ability,
          label: abilityLabel(ability),
          default: 10,
          required: true,
          min: 3,
          max: 18,
          step: 1,
        })),
        ...ABILITIES.map((ability) => ({
          kind: "computed",
          id: `${ability}_mod`,
          label: `${abilityLabel(ability)} Modifier`,
          valueType: "number",
          expressionId: `${ability}_mod_expr`,
        })),
        {
          kind: "integer",
          id: "proficiency",
          label: "Proficiency Bonus",
          default: 2,
          required: true,
          min: 1,
          max: 10,
          step: 1,
        },
        {
          kind: "integer",
          id: "armor_class",
          label: "Armor Class",
          default: 10,
          required: true,
          min: 1,
          max: 30,
          step: 1,
        },
        {
          kind: "resource",
          id: "hit_points",
          label: "Hit Points",
          default: { current: 10, max: 10 },
          min: 0,
          max: 30,
          step: 1,
          resetTo: "max",
        },
        {
          kind: "resource",
          id: "spell_slots",
          label: "Spell Slots",
          default: { current: 2, max: 2 },
          min: 0,
          max: 9,
          step: 1,
          resetTo: "max",
        },
        {
          kind: "singleChoice",
          id: "ancestry",
          label: "Ancestry",
          required: false,
          default: null,
          options: [
            { id: "human", label: "Human" },
            { id: "elf", label: "Elf" },
            { id: "dwarf", label: "Dwarf" },
          ],
        },
      ],
    },
  ],
  referenceData: [],
  sheets: [
    {
      id: "character_sheet",
      label: "Character",
      targetEntityId: "character",
      sections: [
        {
          id: "basics",
          label: "Basics",
          elements: [
            { kind: "heading", id: "basics_heading", text: "Basics", level: 2 },
            { kind: "field", id: "ancestry_element", fieldId: "ancestry" },
          ],
        },
        {
          id: "abilities",
          label: "Abilities",
          elements: [
            { kind: "heading", id: "abilities_heading", text: "Abilities", level: 2 },
            ...ABILITIES.map((ability) => ({
              kind: "field",
              id: `${ability}_element`,
              fieldId: ability,
            })),
            ...ABILITIES.map((ability) => ({
              kind: "field",
              id: `${ability}_mod_element`,
              fieldId: `${ability}_mod`,
            })),
          ],
        },
        {
          id: "combat",
          label: "Combat",
          elements: [
            { kind: "heading", id: "combat_heading", text: "Combat", level: 2 },
            { kind: "resource", id: "hit_points_element", resourceId: "hit_points" },
            { kind: "resource", id: "spell_slots_element", resourceId: "spell_slots" },
            { kind: "action", id: "longsword_attack_element", actionId: "longsword_attack" },
            { kind: "action", id: "shortbow_attack_element", actionId: "shortbow_attack" },
            { kind: "action", id: "strength_save_element", actionId: "strength_save" },
          ],
        },
      ],
    },
  ],
  expressions: [
    ...ABILITIES.map((ability) => ({
      id: `${ability}_mod_expr`,
      context: "computed",
      resultType: "number",
      source: `round((fields.${ability} - 10) / 2, down)`,
      fallback: 0,
    })),
    {
      id: "longsword_attack_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.strength_mod + fields.proficiency",
      fallback: 0,
    },
    {
      id: "shortbow_attack_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.dexterity_mod + fields.proficiency",
      fallback: 0,
    },
    {
      id: "strength_save_expr",
      context: "roll",
      resultType: "number",
      source: "d20 + fields.strength_mod",
      fallback: 0,
    },
    ...ABILITIES.map((ability) => ({
      id: `${ability}_valid_expr`,
      context: "validation",
      resultType: "boolean",
      source: `fields.${ability} >= 3 && fields.${ability} <= 18`,
      fallback: false,
    })),
  ],
  actions: [
    {
      kind: "roll",
      id: "longsword_attack",
      label: "Longsword Attack",
      expressionId: "longsword_attack_expr",
      inputs: [],
      outputTemplate: "The longsword strike totals {total}.",
    },
    {
      kind: "roll",
      id: "shortbow_attack",
      label: "Shortbow Attack",
      expressionId: "shortbow_attack_expr",
      inputs: [],
      outputTemplate: "The shortbow shot totals {total}.",
    },
    {
      kind: "roll",
      id: "strength_save",
      label: "Strength Save",
      expressionId: "strength_save_expr",
      inputs: [],
      outputTemplate: "The strength save totals {total}.",
    },
    {
      kind: "resourceBump",
      id: "damage_enemy",
      label: "Damage Enemy",
      resourceId: "hit_points",
      operation: { kind: "delta", amount: -1 },
    },
    {
      kind: "resourceBump",
      id: "second_wind",
      label: "Second Wind",
      resourceId: "hit_points",
      operation: { kind: "delta", amount: 1 },
    },
  ],
  validations: [
    ...ABILITIES.map((ability) => ({
      id: `${ability}_valid`,
      expressionId: `${ability}_valid_expr`,
      severity: "error",
      message: `${abilityLabel(ability)} must be between 3 and 18`,
      targetId: ability,
    })),
  ],
} as const;

export const JOURNEY_ACTION_LABELS = {
  longsword: "Longsword Attack",
  shortbow: "Shortbow Attack",
  save: "Strength Save",
} as const;

/**
 * Publish the journey system through the real System Builder API: clone
 * the reference system, replace the draft document with JOURNEY_DOCUMENT,
 * and publish. Payload shapes copied from `publishOwnedClone` in
 * `web/tests/offline/test-auth.ts:261-297`; only the document differs.
 */
export async function publishJourneySystem(request: APIRequestContext, sourceVersionId: string): Promise<string> {
  const created = await request.post("/api/systems", {
    data: { source: { kind: "clone", versionId: sourceVersionId }, idempotencyKey: `journey-sys-${uid()}` },
  });
  if (created.status() !== 201) throw new Error(`clone failed: ${created.status()} ${await created.text()}`);
  const workspace = (await created.json()) as { workspace: { system: { systemId: string }; draft: { revision: number } | null } };
  const systemId = workspace.workspace.system.systemId;
  const draft = workspace.workspace.draft;
  if (draft === null) throw new Error("clone produced no draft");
  const saved = await request.put(`/api/systems/${systemId}/draft`, {
    data: { expectedRevision: draft.revision, document: JOURNEY_DOCUMENT },
  });
  if (saved.status() !== 200) throw new Error(`save journey draft failed: ${saved.status()} ${await saved.text()}`);
  const nextRevision = ((await saved.json()) as { workspace: { draft: { revision: number } } }).workspace.draft.revision;
  const published = await request.post(`/api/systems/${systemId}/publish`, {
    data: { expectedRevision: nextRevision, semanticVersion: "1.0.0", releaseNotes: "Table journey system", idempotencyKey: `journey-pub-${uid()}`, acknowledgeBreaking: true },
  });
  if (published.status() !== 200) throw new Error(`publish failed: ${published.status()} ${await published.text()}`);
  const versionId = ((await published.json()) as { version: { versionId: string } }).version.versionId;
  // OD-01 option A: versionless enumeration (the /characters/new picker)
  // lists only owned + public systems; a fresh clone is private, so the
  // GM-owned system must be public for players to discover it. Reference
  // seeds stay link-access/unlisted.
  const shared = await request.patch(`/api/systems/${systemId}`, { data: { access: "public" } });
  if (shared.status() !== 200) throw new Error(`share journey system failed: ${shared.status()} ${await shared.text()}`);
  return versionId;
}
