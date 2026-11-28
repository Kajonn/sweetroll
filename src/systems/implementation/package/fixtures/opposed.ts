import { d20Document } from "./d20.js";

export const bridgeContestDocument = structuredClone(d20Document);
bridgeContestDocument.metadata.name = "Bridge Contest";
bridgeContestDocument.metadata.description = "An original example of attacks and opposed checks.";
bridgeContestDocument.actions.push(
  {
    kind: "roll", id: "attack", label: "Bridge attack", target: { entityId: "character" },
    expressionId: "attack_expr", inputs: [], outputTemplate: "Attack margin: {total}",
  },
  {
    kind: "roll", id: "counter", label: "Counter the challenge", respondsTo: true,
    expressionId: "counter_expr", inputs: [], outputTemplate: "Contest margin: {total}",
  },
);
bridgeContestDocument.expressions.push(
  { id: "attack_expr", context: "roll", resultType: "number", source: "d20 - target.defense", fallback: 0 },
  { id: "counter_expr", context: "roll", resultType: "number", source: "d20 - opposed.total", fallback: 0 },
);
bridgeContestDocument.sheets[0]!.sections.at(-1)!.elements.push(
  { kind: "action", id: "attack_element", actionId: "attack" },
  { kind: "action", id: "counter_element", actionId: "counter" },
);
