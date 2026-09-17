// GM fog toolbar: owns the uncommitted stroke (mode + dabs entered through
// numeric inputs, the keyboard alternative to painting) with undo + commit
// dispatch. Commits mint a fresh idempotency key; 409 re-reads first and
// offers an explicit retry, never revision guessing.
import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button, FormField, Panel, Select } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { randomUUID } from "../utils/uuid";

type FogMode = "reveal" | "conceal";

type Dab = { x: number; y: number; r: number };

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

export function FogToolbarView(props: {
  api: Pick<CampaignsApi, "applyFogEdit">;
  sceneId: string;
  sceneRevision: number;
  online?: boolean | undefined;
  onChanged?: (() => void) | undefined;
}) {
  const online = props.online ?? true;
  const [mode, setMode] = useState<FogMode>("reveal");
  const [x, setX] = useState("0.5");
  const [y, setY] = useState("0.5");
  const [radius, setRadius] = useState("0.1");
  const [stroke, setStroke] = useState<Dab[]>([]);
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState(false);

  const addDab = (): void => {
    const dabX = parseUnit(x);
    const dabY = parseUnit(y);
    const dabR = parseUnit(radius);
    if (dabX === null || dabY === null || dabR === null) return;
    setStroke((current) => [...current, { x: dabX, y: dabY, r: dabR }]);
    setCommitted(false);
  };

  const commit = async (): Promise<void> => {
    if (pending || stroke.length === 0) return;
    setPending(true);
    setError(null);
    setConflict(false);
    setCommitted(false);
    // Caller-minted idempotency key, fresh on every attempt.
    const idempotencyKey = randomUUID();
    try {
      await props.api.applyFogEdit(props.sceneId, {
        expectedSceneRevision: props.sceneRevision,
        op: { mode, runs: stroke },
        idempotencyKey,
      });
      setStroke([]);
      setCommitted(true);
      props.onChanged?.();
    } catch (cause) {
      if (isNotFound(cause)) {
        setUnavailable(true);
      } else if (isConflict(cause)) {
        // 409 → re-read first (the stroke is kept), then offer an explicit
        // retry with a fresh key. Never revision guessing.
        setConflict(true);
        props.onChanged?.();
      } else {
        setError(t("campaign.detail.scenes.fog.error"));
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel title={t("campaign.detail.scenes.fog.title")}>
      <Select
        label={t("campaign.detail.scenes.fog.modeLabel")}
        value={mode}
        onChange={(event) => setMode(event.target.value as FogMode)}
        options={[
          { value: "reveal", label: t("campaign.detail.scenes.fog.mode.reveal") },
          { value: "conceal", label: t("campaign.detail.scenes.fog.mode.conceal") },
        ]}
      />
      <FormField label={t("campaign.detail.scenes.fog.xLabel")}>
        <input type="number" min={0} max={1} step={0.01} value={x} onChange={(event) => setX(event.target.value)} />
      </FormField>
      <FormField label={t("campaign.detail.scenes.fog.yLabel")}>
        <input type="number" min={0} max={1} step={0.01} value={y} onChange={(event) => setY(event.target.value)} />
      </FormField>
      <FormField label={t("campaign.detail.scenes.fog.radiusLabel")}>
        <input
          type="number"
          min={0}
          max={1}
          step={0.01}
          value={radius}
          onChange={(event) => setRadius(event.target.value)}
        />
      </FormField>
      <Button variant="secondary" disabled={!online} onClick={addDab}>
        {t("campaign.detail.scenes.fog.addDab")}
      </Button>{" "}
      <Button
        variant="secondary"
        disabled={stroke.length === 0}
        onClick={() => {
          setStroke([]);
          setCommitted(false);
        }}
      >
        {t("campaign.detail.scenes.fog.undo")}
      </Button>
      {stroke.length === 0 ? (
        <p role="status">{t("campaign.detail.scenes.fog.strokeEmpty")}</p>
      ) : (
        <p role="status">{t("campaign.detail.scenes.fog.strokeCount", { count: stroke.length })}</p>
      )}
      {conflict ? <p role="alert">{t("campaign.detail.scenes.fog.conflict")}</p> : null}
      {unavailable ? <p role="alert">{t("campaign.detail.scenes.fog.unavailable")}</p> : null}
      {error !== null ? <p role="alert">{error}</p> : null}
      {committed ? <p role="status">{t("campaign.detail.scenes.fog.committed")}</p> : null}
      {!online ? <p role="status">{t("campaign.detail.scenes.offline")}</p> : null}
      {conflict ? (
        <Button variant="primary" pending={pending} onClick={() => void commit()}>
          {t("campaign.detail.scenes.fog.retry")}
        </Button>
      ) : (
        <Button
          variant="primary"
          pending={pending}
          pendingText={t("campaign.detail.scenes.fog.committing")}
          disabled={!online || stroke.length === 0}
          onClick={() => void commit()}
        >
          {t("campaign.detail.scenes.fog.commit")}
        </Button>
      )}
    </Panel>
  );
}
