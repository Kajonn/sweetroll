import type { SystemDocumentV1 } from "../schema/index.js";
import type { CustomDie } from "../schema/dice.js";
import { d20Document } from "./d20.js";

export const customDiceFixtures = [
  {
    id: "fudge",
    name: "Winter Compass",
    action: "Find the pass",
    dice: { id: "custom_die_1", label: "Compass die", faces: [
      { value: -1, label: "Against" }, { value: 0, label: "Still" }, { value: 1, label: "With" },
    ] },
    source: 'dice(4, "custom_die_1")',
  },
  {
    id: "symbols",
    name: "Signal Forge",
    action: "Tune the beacon",
    dice: { id: "signal_die", label: "Signal die", faces: [
      { value: 0, label: "Spark", symbols: { hit: 2 } },
      { value: 0, label: "Haze", symbols: { snag: 1 } },
      { value: 0, label: "Echo", symbols: { hit: 1, snag: 1 } },
    ] },
    source: 'countSymbol(group("signal", "Signals", dice(4, "signal_die")), "hit") - countSymbol(rolled("signal"), "snag")',
  },
] satisfies Array<{ id: string; name: string; action: string; dice: CustomDie; source: string }>;

export function customDiceDocument(fixture: typeof customDiceFixtures[number]): SystemDocumentV1 {
  const document = structuredClone(d20Document);
  document.metadata.name = fixture.name;
  document.metadata.description = "Reference rules for custom dice.";
  document.dice = [structuredClone(fixture.dice)];
  const action = document.actions.find(candidate => candidate.id === "check");
  if (action?.kind !== "roll") throw Error("Missing reference roll action");
  action.label = fixture.action;
  action.inputs = [];
  document.expressions.find(expression => expression.id === action.expressionId)!.source = fixture.source;
  return document;
}
