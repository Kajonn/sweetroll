import type { SystemDocumentV1 } from "../schema/index.js";
import { d20Document } from "./d20.js";
import { namedDicePoolDocument } from "./named-dice-pool.js";
import { pbta2d6Document } from "./pbta-2d6.js";

/**
 * Original reference systems for roll outcomes (rules coverage R5, design
 * Section 16.2): banded 2d6 moves (M3) and graded d100 roll-under (M5).
 */
function rollAction(document: SystemDocumentV1, id: string) {
  const action = document.actions.find((candidate) => candidate.id === id);
  if (action?.kind !== "roll") throw new Error(`Missing roll action ${id}`);
  return action;
}

/** M3: 2d6 + stat. 10 or more is a strong hit, 7–9 a weak hit, anything else a miss. */
export function movesDocument(): SystemDocumentV1 {
  const document = structuredClone(pbta2d6Document);
  document.metadata.name = "Hearthbound";
  const move = rollAction(document, "make_move");
  move.outputTemplate = "{outcome} ({total})";
  move.outcomes = [
    { id: "strong_hit", label: "Strong hit", expressionId: "move_strong" },
    { id: "weak_hit", label: "Weak hit", expressionId: "move_weak" },
    { id: "miss", label: "Miss", expressionId: "move_miss" },
  ];
  document.expressions.push(
    { id: "move_strong", context: "outcome", resultType: "boolean", source: "roll.total >= 10", fallback: false },
    { id: "move_weak", context: "outcome", resultType: "boolean", source: "roll.total >= 7", fallback: false },
    { id: "move_miss", context: "outcome", resultType: "boolean", source: "true", fallback: false },
  );
  return document;
}

/**
 * M5: roll d100 at or under a skill. Doubles are a critical when they succeed
 * and a fumble when they fail; the detail counts success levels.
 */
export function gradedPercentileDocument(): SystemDocumentV1 {
  const document = structuredClone(d20Document);
  document.metadata.name = "Brass Ledger";
  document.metadata.defaultDice = "d100";
  document.entities[0]!.fields.push(
    { id: "skill", kind: "integer", label: "Skill", required: false, default: 50, min: 1, max: 99, step: 1 },
  );
  document.sheets[0]!.sections[0]!.elements.push({ kind: "field", id: "skill_element", fieldId: "skill" });
  const check = rollAction(document, "check");
  check.label = "Skill test";
  check.inputs = [];
  check.outputTemplate = "{total} against {fields.skill}: {outcome}, {detail.levels} success levels";
  check.outcomes = [
    { id: "critical", label: "Critical", expressionId: "test_critical" },
    { id: "success", label: "Success", expressionId: "test_success" },
    { id: "fumble", label: "Fumble", expressionId: "test_fumble" },
    { id: "failure", label: "Failure", expressionId: "test_failure" },
  ];
  check.details = [{ id: "levels", label: "Success levels", expressionId: "test_levels" }];
  document.expressions.find((expression) => expression.id === check.expressionId)!.source = 'group("percent", "Percent", d100)';
  const doubles = 'floor(rolled("percent") / 10) == rolled("percent") % 10';
  document.expressions.push(
    { id: "test_critical", context: "outcome", resultType: "boolean", source: `roll.total <= fields.skill && ${doubles}`, fallback: false },
    { id: "test_success", context: "outcome", resultType: "boolean", source: "roll.total <= fields.skill", fallback: false },
    { id: "test_fumble", context: "outcome", resultType: "boolean", source: doubles, fallback: false },
    { id: "test_failure", context: "outcome", resultType: "boolean", source: "true", fallback: false },
    { id: "test_levels", context: "outcome", resultType: "number", source: "floor(fields.skill / 10) - floor(roll.total / 10)", fallback: 0 },
  );
  return document;
}

/** A pushable named pool whose result is graded again after every push. */
export function gradedPushDocument(): SystemDocumentV1 {
  const document = namedDicePoolDocument();
  document.metadata.name = "Relay Outcomes";
  const test = rollAction(document, "test_pool");
  test.pushPolicy = {
    version: "1.0", maxAttempts: 1, successThreshold: 1, allowOnSuccess: true,
    groups: [{ groupId: "attribute", lockedFaces: [], reportedFaces: [1] }],
  };
  test.outcomes = [
    { id: "success", label: "Success", expressionId: "pool_success" },
    { id: "failure", label: "Failure", expressionId: "pool_failure" },
  ];
  document.expressions.push(
    // Reads a field the roll formula does not, so the push must have it saved.
    { id: "pool_success", context: "outcome", resultType: "boolean", source: "roll.total >= 1 && fields.attribute >= 0", fallback: false },
    { id: "pool_failure", context: "outcome", resultType: "boolean", source: "true", fallback: false },
  );
  return document;
}
