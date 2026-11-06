import { useEffect, useRef, useState } from "react";
import type { CampaignsApi } from "./api.js";
import type { ApplyFogEditBody } from "./types.js";
import { randomUUID } from "../utils/uuid.js";
export type FogMode = "reveal" | "conceal";
export type FogDab = { x: number; y: number; r: number };
export const MAX_FOG_DABS = 512;
type Status = "idle" | "pending" | "applied" | "conflict" | "uncertain" | "refresh" | "rejected" | "unavailable";
export type FogEditor = ReturnType<typeof useFogEditor>;
const valid = (d: FogDab) => [d.x,d.y,d.r].every(Number.isFinite) && d.x >= 0 && d.x <= 1 && d.y >= 0 && d.y <= 1 && d.r > 0 && d.r <= 1;

/** One bounded local draft and one frozen command. Unknown outcomes retry the
 * exact request; conflicts require a read and explicit fresh-key retry. */
export function useFogEditor(props: {
  api: Pick<CampaignsApi, "applyFogEdit">; sceneId: string; sceneRevision: number;
  online?: boolean | undefined; enabled?: boolean | undefined;
  onChanged?: (() => void | number | Promise<void | number>) | undefined;
}) {
  const latest = useRef(props); latest.current = props;
  const active = useRef(true), lock = useRef(false), statusRef = useRef<Status>("idle");
  const draftRevision = useRef<number | null>(null);
  const strokesRef = useRef<FogDab[][]>([]), modeRef = useRef<FogMode>("reveal"), attempt = useRef<ApplyFogEditBody | null>(null);
  const [strokes,setStrokes] = useState<FogDab[][]>([]), [mode,setMode] = useState<FogMode>("reveal"), [radius,setRadius] = useState(.1);
  const [status,setStatus] = useState<Status>("idle"), [refreshed,setRefreshed] = useState(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const transition = (next: Status) => { if (active.current) { statusRef.current = next; setStatus(next); } };
  const update = (next: FogDab[][]) => { if (active.current) { strokesRef.current = next; if (!next.length) draftRevision.current = null; setStrokes(next); } };
  const canEdit = () => active.current && !lock.current && latest.current.online !== false && latest.current.enabled !== false && ["idle","applied"].includes(statusRef.current);
  async function refresh() { await latest.current.onChanged?.(); }
  async function send(body: ApplyFogEditBody) {
    if (lock.current || !active.current || latest.current.online === false || latest.current.enabled === false) return;
    lock.current = true; attempt.current = body; transition("pending"); let applied = false;
    try {
      await latest.current.api.applyFogEdit(latest.current.sceneId, body); applied = true;
      if (!active.current) return;
      await refresh(); update([]); attempt.current = null; transition("applied");
    } catch (cause) {
      if (!active.current) return;
      const e = cause as { status?: number; code?: string } | null;
      if ([401,403,404].includes(e?.status ?? 0) || e?.code === "not_found") { update([]); attempt.current = null; transition("unavailable"); }
      else if (!applied && (e?.status === 409 || e?.code === "conflict")) {
        setRefreshed(false); transition("conflict");
        try { await refresh(); if (active.current) setRefreshed(true); } catch { /* Explicit read recovery before retry. */ }
      } else transition(applied ? "refresh" : [400,422].includes(e?.status ?? 0) ? "rejected" : "uncertain");
    } finally { lock.current = false; }
  }
  const draft = strokes.flat();
  return {
    mode, radius, draft, status, refreshed,
    blocked: props.online === false || props.enabled === false || !["idle","applied"].includes(status),
    setMode(next: FogMode) { if (canEdit() && strokesRef.current.length === 0) { modeRef.current = next; setMode(next); } },
    setRadius(next: number) { if (canEdit() && Number.isFinite(next) && next > 0 && next <= 1) setRadius(next); },
    addStroke(dabs: FogDab[]) {
      if (!canEdit() || !dabs.length || !dabs.every(valid)) return;
      const remaining = MAX_FOG_DABS - strokesRef.current.flat().length;
      if (remaining <= 0) return;
      if (!strokesRef.current.length) draftRevision.current = latest.current.sceneRevision;
      update([...strokesRef.current, dabs.slice(0,remaining).map(d => ({...d}))]); transition("idle");
    },
    undo() { if (canEdit()) { update(strokesRef.current.slice(0,-1)); transition("idle"); } },
    discard() { if (canEdit() || (!lock.current && statusRef.current === "conflict")) { update([]); attempt.current = null; transition("idle"); } },
    reviewRejected() { if (!lock.current && statusRef.current === "rejected") { attempt.current = null; transition("idle"); } },
    async commit() { if (canEdit() && strokesRef.current.length) await send({ expectedSceneRevision: draftRevision.current ?? latest.current.sceneRevision, idempotencyKey: randomUUID(), op: { mode: modeRef.current, runs: strokesRef.current.flat().map(d=>({...d})) } }); },
    async retry() {
      if (lock.current || latest.current.online === false || latest.current.enabled === false || !attempt.current) return;
      if (statusRef.current === "refresh" || (statusRef.current === "conflict" && !refreshed)) {
        const saved = statusRef.current === "refresh"; lock.current = true;
        try { await refresh(); if (active.current) { if (saved) { update([]); attempt.current = null; transition("applied"); } else setRefreshed(true); } }
        catch { /* Keep draft and recovery controls. */ } finally { lock.current = false; }
      } else if (statusRef.current === "uncertain") await send(attempt.current);
      else if (statusRef.current === "conflict") await send({ ...attempt.current, expectedSceneRevision: latest.current.sceneRevision, idempotencyKey: randomUUID() });
    },
  };
}
