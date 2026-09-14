// GM token tray: owns the place form plus one move form per token.
// Coordinates are numeric inputs with arrow nudge buttons (the keyboard
// alternatives to dragging). Commits mint fresh idempotency keys; 409
// re-reads first and offers an explicit retry, never revision guessing.
import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button, Checkbox, FormField, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import type { SceneView } from "./types.js";

type Token = SceneView["tokens"][number];

function isConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 409 || record.code === "conflict";
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

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
  api: Pick<CampaignsApi, "moveToken">;
  sceneId: string;
  sceneRevision: number;
  token: Token;
  online: boolean;
  onChanged: (() => void) | undefined;
  onUnavailable: () => void;
}) {
  const [x, setX] = useState(formatUnit(props.token.x));
  const [y, setY] = useState(formatUnit(props.token.y));
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

  const nudge = (dx: number, dy: number): void => {
    const currentX = parseUnit(x) ?? props.token.x;
    const currentY = parseUnit(y) ?? props.token.y;
    setX(formatUnit(clampUnit(currentX + dx)));
    setY(formatUnit(clampUnit(currentY + dy)));
    setMoved(false);
  };

  const move = async (): Promise<void> => {
    const targetX = parseUnit(x);
    const targetY = parseUnit(y);
    if (pending || targetX === null || targetY === null) return;
    setPending(true);
    setError(null);
    setConflict(false);
    setMoved(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.moveToken(props.sceneId, props.token.tokenId, {
        expectedSceneRevision: props.sceneRevision,
        x: targetX,
        y: targetY,
        idempotencyKey,
      });
      setMoved(true);
      props.onChanged?.();
    } catch (cause) {
      if (isNotFound(cause)) {
        props.onUnavailable();
      } else if (isConflict(cause)) {
        // 409 → re-read first, then offer an explicit retry with a fresh
        // key. Never revision guessing.
        setConflict(true);
        props.onChanged?.();
      } else {
        setError(t("campaign.detail.scenes.tokens.error"));
      }
    } finally {
      setPending(false);
    }
  };

  const moveLabel = t("campaign.detail.scenes.tokens.move", { label: props.token.label });
  return (
    <div role="group" aria-label={t("campaign.detail.scenes.tokens.coordinates", { label: props.token.label })}>
      <FormField label={t("campaign.detail.scenes.tokens.rowXLabel", { label: props.token.label })}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={x}
          disabled={!props.online}
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
          disabled={!props.online}
          onChange={(event) => setY(event.target.value)}
        />
      </FormField>
      <div>
        <Button variant="secondary" disabled={!props.online} onClick={() => nudge(0, -NUDGE_STEP)}>
          {t("campaign.detail.scenes.tokens.nudgeUp", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={!props.online} onClick={() => nudge(0, NUDGE_STEP)}>
          {t("campaign.detail.scenes.tokens.nudgeDown", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={!props.online} onClick={() => nudge(-NUDGE_STEP, 0)}>
          {t("campaign.detail.scenes.tokens.nudgeLeft", { label: props.token.label })}
        </Button>{" "}
        <Button variant="secondary" disabled={!props.online} onClick={() => nudge(NUDGE_STEP, 0)}>
          {t("campaign.detail.scenes.tokens.nudgeRight", { label: props.token.label })}
        </Button>
      </div>
      {conflict ? <p role="alert">{t("campaign.detail.scenes.tokens.conflict")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {moved ? <p role="status">{t("campaign.detail.scenes.tokens.moved")}</p> : null}
      {conflict ? (
        <Button variant="primary" pending={pending} onClick={() => void move()}>
          {t("campaign.detail.scenes.tokens.retryMove", { label: props.token.label })}
        </Button>
      ) : (
        <Button
          variant="primary"
          pending={pending}
          pendingText={t("campaign.detail.scenes.tokens.moving")}
          disabled={!props.online}
          onClick={() => void move()}
        >
          {moveLabel}
        </Button>
      )}
    </div>
  );
}

export function TokenTrayView(props: {
  api: Pick<CampaignsApi, "placeToken" | "moveToken">;
  sceneId: string;
  sceneRevision: number;
  tokens: Token[];
  online?: boolean | undefined;
  onChanged?: (() => void) | undefined;
}) {
  const online = props.online ?? true;
  const [label, setLabel] = useState("");
  const [x, setX] = useState("0.5");
  const [y, setY] = useState("0.5");
  const [size, setSize] = useState("1");
  const [visible, setVisible] = useState(true);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState(false);

  const place = async (): Promise<void> => {
    const targetX = parseUnit(x);
    const targetY = parseUnit(y);
    const targetSize = Number(size);
    if (pending || label.trim() === "" || targetX === null || targetY === null || !Number.isFinite(targetSize)) return;
    setPending(true);
    setError(null);
    setConflict(false);
    setPlaced(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = crypto.randomUUID();
    try {
      await props.api.placeToken(props.sceneId, {
        expectedSceneRevision: props.sceneRevision,
        label: label.trim(),
        x: targetX,
        y: targetY,
        size: targetSize,
        visible,
        imageFileId: null,
        idempotencyKey,
      });
      setPlaced(true);
      props.onChanged?.();
    } catch (cause) {
      if (isNotFound(cause)) {
        setUnavailable(true);
      } else if (isConflict(cause)) {
        // 409 → re-read first, then offer an explicit retry with a fresh
        // key. Never revision guessing.
        setConflict(true);
        props.onChanged?.();
      } else {
        setError(t("campaign.detail.scenes.tokens.error"));
      }
    } finally {
      setPending(false);
    }
  };

  const markUnavailable = (): void => setUnavailable(true);

  return (
    <Panel title={t("campaign.detail.scenes.tokens.title")}>
      <FormField label={t("campaign.detail.scenes.tokens.labelLabel")}>
        <input type="text" value={label} disabled={!online} onChange={(event) => setLabel(event.target.value)} />
      </FormField>
      <FormField label={t("campaign.detail.scenes.tokens.xLabel")}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={x}
          disabled={!online}
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
          disabled={!online}
          onChange={(event) => setY(event.target.value)}
        />
      </FormField>
      <FormField label={t("campaign.detail.scenes.tokens.sizeLabel")}>
        <input type="number" min={0.1} step={0.1} value={size} disabled={!online} onChange={(event) => setSize(event.target.value)} />
      </FormField>
      <Checkbox
        label={t("campaign.detail.scenes.tokens.visibleLabel")}
        checked={visible}
        disabled={!online}
        onChange={(event) => setVisible(event.target.checked)}
      />
      {conflict ? <p role="alert">{t("campaign.detail.scenes.tokens.conflict")}</p> : null}
      {unavailable ? <p role="alert">{t("campaign.detail.scenes.tokens.unavailable")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {placed ? <p role="status">{t("campaign.detail.scenes.tokens.placed")}</p> : null}
      {!online ? <p role="status">{t("campaign.detail.scenes.offline")}</p> : null}
      {conflict ? (
        <Button variant="primary" pending={pending} onClick={() => void place()}>
          {t("campaign.detail.scenes.tokens.retryPlace")}
        </Button>
      ) : (
        <Button
          variant="primary"
          pending={pending}
          pendingText={t("campaign.detail.scenes.tokens.placing")}
          disabled={!online || label.trim() === ""}
          onClick={() => void place()}
        >
          {t("campaign.detail.scenes.tokens.place")}
        </Button>
      )}
      {props.tokens.length === 0 ? (
        <p role="status">{t("campaign.detail.scenes.tokens.empty")}</p>
      ) : (
        <ul aria-label={t("campaign.detail.scenes.tokens.listLabel")}>
          {props.tokens.map((token) => (
            <li key={token.tokenId}>
              <TokenMoveRow
                api={props.api}
                sceneId={props.sceneId}
                sceneRevision={props.sceneRevision}
                token={token}
                online={online}
                onChanged={props.onChanged}
                onUnavailable={markUnavailable}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
