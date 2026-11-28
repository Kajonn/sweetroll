import { tray } from "../../../src/systems/physical-dice/launch.js";
import type { RollStarted } from "../../../src/campaigns/physical-dice-stream.js";
import type { Settlement } from "../../../src/characters/physical-rolls.js";
import type { Frame } from "./simulation.js";
import type { DiceWorkerRequest, DiceWorkerResponse } from "./worker.js";

export function serverClock(serverTime: string) {
  const server = Date.parse(serverTime);
  const local = performance.now();
  return () => server + performance.now() - local;
}

export function playThrow(
  attempt: Pick<RollStarted, "dice" | "launch" | "expiresAt">,
  now: () => number,
  signal: AbortSignal,
  onFrame?: (frame: Frame) => void,
): Promise<Settlement> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker("/dice/v1/worker.js", { type: "module" });
    const start = Date.parse(attempt.launch.startsAt);
    const expires = Date.parse(attempt.expiresAt);
    let frameTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => fail(Error("The dice throw expired.")), Math.max(0, expires - now()));
    function close() {
      worker.terminate();
      clearTimeout(timeout);
      clearTimeout(frameTimer);
      signal.removeEventListener("abort", abort);
    }
    function fail(error: unknown) {
      close();
      reject(error);
    }
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const send = (message: DiceWorkerRequest) => worker.postMessage(message);
    worker.onerror = () => fail(Error("The dice simulation could not start."));
    worker.onmessageerror = () => fail(Error("The dice simulation could not deliver a frame."));
    worker.onmessage = ({ data }: MessageEvent<DiceWorkerResponse>) => {
      if (data.type === "error") {
        fail(Error(data.message));
        return;
      }
      const { frame } = data;
      onFrame?.(frame);
      if (frame.status === "settled") {
        const dice = frame.dice.flatMap((die) => (die.value === null ? [] : [{ ...die, value: die.value }]));
        if (dice.length !== attempt.dice.length) {
          fail(Error("The dice did not settle cleanly."));
          return;
        }
        close();
        resolve({ tick: frame.tick, dice });
      } else if (frame.status === "unsettled") {
        fail(Error("The dice did not settle cleanly."));
      } else {
        const advance = () => {
          const target = Math.floor(((now() - start) * tray.ticksPerSecond) / 1000);
          if (target > frame.tick) send({ type: "advance", tick: target });
          else frameTimer = setTimeout(advance, 16);
        };
        advance();
      }
    };
    send({ type: "start", dice: attempt.dice, launch: attempt.launch });
  });
}
