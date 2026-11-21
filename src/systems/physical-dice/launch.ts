import type { Orientation } from "./faces.js";

export const simulationVersion = "rapier-v1" as const;
export type Vector3 = { x: number; y: number; z: number };
export type LaunchBody = {
  position: Vector3;
  orientation: Orientation;
  linearVelocity: Vector3;
  angularVelocity: Vector3;
};
export type DiceLaunch = {
  version: typeof simulationVersion;
  seed: number;
  startsAt: string;
  bodies: LaunchBody[];
};

// Mulberry32. Keep all PRNG arithmetic 32-bit, including the zero seed.
export function randomSequence(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = Math.imul(state ^ (state >>> 15), state | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x100000000;
  };
}

function randomRotation(random: () => number): Orientation {
  for (;;) {
    const [x, y, z, w] = [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1] as const;
    const squared = x * x + y * y + z * z + w * w;
    if (squared <= 0.0001 || squared > 1) continue;
    const n = Math.sqrt(squared);
    return { x: Math.fround(x / n), y: Math.fround(y / n), z: Math.fround(z / n), w: Math.fround(w / n) };
  }
}

export function createDiceLaunch(count: number, seed: number, startsAt: Date): DiceLaunch {
  if (!Number.isInteger(count) || count < 1 || count > 100) throw Error("Invalid physical pool size.");
  const random = randomSequence(seed);
  const range = (lo: number, hi: number) => Math.fround(lo + (hi - lo) * random());
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  // One grid cell per die keeps even a 100-die launch free of overlap.
  const bodies = Array.from({ length: count }, (_, index) => {
    const x = ((index % columns) - (columns - 1) / 2) * 1.65;
    const y = (Math.floor(index / columns) - (rows - 1) / 2) * 1.65;
    return {
      position: { x: Math.fround(x), y: Math.fround(y), z: range(2.6, 4.2) },
      orientation: randomRotation(random),
      linearVelocity: {
        x: Math.fround(-0.75 * x + range(-2.2, 2.2)),
        y: Math.fround(-0.75 * y + range(-2.2, 2.2)),
        z: range(0.3, 2.2),
      },
      angularVelocity: { x: range(-13, 13), y: range(-13, 13), z: range(-13, 13) },
    };
  });
  return { version: simulationVersion, seed, startsAt: startsAt.toISOString(), bodies };
}
