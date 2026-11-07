import type { CharacterView } from "../../../characters/index.js";

export function characterSheet(character: CharacterView) {
  const { characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt, derivedValues, validations } = character;
  return {
    characterId, systemVersionId, entityDefinitionId, name, revision, lifecycle, createdAt, updatedAt,
    ownerId: character.ownerId,
    campaign: character.campaignId === null ? null : {
      campaignId: character.campaignId, controllers: character.controllers,
      placementGeneration: character.placementGeneration, returnOwnerId: character.returnOwnerId,
    },
    values: character.state.values, derivedValues, validations,
    entries: Object.values(character.state.entries ?? {}).map(({ entryId, slotId, templateId, values, quantity, source }) => ({
      entryId, slotId, templateId, values, ...(quantity === undefined ? {} : { quantity }),
      ...(source === undefined ? {} : { source }),
    })),
  };
}

export function characterMutation({ characterId, revision }: CharacterView) {
  return { characterId, revision };
}
