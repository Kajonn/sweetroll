import { describe, expect, it } from "vitest";

import { closestPhysicalFace, readPhysicalFace } from "./faces.js";

describe("numbered Vtrpg models in a Z-up tray", () => {
  it("reads 3 on the d6 when its engraved local +Z face is up", () => {
    expect(readPhysicalFace(6, { x: 0, y: 0, z: 0, w: 1 })).toBe(3);
  });

  it("reads the raised 1 on a d4 with its local −Y support face down", () => {
    const half = Math.SQRT1_2;
    expect(readPhysicalFace(4, { x: half, y: 0, z: 0, w: half })).toBe(1);
  });
});

it("leaves a cube balanced on an edge unread", () => {
  expect(readPhysicalFace(6, { x: Math.sin(Math.PI / 8), y: 0, z: 0, w: Math.cos(Math.PI / 8) })).toBeNull();
});

it("rejects malformed physics rotations", () => {
  for (const w of [0, 0.9, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(readPhysicalFace(6, { x: 0, y: 0, z: 0, w })).toBeNull();
  }
});

describe("closest face", () => {
  it("reads the face nearest to up for a die resting tilted", () => {
    // 30 degrees about X: too far for the strict reader, still nearest to +Z (value 3).
    const tilt = { x: Math.sin(Math.PI / 12), y: 0, z: 0, w: Math.cos(Math.PI / 12) };
    expect(readPhysicalFace(6, tilt)).toBeNull();
    expect(closestPhysicalFace(6, tilt)).toBe(3);
  });

  it("agrees with the strict reader for a flat die, including the d4 support face", () => {
    const half = Math.SQRT1_2;
    expect(closestPhysicalFace(6, { x: 0, y: 0, z: 0, w: 1 })).toBe(3);
    expect(closestPhysicalFace(4, { x: half, y: 0, z: 0, w: half })).toBe(1);
  });

  it("still rejects malformed physics rotations", () => {
    for (const w of [0, 0.9, Number.NaN]) expect(closestPhysicalFace(6, { x: 0, y: 0, z: 0, w })).toBeNull();
  });
});
