import type { DiceLaunch } from "../../../src/systems/physical-dice/launch.js";
import { createSimulation, type Die, type Frame } from "./simulation.js";

export type DiceWorkerRequest =
  | { type: "start"; dice: Die[]; launch: DiceLaunch }
  | { type: "advance"; tick: number; checkpoint?: boolean };
export type DiceWorkerResponse =
  { type: "frame"; frame: Frame; checkpoint?: string } | { type: "error"; message: string };

// One worker per attempt. A client starts it once and advances toward absolute world ticks.
// Terminating the worker cancels pending loads and releases the WASM instance.
let simulation: Awaited<ReturnType<typeof createSimulation>> | undefined;
let started = false;
let finished: Frame | undefined;
let finalCheckpoint: string | undefined;
async function handle(data: DiceWorkerRequest) {
  try {
    let frame: Frame;
    let checkpoint: string | undefined;
    if (data.type === "start") {
      if (started) throw Error("Dice worker already started.");
      started = true;
      simulation = await createSimulation(data.dice, data.launch, async (sides) => {
        const response = await fetch(`/dice/v1/d${sides}.hull.json`);
        if (!response.ok) throw Error(`Could not load hull for d${sides}.`);
        return response.json();
      });
      frame = simulation.advance(0);
    } else if (data.type === "advance" && finished) {
      frame = finished;
      if (data.checkpoint) checkpoint = finalCheckpoint;
    } else if (data.type === "advance" && simulation) {
      // A late viewer can request another batch. Never skip a physics step.
      frame = simulation.advance(Math.min(data.tick, simulation.tick + 120));
      if (data.checkpoint) checkpoint = await simulation.checkpoint();
      if (frame.status !== "rolling") {
        finalCheckpoint = checkpoint;
        finished = frame;
        simulation.free();
        simulation = undefined;
      }
    } else {
      throw Error("Start the dice worker and await its initial frame before advancing.");
    }
    self.postMessage({
      type: "frame",
      frame,
      ...(checkpoint && { checkpoint }),
    } satisfies DiceWorkerResponse);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Dice simulation failed.",
    } satisfies DiceWorkerResponse);
  }
}

// Preserve message order while loading WASM, fetching hulls or hashing a checkpoint.
let pending = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<DiceWorkerRequest>) => {
  pending = pending.then(() => handle(data));
};
