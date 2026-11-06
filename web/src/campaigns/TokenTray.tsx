import { SceneLibrary } from "./SceneLibrary.js";
import { Disclosure } from "../ui/Disclosure.js";
// GM token tray: placement and precision forms share the gesture command owner.
// The committing keyboard alternative to dragging is the numeric X/Y
// inputs plus the Move button (nudge buttons only stage coordinates).
// Unknown outcomes retain the exact request; confirmed conflicts require a read and explicit retry.
import { useEffect, useState } from "react";
import { useTokenCommands, type TokenCommands } from "./useTokenCommands.js";

import { t } from "../i18n/index.js";
import { Button, Checkbox, FormField, Panel } from "../ui/index.js";
import type { CampaignsApi, SceneLibraryApi } from "./api.js";
import type { SceneView } from "./types.js";

type Token = SceneView["tokens"][number];

function parseUnit(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function formatUnit(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

const NUDGE_STEP = 0.01;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

function TokenMoveRow(props: {
  commands: TokenCommands;
  token: Token;
  online: boolean;
}) {
  const [x, setX] = useState(formatUnit(props.token.x));
  const [y, setY] = useState(formatUnit(props.token.y));
  useEffect(() => { setX(formatUnit(props.token.x)); setY(formatUnit(props.token.y)); }, [props.token.x, props.token.y]);
  const disabled = !props.online || props.commands.blocked;
  const nudge = (dx: number, dy: number): void => {
    const currentX = parseUnit(x) ?? props.token.x;
    const currentY = parseUnit(y) ?? props.token.y;
    setX(formatUnit(clampUnit(currentX + dx)));
    setY(formatUnit(clampUnit(currentY + dy)));
  };

  const move = (): void => {
    const targetX = parseUnit(x), targetY = parseUnit(y);
    if (disabled || targetX === null || targetY === null) return;
    props.commands.move(props.token.tokenId, props.token.label, { x: targetX, y: targetY });
  };

  const moveLabel = t("campaign.detail.scenes.tokens.move", { label: props.token.label });
  return (
    <div role="group" aria-label={t("campaign.detail.scenes.tokens.coordinates", { label: props.token.label })}>
      <Disclosure label={t("disclosure.tokenPosition", { label: props.token.label })}>
      <FormField label={t("campaign.detail.scenes.tokens.rowXLabel", { label: props.token.label })}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={x}
          disabled={disabled}
          onChange={(event) => setX(event.target.value)}
        />
      </FormField>
      <FormField label={t("campaign.detail.scenes.tokens.rowYLabel", { label: props.token.label })}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={y}
          disabled={disabled}
          onChange={(event) => setY(event.target.value)}
        />
      </FormField>
      <div>
        <Button variant="secondary" disabled={disabled} onClick={() => nudge(0, -NUDGE_STEP)}>
          {t("campaign.detail.scenes.tokens.nudgeUp", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={disabled} onClick={() => nudge(0, NUDGE_STEP)}>
          {t("campaign.detail.scenes.tokens.nudgeDown", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={disabled} onClick={() => nudge(-NUDGE_STEP, 0)}>
          {t("campaign.detail.scenes.tokens.nudgeLeft", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={disabled} onClick={() => nudge(NUDGE_STEP, 0)}>
          {t("campaign.detail.scenes.tokens.nudgeRight", { label: props.token.label })}
        </Button>
      </div>
      </Disclosure>
      <Button variant="primary" disabled={disabled} onClick={move}>{moveLabel}</Button>
    </div>
  );
}

export function TokenTrayView(props: {
  api: Pick<CampaignsApi, "placeToken" | "moveToken">;
  mediaApi?: SceneLibraryApi | undefined;
  campaignId?: string | undefined;
  actorId?: string | null | undefined;
  generation?: number | undefined;
  sceneId: string;
  sceneRevision: number;
  tokens: Token[];
  online?: boolean | undefined;
  onChanged?: (() => void | number | Promise<void | number>) | undefined;
  commands?: TokenCommands | undefined;
  onPlaceOnScene?: ((draft: { label: string; size: number; visible: boolean; imageFileId: string | null }) => void) | undefined;
}) {
  const online = props.online ?? true;
  const [label, setLabel] = useState("");
  const [x, setX] = useState("0.5");
  const [y, setY] = useState("0.5");
  const [size, setSize] = useState("0.1");
  const [imageFileId, setImageFileId] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);
  const localCommands = useTokenCommands(props);
  const commands = props.commands ?? localCommands;
  const pending = commands.status === "pending", unavailable = commands.status === "unavailable";
  const disabled = !online || commands.blocked;
  const draft = () => ({ label: label.trim(), size: Number(size), visible, imageFileId });
  const valid = label.trim() !== "" && Number(size) > 0 && Number(size) <= 1 && Number.isFinite(Number(size));
  const place = (): void => {
    const targetX = parseUnit(x), targetY = parseUnit(y);
    if (!disabled && valid && targetX !== null && targetY !== null) commands.place({ ...draft(), x: targetX, y: targetY });
  };
  return (
    <Panel title={t("campaign.detail.scenes.tokens.title")}>
      <FormField label={t("campaign.detail.scenes.tokens.labelLabel")}>
        <input type="text" value={label} disabled={disabled} onChange={(event) => setLabel(event.target.value)} />
      </FormField>
      {props.mediaApi && props.campaignId ? <>
        <p>{t(imageFileId ? "scene.tokens.selected" : "scene.tokens.labelOnly")}</p>
        {imageFileId ? <Button variant="secondary" disabled={disabled} onClick={() => setImageFileId(null)}>{t("scene.tokens.clear")}</Button> : null}
        <Disclosure label={t("scene.tokens.artwork")}>
          <SceneLibrary api={props.mediaApi} campaignId={props.campaignId} actorId={props.actorId ?? null} generation={props.generation ?? 0} online={!disabled} selection={{ fileId: imageFileId, onSelect: fileId => setImageFileId(fileId || null) }} onChanged={() => {}} onOpenScene={() => {}} />
        </Disclosure>
      </> : null}
      <Disclosure label={t("disclosure.position")}>
      <FormField label={t("campaign.detail.scenes.tokens.xLabel")}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={x}
          disabled={disabled}
          onChange={(event) => setX(event.target.value)}
        />
      </FormField>
      <FormField label={t("campaign.detail.scenes.tokens.yLabel")}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={y}
          disabled={disabled}
          onChange={(event) => setY(event.target.value)}
        />
      </FormField>
      <FormField label={t("campaign.detail.scenes.tokens.sizeLabel")}>
        <input type="number" min={0.01} max={1} step={0.01} value={size} disabled={disabled} onChange={(event) => setSize(event.target.value)} />
      </FormField>
      </Disclosure>
      <Checkbox
        label={t("campaign.detail.scenes.tokens.visibleLabel")}
        checked={visible}
        disabled={disabled}
        onChange={(event) => setVisible(event.target.checked)}
      />
      <TokenCommandFeedback commands={commands} online={online} />
      {!online ? <p role="status">{t("campaign.detail.scenes.offline")}</p> : null}
      {props.onPlaceOnScene ? <Button variant="secondary" disabled={disabled || !valid} onClick={() => props.onPlaceOnScene?.(draft())}>{t("scene.gestures.place")}</Button> : null}
      <Button variant="primary" pending={pending} pendingText={t("campaign.detail.scenes.tokens.placing")} disabled={disabled || !valid} onClick={place}>{t("campaign.detail.scenes.tokens.place")}</Button>
      {props.tokens.length === 0 ? (
        <p role="status">{t("campaign.detail.scenes.tokens.empty")}</p>
      ) : (
        <ul aria-label={t("campaign.detail.scenes.tokens.listLabel")}>
          {props.tokens.map((token) => (
            <li key={token.tokenId}>
              <TokenMoveRow
                commands={commands}
                token={token}
                online={online && !unavailable}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function TokenCommandFeedback({ commands, online }: { commands: TokenCommands; online: boolean }) {
  const op = commands.operation;
  const retryLabel = commands.status === "conflict" && commands.refreshed ? op?.kind === "move" ? t("campaign.detail.scenes.tokens.retryMove", { label: op.label }) : t("campaign.detail.scenes.tokens.retryPlace") : t("scene.gestures.retry");
  return <>
    {commands.status === "pending" ? <p role="status">{t("scene.gestures.saving")}</p> : null}
    {commands.status === "applied" ? <p role="status">{t(op?.kind === "place" ? "campaign.detail.scenes.tokens.placed" : "campaign.detail.scenes.tokens.moved")}</p> : null}
    {commands.status === "conflict" ? <p role="alert">{t(commands.refreshed ? "campaign.detail.scenes.tokens.conflict" : "scene.gestures.refresh")}</p> : null}
    {commands.status === "uncertain" || commands.status === "refresh" ? <p role="alert">{t(commands.status === "uncertain" ? "scene.gestures.uncertain" : "scene.gestures.refresh")}</p> : null}
    {commands.status === "unavailable" ? <p role="alert">{t("campaign.detail.scenes.tokens.unavailable")}</p> : null}
    {["conflict", "uncertain", "refresh"].includes(commands.status) ? <Button disabled={!online} onClick={() => void commands.retry()}>{retryLabel}</Button> : null}
    {commands.status === "conflict" ? <Button variant="secondary" onClick={commands.discard}>{t("scene.gestures.discard")}</Button> : null}
  </>;
}
