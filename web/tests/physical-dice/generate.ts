// Run from web with node --import tsx tests/physical-dice/generate.ts.
// Review any digest change alongside the simulation version.
import { readFile, writeFile } from "node:fs/promises";
import { createSimulation } from "../../src/physicalDice/simulation.js";
import { fixtures, checkpoints } from "./fixtures.js";
const expected = [];
for (const fixture of fixtures) {
  const sim = await createSimulation(fixture.dice, fixture.launch, async (sides) =>
    JSON.parse(await readFile(new URL(`../../public/dice/v1/d${sides}.hull.json`, import.meta.url), "utf8")),
  );
  try {
    const snapshots = [];
    for (const target of checkpoints) {
      const frame = sim.advance(target);
      snapshots.push({ tick: frame.tick, hash: await sim.checkpoint() });
      if (frame.status === "settled") {
        expected.push({ name: fixture.name, snapshots, faces: frame.dice.map((d) => d.value) });
        break;
      }
      if (target === 1200) throw Error(`${fixture.name} failed to settle`);
    }
  } finally {
    sim.free();
  }
}
await writeFile(new URL("./checkpoints.json", import.meta.url), JSON.stringify(expected, null, 2) + "\n");
