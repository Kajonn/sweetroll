import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import {
  readPhysicalFace,
  type PhysicalDieSides,
  type Orientation,
} from "../../../src/systems/physical-dice/faces.js";
import {
  randomSequence,
  simulationVersion,
  type DiceLaunch,
  type Vector3,
} from "../../../src/systems/physical-dice/launch.js";

export type Die = { id: string; sides: PhysicalDieSides };
export type Frame = {
  tick: number;
  status: "rolling" | "settled" | "unsettled";
  dice: { id: string; position: Vector3; orientation: Orientation; value: number | null }[];
};
type SimulatedDie = Die & {
  body: RAPIER.RigidBody;
  alignedTicks: number;
  cockedTicks: number;
  retries: number;
};
export const tray = { halfWidth: 12, halfHeight: 9, modelScale: 0.6, ticksPerSecond: 60 } as const;
const maxTicks = 1200;
const maxRetries = 3;
let ready: Promise<void> | undefined;

function squared(v: Vector3) {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

// A retry has its own stream so unrelated dice, frame rate and message timing cannot affect it.
function retryDie(die: SimulatedDie, seed: number) {
  let key = seed;
  for (let i = 0; i < die.id.length; i++) key = Math.imul(key ^ die.id.charCodeAt(i), 16777619);
  const random = randomSequence(key ^ ++die.retries);
  const p = die.body.translation();
  die.body.setTranslation({ x: p.x, y: p.y, z: p.z + 1.5 }, true);
  die.body.setLinvel({ x: random() * 3 - 1.5, y: random() * 3 - 1.5, z: 2 }, true);
  die.body.setAngvel({ x: random() * 18 - 9, y: random() * 18 - 9, z: random() * 18 - 9 }, true);
  die.cockedTicks = 0;
}

export async function createSimulation(
  dice: Die[],
  launch: DiceLaunch,
  loadHull: (sides: PhysicalDieSides) => Promise<number[][]>,
) {
  if (launch.version !== simulationVersion) throw Error("Incompatible dice simulation version.");
  if (
    !dice.length ||
    dice.length > 100 ||
    launch.bodies.length !== dice.length ||
    new Set(dice.map((d) => d.id)).size !== dice.length
  )
    throw Error("Invalid physical launch.");
  ready ??= RAPIER.init();
  await ready;
  // Fetch in parallel. Create colliders and bodies in wire order, independent of fetch completion.
  const shapes = [...new Set(dice.map((d) => d.sides))];
  const hulls = await Promise.all(
    shapes.map(async (sides) => {
      const points = await loadHull(sides);
      const collider = RAPIER.ColliderDesc.convexHull(
        Float32Array.from(points.flat(), (v) => v * tray.modelScale),
      );
      if (!collider) throw Error(`Invalid hull for d${sides}.`);
      return [sides, collider.setFriction(0.65).setRestitution(0.27)] as const;
    }),
  );
  const colliders = new Map(hulls);
  const world = new RAPIER.World({ x: 0, y: 0, z: -19.62 });
  const bodies: SimulatedDie[] = [];
  try {
    world.timestep = 1 / tray.ticksPerSecond;
    world.numSolverIterations = 6;
    const { halfWidth: w, halfHeight: h } = tray;
    function wall(x: number, y: number, z: number, dx: number, dy: number, dz: number) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(dx, dy, dz).setTranslation(x, y, z).setFriction(0.7).setRestitution(0.28),
      );
    }
    wall(0, 0, -0.5, w + 1, h + 1, 0.5);
    wall(-w - 0.5, 0, 4, 0.5, h + 1, 4);
    wall(w + 0.5, 0, 4, 0.5, h + 1, 4);
    wall(0, -h - 0.5, 4, w, 0.5, 4);
    wall(0, h + 0.5, 4, w, 0.5, 4);
    for (const [i, die] of dice.entries()) {
      const { position: p, orientation, linearVelocity: v, angularVelocity } = launch.bodies[i]!;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.x, p.y, p.z)
          .setRotation(orientation)
          .setLinvel(v.x, v.y, v.z)
          .setAngvel(angularVelocity)
          .setCcdEnabled(true)
          .setLinearDamping(0.32)
          .setAngularDamping(0.44),
      );
      world.createCollider(colliders.get(die.sides)!, body);
      bodies.push({ ...die, body, alignedTicks: 0, cockedTicks: 0, retries: 0 });
    }
  } catch (error) {
    world.free();
    throw error;
  }

  let tick = 0;
  let status: Frame["status"] = "rolling";
  function step() {
    world.step();
    tick++;
    let allSettled = true;
    for (const die of bodies) {
      const still = squared(die.body.linvel()) < 0.045 ** 2 && squared(die.body.angvel()) < 0.09 ** 2;
      const readable = still && readPhysicalFace(die.sides, die.body.rotation()) !== null;
      die.alignedTicks = readable ? die.alignedTicks + 1 : 0;
      die.cockedTicks = still && !readable ? die.cockedTicks + 1 : 0;
      if (die.cockedTicks >= 30) {
        if (die.retries >= maxRetries) {
          status = "unsettled";
          return;
        }
        retryDie(die, launch.seed);
      }
      if (die.alignedTicks < 18) allSettled = false;
    }
    if (allSettled) status = "settled";
    else if (tick >= maxTicks) status = "unsettled";
  }
  return {
    get tick() {
      return tick;
    },
    get status() {
      return status;
    },
    advance(targetTick: number): Frame {
      if (!Number.isSafeInteger(targetTick) || targetTick < 0) throw Error("Invalid simulation tick.");
      while (tick < targetTick && status === "rolling") step();
      return {
        tick,
        status,
        dice: bodies.map(({ id, sides, body }) => ({
          id,
          position: body.translation(),
          orientation: body.rotation(),
          value: status === "settled" ? readPhysicalFace(sides, body.rotation()) : null,
        })),
      };
    },
    // Rapier serializes the whole world, including velocities and contacts. Add the
    // Sweetroll counters that decide when to settle or rethrow. Opt-in for replay checks.
    async checkpoint(): Promise<string> {
      const snapshot = world.takeSnapshot();
      const bytes = new Uint8Array(snapshot.length + 4 * (1 + 3 * bodies.length));
      bytes.set(snapshot);
      const counters = new DataView(bytes.buffer, snapshot.length);
      counters.setUint32(0, tick, true);
      for (const [i, die] of bodies.entries()) {
        const offset = 4 + 12 * i;
        counters.setUint32(offset, die.alignedTicks, true);
        counters.setUint32(offset + 4, die.cockedTicks, true);
        counters.setUint32(offset + 8, die.retries, true);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    free() {
      world.free();
    },
  };
}
