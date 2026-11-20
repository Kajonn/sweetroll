import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readPhysicalFace, type Orientation, type PhysicalDieSides } from "../../src/systems/physical-dice/faces.js";
import { supportTriangles } from "./support-triangles.js";

type Point = [number, number, number];
const folder = new URL("../../web/public/dice/v1/", import.meta.url);

function unit([x, y, z]: Point): Point {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function supportNormal([a, b, c]: Point[]): Point {
  const [x, y, z] = b!.map((n, i) => n - a![i]!) as Point;
  const [u, v, w] = c!.map((n, i) => n - a![i]!) as Point;
  return unit([y * w - z * v, z * u - x * w, x * v - y * u]);
}

function faceDown([x, y, z]: Point): Orientation {
  if (z > 1 - 1e-10) return { x: 1, y: 0, z: 0, w: 0 };
  const length = Math.hypot(y, x, 1 - z);
  return { x: -y / length, y: x / length, z: 0, w: (1 - z) / length };
}

function compose(a: Orientation, b: Orientation): Orientation {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

for (const sides of [4, 6, 8, 10, 12, 20] as const satisfies readonly PhysicalDieSides[]) {
  describe(`d${sides} numbered mesh`, () => {
    const obj = readFileSync(new URL(`${sides}Dice.obj`, folder), "utf8");
    const vertices = obj.split("\n").filter(line => line.startsWith("v "))
      .map(line => line.trim().split(/\s+/).slice(1).map(Number) as Point);

    it("resolves its two materials for independent body and marking colors", () => {
      const library = /^mtllib (.+)$/m.exec(obj)![1]!.trim();
      const mtl = readFileSync(new URL(library, folder), "utf8");
      for (const name of ["White", "Black"]) {
        expect(obj).toContain(`usemtl ${name}`);
        expect(mtl).toContain(`newmtl ${name}`);
      }
    });

    it("shares the mesh coordinate frame with its baked collision hull", () => {
      const hull: Point[] = JSON.parse(readFileSync(new URL(`d${sides}.hull.json`, folder), "utf8"));
      const points = new Set(hull.map(point => point.join(",")));
      const source = new Set(vertices.map(point => point.join(",")));
      expect(points.size).toBe(hull.length);
      expect(hull.every(point => source.has(point.join(",")))).toBe(true);
      for (const triangle of supportTriangles[sides]) {
        for (const index of triangle) expect(points.has(vertices[index - 1]!.join(","))).toBe(true);
      }
    });

    for (const [index, triangle] of supportTriangles[sides].entries()) {
      it(`reads engraved outcome ${index + 1} under eight headings and a tilt`, () => {
        const rest = faceDown(supportNormal(triangle.map(i => vertices[i - 1]!)));
        const tilt = { x: Math.sin(Math.PI / 72), y: 0, z: 0, w: Math.cos(Math.PI / 72) };
        for (let heading = 0; heading < 8; heading++) {
          const angle = heading * Math.PI / 8;
          const yaw = { x: 0, y: 0, z: Math.sin(angle), w: Math.cos(angle) };
          expect(readPhysicalFace(sides, compose(tilt, compose(yaw, rest)))).toBe(index + 1);
        }
      });
    }
  });
}
