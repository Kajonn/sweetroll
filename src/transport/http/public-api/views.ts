import type { CharacterView } from "../../../characters/index.js";

export function characterSheet(character: CharacterView) {
  const { characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt, derivedValues, validations } = character;
  // Computed template fields per entry, from the sheet projection.
  const derived = new Map<string, Record<string, string | number | boolean | null>>();
  for (const sheet of character.projection.sheets) {
    for (const section of sheet.sections) {
      for (const element of section.elements) {
        if (element.kind !== "slot") continue;
        for (const entry of element.entries) {
          if (entry.derived !== undefined) derived.set(entry.entryId, Object.fromEntries(entry.derived.map(({ id, value }) => [id, value])));
        }
      }
    }
  }
  return {
    characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt,
    ownerId: character.ownerId,
    campaign: character.campaignId === null ? null : {
      campaignId: character.campaignId, controllers: character.controllers,
      placementGeneration: character.placementGeneration, returnOwnerId: character.returnOwnerId,
    },
    extensions: character.extensions,
    values: character.state.values, derivedValues, validations,
    entries: Object.values(character.state.entries ?? {}).map(({ entryId, slotId, templateId, extensionId, values, quantity, source }) => ({
      entryId, slotId, templateId, values, ...(quantity === undefined ? {} : { quantity }),
      ...(derived.has(entryId) ? { derivedValues: derived.get(entryId)! } : {}),
      ...(extensionId === undefined ? {} : { extensionId }),
      ...(source === undefined ? {} : { source }),
    })),
  };
}

export function characterMutation({ characterId, revision }: CharacterView) {
  return { characterId, revision };
}
