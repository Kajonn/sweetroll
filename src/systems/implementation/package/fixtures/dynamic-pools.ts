import type { SystemDocumentV1 } from "../schema/index.js";
import { d20Document } from "./d20.js";

export const dynamicPoolFixtures = [
  { id: "doubles", name: "Glass Observatory", label: "Survey anomalies", groups: ["percentile"],
    source: 'if(group("percentile", "Percentile", d100) % 11 == 0 || rolled("percentile") == 100, rolled("percentile") + 100, rolled("percentile"))' },
  { id: "difficulty", name: "Midnight Dispatch", label: "Read the signal", groups: ["signal"],
    source: 'countAtLeast(group("signal", "Signal", dice(fields.pool_size, 10)), inputs.difficulty) - countEqual(rolled("signal"), 1)' },
  { id: "step", name: "Far Beacon", label: "Cross the ridge", groups: ["trait", "wild"],
    source: 'max(group("trait", "Trait", explode(dice(1, fields.trait_die))), group("wild", "Wild", explode(d6)))' },
  { id: "keep", name: "Lantern Court", label: "Cross blades", groups: ["blades"],
    source: 'keepHighest(group("blades", "Blades", explode(dice(fields.pool_size, 10), 10)), fields.keep_count)' },
] as const;

export function dynamicPoolDocument(fixture: typeof dynamicPoolFixtures[number]): SystemDocumentV1 {
  const document = structuredClone(d20Document);
  document.metadata.name = fixture.name;
  document.metadata.description = "Reference rules for dynamic dice pools.";
  document.entities[0]!.fields.push(
    { id: "trait_die", kind: "integer", label: "Trait die", required: false, default: 8, min: 4, max: 20, step: 1 },
    { id: "pool_size", kind: "integer", label: "Pool size", required: false, default: 4, min: 0, max: 10, step: 1 },
    { id: "keep_count", kind: "integer", label: "Keep count", required: false, default: 2, min: 0, max: 10, step: 1 },
  );
  const action = document.actions.find((candidate) => candidate.id === "check");
  if (action?.kind !== "roll") throw Error("Missing reference roll action");
  action.label = fixture.label;
  action.inputs = fixture.id === "difficulty"
    ? [{ id: "difficulty", label: "Difficulty", valueType: "integer", required: false, default: 6 }]
    : [];
  document.expressions.find((expression) => expression.id === action.expressionId)!.source = fixture.source;
  return document;
}
