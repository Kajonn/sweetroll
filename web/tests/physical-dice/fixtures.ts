import { createDiceLaunch } from "../../../src/systems/physical-dice/launch.js";
import type { PhysicalDieSides } from "../../../src/systems/physical-dice/faces.js";

const shapes: PhysicalDieSides[] = [4, 6, 8, 10, 12, 20];
export const fixtures = [
  ...shapes.map((sides) => ({ name: `d${sides}`, shapes: [sides], seed: 91271 + sides })),
  { name: "mixed", shapes, seed: 1234 },
  { name: "pool20", shapes: Array.from({ length: 20 }, (_, i) => shapes[i % 6]!), seed: 712345 },
].map((f) => ({
  name: f.name,
  dice: f.shapes.map((sides, i) => ({ sides, id: `pool:${i}` })),
  launch: createDiceLaunch(f.shapes.length, f.seed, new Date(0)),
}));
export const checkpoints = [0, 12, 30, 72, 1200];
