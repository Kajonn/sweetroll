import { Value } from "@sinclair/typebox/value";
import { SavedPushRollSchema } from "@sweetroll/rules";
import type { CommandResult, FrozenRequest } from "./types.js";

export function validPushResponse(
  result: CommandResult,
  request: FrozenRequest,
  characterId: string,
): boolean {
  if (!Value.Check(SavedPushRollSchema, result.roll)) return false;
  const roll = result.roll,
    push = roll.push!,
    character = result.character;
  const path = `/characters/${characterId}/rolls/${push.parentRollId}/push`;
  if (
    request.method !== "POST" ||
    request.path !== path ||
    character.characterId !== characterId ||
    character.reconciliation?.commandExecutionId !== push.rollId ||
    character.revision !== request.body.expectedRevision ||
    character.reconciliation.revision !== character.revision ||
    push.rollId === push.parentRollId ||
    push.rollId === push.rootRollId ||
    push.attempt < 1 ||
    push.attempt > push.maxAttempts ||
    (push.attempt === 1) !== (push.parentRollId === push.rootRollId)
  )
    return false;
  const dice = new Map(roll.dice.map((d) => [d.id, d]));
  if (
    dice.size !== roll.dice.length ||
    roll.dice.some((d) => !d.id || !d.groupId || d.value > d.sides) ||
    push.rerolledDiceIds.length === 0 ||
    push.rerolledDiceIds.some((id) => !dice.has(id))
  )
    return false;
  const grouped = new Set<string>();
  for (const group of roll.breakdown!.groups) {
    if (group.count !== group.diceIds.length) return false;
    for (const id of group.diceIds) {
      const die = dice.get(id);
      if (
        !die ||
        grouped.has(id) ||
        die.groupId !== group.id ||
        die.sides !== group.sides
      )
        return false;
      grouped.add(id);
    }
  }
  return (
    grouped.size === dice.size &&
    push.faceOutcomes.every((outcome) => {
      const matching = roll.dice.filter(
        (d) => d.groupId === outcome.groupId && d.value === outcome.face,
      );
      return (
        outcome.combinedCount === matching.length &&
        outcome.rerolledCount ===
          matching.filter((d) => push.rerolledDiceIds.includes(d.id!)).length
      );
    })
  );
}
