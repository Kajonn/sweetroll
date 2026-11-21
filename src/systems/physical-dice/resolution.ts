import { children, containsDice } from "../implementation/rules/groups.js";
import type { ExpressionAstV1 } from "../implementation/package/schema/expression.js";
import type { PoolDraw } from "../implementation/rules/evaluate.js";
import {
  readPhysicalFace,
  type Orientation,
  type PhysicalDieSides,
} from "./faces.js";

export type PhysicalDie = {
  id: string;
  groupId: string;
  sides: PhysicalDieSides;
};
export type SettledDie = {
  id: string;
  value: number;
  orientation: Orientation;
  position: { x: number; y: number; z: number };
};

function hasFixedDraws(node: ExpressionAstV1): boolean {
  if (
    node.kind === "pool" &&
    (node.source.kind === "custom" ||
      node.modifiers.length ||
      (node.source.kind === "dice" &&
        (containsDice(node.source.count) || containsDice(node.source.sides))))
  )
    return false;
  if (
    node.kind === "call" &&
    node.function === "if" &&
    containsDice(node.arguments[0]!)
  )
    return false;
  if (
    node.kind === "binary" &&
    ["&&", "||"].includes(node.operator) &&
    containsDice(node.left)
  )
    return false;
  return children(node).every(hasFixedDraws);
}

/** One instance per evaluation. In preview mode draws enumerate the throw.
 * In completion mode each draw must match its original slot exactly. */
export class PhysicalDraws {
  readonly dice: PhysicalDie[] = [];
  private valid = true;
  constructor(
    private readonly expected?: PhysicalDie[],
    private readonly values?: number[],
  ) {}

  checkExpression(ast: ExpressionAstV1) {
    this.valid &&= hasFixedDraws(ast);
  }

  get supported() {
    return this.valid;
  }

  get complete() {
    return (
      this.valid &&
      this.dice.length > 0 &&
      (!this.expected || this.dice.length === this.expected.length)
    );
  }

  readonly draw: PoolDraw = (id, _chain, sides, groupId) => {
    const index = this.dice.length;
    if (![4, 6, 8, 10, 12, 20].includes(sides)) this.valid = false;
    this.dice.push({ id, sides: sides as PhysicalDieSides, groupId });
    if (!this.expected) return 0.5;
    const slot = this.expected[index];
    const value = this.values?.[index];
    if (
      !slot ||
      slot.id !== id ||
      slot.groupId !== groupId ||
      slot.sides !== sides ||
      value === undefined
    ) {
      this.valid = false;
      return 0.5;
    }
    return (value - 0.5) / sides;
  };
}

export function settledValues(
  dice: PhysicalDie[],
  settled: SettledDie[],
): number[] | null {
  if (dice.length !== settled.length) return null;
  for (const [i, die] of dice.entries()) {
    const pose = settled[i]!;
    if (
      pose.id !== die.id ||
      !Number.isInteger(pose.value) ||
      !Object.values(pose.position).every(Number.isFinite) ||
      readPhysicalFace(die.sides, pose.orientation) !== pose.value
    )
      return null;
  }
  return settled.map((d) => d.value);
}
