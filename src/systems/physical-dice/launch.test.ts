import { expect, it } from "vitest";
import { createDiceLaunch } from "./launch.js";

it("round-trips the starting state of a full 100-die tray exactly as float32 JSON", () => {
  const launch = createDiceLaunch(100, 0, new Date(0));
  expect(launch.bodies).toHaveLength(100);
  expect(JSON.parse(JSON.stringify(launch))).toEqual(launch);
  for (const body of launch.bodies) {
    for (const vector of Object.values(body)) {
      for (const component of Object.values(vector)) expect(component).toBe(Math.fround(component));
    }
    const { x, y, z, w } = body.orientation;
    expect(x * x + y * y + z * z + w * w).toBeCloseTo(1, 6);
  }
  expect(createDiceLaunch(100, 1, new Date(0)).bodies).not.toEqual(launch.bodies);
});
