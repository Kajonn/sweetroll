import { faceNormals } from "./normals.js";

export type PhysicalDieSides = keyof typeof faceNormals;
export type Orientation = Readonly<{ x: number; y: number; z: number; w: number }>;

// Cosine of 10 degrees. The closest two reading directions in this set are
// over 40 degrees apart, so at most one face can satisfy this threshold.
const minimumAlignment = 0.984807753;

/** Reads a settled die from its OBJ-local to Z-up world rotation. A cocked
 * die or invalid quaternion has no face value. Motion is checked by the caller. */
export function readPhysicalFace(sides: PhysicalDieSides, { x, y, z, w }: Orientation): number | null {
  const normSquared = x * x + y * y + z * z + w * w;
  if (!Number.isFinite(normSquared) || Math.abs(normSquared - 1) > 0.0001) return null;

  // The world Z row of the rotation matrix gives world up in model space.
  const upX = 2 * (x * z - w * y) / normSquared;
  const upY = 2 * (y * z + w * x) / normSquared;
  const upZ = 1 - 2 * (x * x + y * y) / normSquared;
  const supportDirection = sides === 4 ? -1 : 1;
  const index = faceNormals[sides].findIndex(([nx, ny, nz]) =>
    supportDirection * (nx * upX + ny * upY + nz * upZ) >= minimumAlignment,
  );
  return index < 0 ? null : index + 1;
}
