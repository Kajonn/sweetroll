import { useEffect, useRef, useState } from "react";
import type { CampaignsApi } from "./api.js";
import type { MoveTokenBody, PlaceTokenBody } from "./types.js";
import { randomUUID } from "../utils/uuid.js";

export type Point = { x: number; y: number };
export type TokenMode = "move" | "place" | "pan";
type Operation = { kind: "place"; body: PlaceTokenBody } | { kind: "move"; tokenId: string; label: string; body: MoveTokenBody };
type State = { status: "idle" | "pending" | "applied" | "conflict" | "uncertain" | "refresh" | "unavailable"; operation?: Operation; refreshed?: boolean };
export type TokenCommands = ReturnType<typeof useTokenCommands>;

/** One in-flight token command across gestures and precision forms. Uncertain
 * responses retain the exact body/key; a confirmed 409 requires a fresh read
 * and explicit retry. No gesture queue or revision arithmetic. */
export function useTokenCommands(props: {
  api: Pick<CampaignsApi, "placeToken" | "moveToken">;
  sceneId: string;
  sceneRevision: number;
  online?: boolean | undefined;
  onChanged?: (() => void | number | Promise<void | number>) | undefined;
}) {
  const latest = useRef(props); latest.current = props;
  const active = useRef(true), lock = useRef(false), stateRef = useRef<State>({ status: "idle" });
  const [state, setState] = useState<State>(stateRef.current);
  const update = (next: State) => { if (active.current) { stateRef.current = next; setState(next); } };
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const refresh = async () => latest.current.onChanged?.();
  const send = async (operation: Operation) => {
    if (lock.current || !active.current || latest.current.online === false) return;
    lock.current = true; update({ status: "pending", operation });
    let committed = false;
    try {
      if (operation.kind === "place") await latest.current.api.placeToken(latest.current.sceneId, operation.body);
      else await latest.current.api.moveToken(latest.current.sceneId, operation.tokenId, operation.body);
      committed = true;
      if (!active.current) return;
      await refresh();
      update({ status: "applied", operation });
    } catch (cause) {
      if (!active.current) return;
      const e = cause as { status?: number; code?: string } | null;
      if ([401, 403, 404].includes(e?.status ?? 0) || e?.code === "not_found") update({ status: "unavailable" });
      else if (!committed && (e?.status === 409 || e?.code === "conflict")) {
        update({ status: "conflict", operation, refreshed: false });
        try { await refresh(); update({ status: "conflict", operation, refreshed: true }); }
        catch { /* Retry must first complete the read. */ }
      } else update({ status: committed ? "refresh" : "uncertain", operation });
    } finally { lock.current = false; }
  };
  const available = () => !lock.current && latest.current.online !== false && ["idle", "applied"].includes(stateRef.current.status);
  return {
    ...state,
    blocked: props.online === false || !["idle", "applied"].includes(state.status),
    place: (draft: Omit<PlaceTokenBody, "expectedSceneRevision" | "idempotencyKey">) => {
      if (available()) void send({ kind: "place", body: { ...draft, expectedSceneRevision: latest.current.sceneRevision, idempotencyKey: randomUUID() } });
    },
    move: (tokenId: string, label: string, point: Point) => {
      if (available()) void send({ kind: "move", tokenId, label, body: { ...point, expectedSceneRevision: latest.current.sceneRevision, idempotencyKey: randomUUID() } });
    },
    retry: async () => {
      const current = stateRef.current;
      if (lock.current || latest.current.online === false || !current.operation) return;
      if (current.status === "refresh" || (current.status === "conflict" && !current.refreshed)) {
        lock.current = true;
        try { await refresh(); update(current.status === "refresh" ? { status: "applied", operation: current.operation } : { ...current, refreshed: true }); }
        catch { /* Keep explicit read recovery. */ }
        finally { lock.current = false; }
      } else if (current.status === "uncertain") await send(current.operation);
      else if (current.status === "conflict") {
        const revision = latest.current.sceneRevision;
        const operation = current.operation;
        await send(operation.kind === "place"
          ? { ...operation, body: { ...operation.body, expectedSceneRevision: revision, idempotencyKey: randomUUID() } }
          : { ...operation, body: { ...operation.body, expectedSceneRevision: revision, idempotencyKey: randomUUID() } });
      }
    },
    discard: () => { if (!lock.current && stateRef.current.status === "conflict") update({ status: "idle" }); },
  };
}
