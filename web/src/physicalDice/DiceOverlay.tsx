import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type MutableRefObject } from "react";
import { createPortal } from "react-dom";
import type { ApiClient } from "../api/client.js";
import type { RollStarted, RollFinished } from "../../../src/campaigns/physical-dice-stream.js";
import { simulationVersion } from "../../../src/systems/physical-dice/launch.js";
import type { PoseBuffer } from "./DiceCanvas.js";
import { canSimulateDice, type SimulateDice } from "./commands.js";
import { playThrow, serverClock } from "./playback.js";
import { useDicePreferences } from "./preferences.js";

const DiceCanvas = lazy(() => import("./DiceCanvas.js"));
const motionQuery = "(prefers-reduced-motion: reduce)";
function shouldAnimate() {
  return canSimulateDice() && !window.matchMedia?.(motionQuery).matches && !document.hidden;
}
function subscribeMotion(update: () => void) {
  const query = window.matchMedia?.(motionQuery);
  query?.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    query?.removeEventListener("change", update);
    document.removeEventListener("visibilitychange", update);
  };
}
type Display = { roll: Pick<RollStarted, "attemptId" | "color" | "dice">; poses: PoseBuffer };
type Active = Display & {
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  completed: boolean;
};

export function DiceOverlay({
  client,
  actor,
  campaignId,
  localSimulation,
}: {
  client: ApiClient;
  actor: string;
  campaignId: string | null;
  localSimulation?: MutableRefObject<SimulateDice | undefined>;
}) {
  const { preferences } = useDicePreferences(client, actor);
  const motion = useSyncExternalStore(subscribeMotion, shouldAnimate, () => false);
  const [available, setAvailable] = useState(true);
  const [display, setDisplay] = useState<Display[]>([]);
  const unavailable = useCallback(() => setAvailable(false), []);
  const enabled = available && motion && preferences.data?.show_3d_dice === true;
  useLayoutEffect(() => {
    if (campaignId !== null || !localSimulation) return;
    let mounted = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const remove = (id: string) => {
      if (mounted) setDisplay(current => current.filter(item => item.roll.attemptId !== id));
    };
    localSimulation.current = async (roll, now, signal) => {
      signal.throwIfAborted();
      clearTimeout(timer);
      const poses: PoseBuffer = { previous: null, frame: null, updated: 0 };
      setDisplay([{ roll, poses }]);
      try {
        const settlement = await playThrow(roll, now, signal, (frame) => {
          poses.previous = poses.frame;
          poses.frame = frame;
          poses.updated = performance.now();
        });
        if (mounted) timer = setTimeout(() => remove(roll.attemptId), 1500);
        return settlement;
      } catch (error) {
        remove(roll.attemptId);
        throw error;
      }
    };
    return () => {
      mounted = false;
      clearTimeout(timer);
      localSimulation.current = undefined;
    };
  }, [campaignId, localSimulation]);
  useEffect(() => {
    if (!enabled || campaignId === null) return;
    const stream = new EventSource(`/api/campaigns/${encodeURIComponent(campaignId)}/physical-rolls/events`);
    const active = new Map<string, Active>();
    // Don't replay a throw we've already seen after reconnect. A pending
    // throw never outlives the attempt's deadline.
    const seen = new Map<string, number>();
    const render = () => setDisplay([...active.values()]);
    function remove(id: string) {
      const item = active.get(id);
      if (!item) return;
      item.controller.abort();
      clearTimeout(item.timer);
      active.delete(id);
      render();
    }
    function clear() {
      for (const id of active.keys()) remove(id);
    }
    function start({ data }: MessageEvent<string>) {
      const roll = JSON.parse(data) as RollStarted;
      const now = serverClock(roll.serverTime);
      for (const [id, expires] of seen) if (expires <= now()) seen.delete(id);
      if (
        roll.launch.version !== simulationVersion ||
        Date.parse(roll.expiresAt) <= now() ||
        seen.has(roll.attemptId) ||
        active.size >= 2
      )
        return;
      seen.set(roll.attemptId, Date.parse(roll.expiresAt));
      const controller = new AbortController();
      const item: Active = {
        roll,
        poses: { frame: null, previous: null, updated: 0 },
        controller,
        completed: false,
      };
      active.set(roll.attemptId, item);
      item.timer = setTimeout(() => remove(roll.attemptId), Math.max(0, Date.parse(roll.expiresAt) - now()));
      render();
      void playThrow(roll, now, controller.signal, (frame) => {
        item.poses.previous = item.poses.frame;
        item.poses.frame = frame;
        item.poses.updated = performance.now();
      }).catch(() => {
        if (!controller.signal.aborted) remove(roll.attemptId);
      });
    }
    function finish({ data }: MessageEvent<string>) {
      const final = JSON.parse(data) as RollFinished;
      const item = active.get(final.attemptId);
      if (!item || item.completed) return;
      item.completed = true;
      item.controller.abort();
      // The accepted poses also repair a divergent or lagging simulation.
      item.poses.previous = null;
      item.poses.frame = { tick: final.tick, dice: final.dice, status: "settled" };
      clearTimeout(item.timer);
      item.timer = setTimeout(() => remove(final.attemptId), 1500);
    }
    function revoked() {
      stream.close();
      clear();
    }
    stream.addEventListener("roll.started", start);
    stream.addEventListener("roll.finished", finish);
    stream.addEventListener("roll.removed", ({ data }: MessageEvent<string>) =>
      remove((JSON.parse(data) as { attemptId: string }).attemptId),
    );
    stream.addEventListener("revoked", revoked);
    // A connection interruption can coincide with a membership change.
    // Clear the old visuals and allow a fresh authorized snapshot.
    stream.onerror = () => {
      for (const id of active.keys()) if (!active.get(id)?.completed) seen.delete(id);
      clear();
    };
    return () => {
      stream.close();
      clear();
    };
  }, [campaignId, enabled]);
  if (!enabled || !display.length) return null;
  return createPortal(
    <Suspense fallback={null}>
      {display.map((item) => (
        <DiceCanvas
          key={item.roll.attemptId}
          roll={item.roll}
          poses={item.poses}
          onUnavailable={unavailable}
        />
      ))}
    </Suspense>,
    document.body,
  );
}
