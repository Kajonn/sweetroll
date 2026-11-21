// @vitest-environment node
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createDiceLaunch } from "../../../src/systems/physical-dice/launch.js";
import { readPhysicalFace, type PhysicalDieSides } from "../../../src/systems/physical-dice/faces.js";
import { createSimulation } from "./simulation.js";

it("replays the same collision pool through different frame schedules", async () => {
  const shapes = [4, 6, 8, 10, 12, 20] as const;
  const dice = Array.from({ length: 20 }, (_, i) => ({ id: `pool:${i}`, sides: shapes[i % 6]! }));
  const launch = createDiceLaunch(dice.length, 712345, new Date(0));
  const hull = async (sides: PhysicalDieSides) =>
    JSON.parse(
      await readFile(new URL(`../../public/dice/v1/d${sides}.hull.json`, import.meta.url), "utf8"),
    ) as number[][];
  const a = await createSimulation(dice, launch, hull);
  const b = await createSimulation(dice, JSON.parse(JSON.stringify(launch)), hull);
  try {
    for (const tick of [1, 11, 45, 95, 160, 360, 720, 1200]) {
      const expected = a.advance(tick);
      for (let t = b.tick + 1; t < tick && b.status === "rolling"; t += 3) b.advance(t);
      const actual = b.advance(tick);
      expect(actual, `diverged at checkpoint ${tick}`).toEqual(expected);
      if (actual.status === "settled") {
        expect(actual.dice.map((d, i) => readPhysicalFace(dice[i]!.sides, d.orientation))).toEqual(
          actual.dice.map((d) => d.value),
        );
        return;
      }
    }
    throw Error("pool did not settle");
  } finally {
    a.free();
    b.free();
  }
});

it("changes the trajectories of two colliding dice before they reach the floor", async () => {
  const die = { id: "left", sides: 6 as const };
  const launch = createDiceLaunch(2, 27, new Date(0));
  for (const [i, body] of launch.bodies.entries()) {
    body.position = { x: i === 0 ? -0.9 : 0.9, y: 0, z: 4 };
    body.linearVelocity = { x: i === 0 ? 5 : -5, y: 0, z: 0 };
    body.angularVelocity = { x: 0, y: 0, z: 0 };
    body.orientation = { x: 0, y: 0, z: 0, w: 1 };
  }
  const hull = async () =>
    JSON.parse(await readFile(new URL("../../public/dice/v1/d6.hull.json", import.meta.url), "utf8"));
  const pair = await createSimulation([die, { ...die, id: "right" }], launch, hull);
  const single = await createSimulation([die], { ...launch, bodies: launch.bodies.slice(0, 1) }, hull);
  try {
    expect(pair.advance(3).dice[0]).toEqual(single.advance(3).dice[0]);
    const impact = pair.advance(14).dice[0]!;
    expect(impact.position.z).toBeGreaterThan(2);
    expect(impact.position.x).toBeLessThan(single.advance(14).dice[0]!.position.x - 0.2);
  } finally {
    pair.free();
    single.free();
  }
});

it("ends an unreadable throw without inventing a value", async () => {
  const launch = createDiceLaunch(1, 159, new Date(0));
  // Deliberately misaligned collider: a d6 resting on any face of this
  // tetrahedron cannot point a numbered d6 normal straight up.
  const tetra = [
    [1, 1, 1],
    [-1, -1, 1],
    [-1, 1, -1],
    [1, -1, -1],
  ];
  const sim = await createSimulation([{ id: "cocked", sides: 6 }], launch, async () => tetra);
  try {
    const frame = sim.advance(3600);
    expect(frame.status).toBe("unsettled");
    expect(frame.dice[0]!.value).toBeNull();
    expect(frame.tick).toBeLessThanOrEqual(1200);
  } finally {
    sim.free();
  }
});
