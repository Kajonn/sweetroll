import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
import { Button, FormField, Panel, Select } from "../ui/index.js";
import { Disclosure } from "../ui/Disclosure.js";
import type { CampaignsApi } from "./api.js";
import { useFogEditor, MAX_FOG_DABS, type FogEditor, type FogMode } from "./useFogEditor.js";
type Props = {
  api: Pick<CampaignsApi,"applyFogEdit">; sceneId: string; sceneRevision: number;
  online?: boolean | undefined; disabled?: boolean | undefined;
  onChanged?: (()=>void | number | Promise<void | number>) | undefined;
  editor?: FogEditor | undefined; onPaint?: (()=>void) | undefined;
};
export function FogToolbarView(props: Props) {
  return <FogToolbarScope key={`${props.sceneId}:${props.online ?? true}`} {...props} />;
}
function FogToolbarScope(props: Props) {
  const local = useFogEditor(props), editor = props.editor ?? local, online = props.online ?? true;
  const [x,setX]=useState("0.5"), [y,setY]=useState("0.5"), [radius,setRadius]=useState(String(editor.radius));
  useEffect(()=>setRadius(String(editor.radius)),[editor.radius]);
  const radiusValid = radius.trim() !== "" && Number(radius)>0 && Number(radius)<=1 && Number.isFinite(Number(radius));
  const disabled = !online || Boolean(props.disabled) || editor.blocked;
  const addDab=()=> { const a=Number(x),b=Number(y); if (!disabled && radiusValid && x.trim() && y.trim() && Number.isFinite(a) && Number.isFinite(b) && a>=0 && a<=1 && b>=0 && b<=1) editor.addStroke([{x:a,y:b,r:editor.radius}]); };
  return <Panel title={t("campaign.detail.scenes.fog.title")}>
    <Select label={t("campaign.detail.scenes.fog.modeLabel")} value={editor.mode} disabled={disabled || editor.draft.length>0} onChange={e=>editor.setMode(e.target.value as FogMode)} options={[{value:"reveal",label:t("campaign.detail.scenes.fog.mode.reveal")},{value:"conceal",label:t("campaign.detail.scenes.fog.mode.conceal")}]} />
    <FormField label={t("campaign.detail.scenes.fog.radiusLabel")}><input type="number" min={.01} max={1} step={.01} value={radius} aria-invalid={!radiusValid} disabled={disabled} onChange={e=>{setRadius(e.target.value);editor.setRadius(Number(e.target.value));}}/></FormField>
    {props.onPaint ? <Button variant="secondary" disabled={disabled || !radiusValid || editor.draft.length>=MAX_FOG_DABS} onClick={props.onPaint}>{t("scene.fog.paintOnScene")}</Button> : null}
    <Disclosure label={t("scene.fog.precision")}>
      <FormField label={t("campaign.detail.scenes.fog.xLabel")}><input type="number" min={0} max={1} step={.01} value={x} disabled={disabled} onChange={e=>setX(e.target.value)}/></FormField>
      <FormField label={t("campaign.detail.scenes.fog.yLabel")}><input type="number" min={0} max={1} step={.01} value={y} disabled={disabled} onChange={e=>setY(e.target.value)}/></FormField>
      <Button variant="secondary" disabled={disabled || !radiusValid || editor.draft.length>=MAX_FOG_DABS} onClick={addDab}>{t("campaign.detail.scenes.fog.addDab")}</Button>
    </Disclosure>
    <Button variant="secondary" disabled={disabled || !editor.draft.length} onClick={editor.undo}>{t("campaign.detail.scenes.fog.undo")}</Button>{" "}
    {editor.draft.length ? <Button variant="secondary" disabled={disabled && editor.status!=="conflict"} onClick={editor.discard}>{t("scene.fog.discard")}</Button> : null}
    <p role="status">{t(editor.draft.length ? "campaign.detail.scenes.fog.strokeCount" : "campaign.detail.scenes.fog.strokeEmpty",{count:editor.draft.length})}</p>
    {editor.draft.length ? <p>{t("scene.fog.draftNotice")}</p> : null}
    {editor.draft.length>=MAX_FOG_DABS ? <p role="status">{t("scene.fog.limit")}</p> : null}
    {editor.status==="conflict" ? <p role="alert">{t(editor.refreshed ? "campaign.detail.scenes.fog.conflict" : "scene.fog.refresh")}</p> : null}
    {editor.status==="uncertain" ? <p role="alert">{t("scene.fog.uncertain")}</p> : null}
    {editor.status==="refresh" ? <p role="alert">{t("scene.fog.refresh")}</p> : null}
    {editor.status==="rejected" ? <><p role="alert">{t("scene.fog.rejected")}</p><Button disabled={!online} onClick={editor.reviewRejected}>{t("scene.fog.review")}</Button></> : null}
    {editor.status==="unavailable" ? <p role="alert">{t("campaign.detail.scenes.fog.unavailable")}</p> : null}
    {editor.status==="applied" ? <p role="status">{t("campaign.detail.scenes.fog.committed")}</p> : null}
    {!online ? <p role="status">{t("campaign.detail.scenes.offline")}</p> : null}
    {["conflict","uncertain","refresh"].includes(editor.status) ? <Button pending={editor.status==="pending"} disabled={!online || Boolean(props.disabled)} onClick={()=>void editor.retry()}>{t(editor.status==="conflict"&&editor.refreshed ? "campaign.detail.scenes.fog.retry" : "scene.fog.recover")}</Button> : <Button variant="primary" pending={editor.status==="pending"} pendingText={t("campaign.detail.scenes.fog.committing")} disabled={disabled || !editor.draft.length} onClick={()=>void editor.commit()}>{t("campaign.detail.scenes.fog.commit")}</Button>}
  </Panel>;
}
