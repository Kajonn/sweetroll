import { useId } from "react";
import { t } from "../i18n/index.js";
import type { SceneView } from "./types.js";
import type { FogDab, FogMode } from "./useFogEditor.js";
import type { Point } from "./useTokenCommands.js";
// GM-only inspection overlay. Restricted displays continue using server-redacted
// bytes; no display route consumes this component or the campaign original.
export function SceneFogOverlay({ fog, draft, active, mode, radius, cursor }: {
  fog: SceneView["fog"]; draft: FogDab[]; active: FogDab[]; mode: FogMode; radius: number; cursor: Point | null;
}) {
  const id = useId().replaceAll(":", "");
  return <svg role="img" aria-label={t("scene.fog.overlay")} viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position:"absolute", inset:0, width:"100%", height:"100%", pointerEvents:"none" }}>
    <defs><mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="1" height="1" data-testid="fog-committed-mask">
      <rect width="1" height="1" fill="white" />
      {fog.flatMap((op,i)=>op.runs.map((d,j)=><circle key={`${i}:${j}`} cx={d.x} cy={d.y} r={d.r} fill={op.mode==="reveal"?"black":"white"}/>))}
    </mask></defs>
    <rect width="1" height="1" fill="#102329" fillOpacity="0.5" mask={`url(#${id})`}/>
    <g data-testid="fog-draft-overlay" data-mode={mode} fill={mode==="reveal"?"#60d9b5":"#eab366"} fillOpacity="0.24" stroke={mode==="reveal"?"#b8ffe8":"#ffda9c"} strokeWidth="1" strokeDasharray="4 3">
      {draft.map((d,i)=><circle key={i} cx={d.x} cy={d.y} r={d.r} vectorEffect="non-scaling-stroke"/>)}
    </g>
    {active.length ? <g data-testid="fog-stroke-preview" fill={mode==="reveal"?"#60d9b5":"#eab366"} fillOpacity="0.4">{active.map((d,i)=><circle key={i} cx={d.x} cy={d.y} r={d.r}/>)}</g> : null}
    {cursor ? <circle data-testid="fog-brush-radius" cx={cursor.x} cy={cursor.y} r={radius} fill="none" stroke="white" strokeWidth="2" strokeDasharray="5 3" vectorEffect="non-scaling-stroke"/> : null}
  </svg>;
}
