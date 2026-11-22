import type { DiceLaunch } from "../../../src/systems/physical-dice/launch.js";
import type { PhysicalDie } from "../../../src/systems/physical-dice/resolution.js";
import type { ApiClient } from "../api/client.js";
import type { FrozenRequest } from "../characters/types.js";
import { playThrow, serverClock } from "./playback.js";

export type PrepareDice = (request: FrozenRequest, signal: AbortSignal) => Promise<FrozenRequest>;
type PreparedThrow = { attemptId: string; color: string; expiresAt: string; launch: DiceLaunch; dice: PhysicalDie[] };
export type SimulateDice = (attempt: PreparedThrow, now: () => number, signal: AbortSignal) => ReturnType<typeof playThrow>;

export async function preparePhysicalRequest(
  client: ApiClient,
  request: FrozenRequest,
  signal: AbortSignal,
  simulate: SimulateDice = playThrow,
): Promise<FrozenRequest> {
  if (request.physical || request.method !== "POST") return request;
  const action = /^\/characters\/([^/]+)\/actions\/([^/]+)$/.exec(request.path);
  const push = /^\/characters\/([^/]+)\/rolls\/([^/]+)\/push$/.exec(request.path);
  if (!action && !push) return request;
  const url = `/characters/${(action ?? push)![1]}/physical-rolls`;
  const body = action
    ? {
        ...request.body,
        kind: "executeAction",
        actionId: decodeURIComponent(action[2]!),
        inputs: request.body.inputs ?? {},
      }
    : { ...request.body, kind: "pushRoll", parentRollId: decodeURIComponent(push![2]!) };
  const { attempt, serverTime } = await client.fetch<{ attempt: PreparedThrow | null; serverTime: string }>(
    "POST",
    url,
    { body, signal },
  );
  if (!attempt) return request;
  try {
    const settlement = await simulate(attempt, serverClock(serverTime), signal);
    signal.throwIfAborted();
    return { ...request, physical: { path: `${url}/${attempt.attemptId}/complete`, settlement } };
  } catch (error) {
    if (signal.aborted) throw error;
    // A throw that cannot settle (a die stays cocked after its rethrows) or a
    // failed worker falls back to the ordinary server roll for the whole
    // action. The prepared attempt is never completed and expires.
    return request;
  }
}

export function canSimulateDice() {
  return typeof Worker !== "undefined" && typeof WebAssembly !== "undefined";
}
