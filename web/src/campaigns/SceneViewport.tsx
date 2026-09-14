// GM scene viewport: normalized scene-space image with token markers, plus
// the GM scene route composition (viewport + fog toolbar + token tray).
// Positions are fractions of the scene extent; markers use percentage
// offsets so they track any rendered size. Zoom/pan expose button and
// keyboard (+/-/arrows) alternatives; token dragging alternatives live in
// TokenTray (numeric coordinates + nudge buttons).
import { useState } from "react";

import { t } from "../i18n/index.js";
import { Button, EmptyState, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { useScene } from "./campaignQueries.js";
import { FogToolbarView } from "./FogToolbar.js";
import { TokenTrayView } from "./TokenTray.js";
import type { SceneView } from "./types.js";

export type SceneViewportApi = Pick<
  CampaignsApi,
  "openScene" | "applyFogEdit" | "placeToken" | "moveToken"
>;

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
}

const ZOOM_STEP = 1.25;
const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const PAN_STEP = 10;

export function SceneViewportView(props: {
  scene: SceneView;
  imageUrl: string;
  selectedTokenId?: string | null | undefined;
  onSelectToken?: ((tokenId: string | null) => void) | undefined;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const selectedTokenId = props.selectedTokenId ?? null;

  const zoomIn = (): void => setZoom((current) => Math.min(ZOOM_MAX, current * ZOOM_STEP));
  const zoomOut = (): void => setZoom((current) => Math.max(ZOOM_MIN, current / ZOOM_STEP));
  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <Panel title={t("campaign.detail.scenes.title")}>
      <div>
        <Button variant="secondary" onClick={zoomOut} disabled={zoom <= ZOOM_MIN}>
          {t("campaign.detail.scenes.viewport.zoomOut")}
        </Button>{" "}
        <Button variant="secondary" onClick={zoomIn} disabled={zoom >= ZOOM_MAX}>
          {t("campaign.detail.scenes.viewport.zoomIn")}
        </Button>{" "}
        <Button variant="secondary" onClick={resetView}>
          {t("campaign.detail.scenes.viewport.resetView")}
        </Button>
      </div>
      <div
        role="region"
        aria-label={t("campaign.detail.scenes.viewport.regionLabel")}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "+" || event.key === "=") {
            event.preventDefault();
            zoomIn();
          } else if (event.key === "-" || event.key === "_") {
            event.preventDefault();
            zoomOut();
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            setPan((current) => ({ ...current, x: current.x + PAN_STEP }));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setPan((current) => ({ ...current, x: current.x - PAN_STEP }));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setPan((current) => ({ ...current, y: current.y + PAN_STEP }));
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setPan((current) => ({ ...current, y: current.y - PAN_STEP }));
          }
        }}
        style={{ position: "relative", overflow: "hidden" }}
      >
        <div data-testid="scene-zoom-layer" style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)` }}>
          <img
            src={props.imageUrl}
            alt={t("campaign.detail.scenes.viewport.imageAlt")}
            style={{ display: "block", width: "100%" }}
          />
          <ul aria-label={t("campaign.detail.scenes.viewport.tokensLabel")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {props.scene.tokens.map((token) => (
              <li
                key={token.tokenId}
                style={{
                  position: "absolute",
                  left: `${token.x * 100}%`,
                  top: `${token.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <button
                  type="button"
                  aria-label={t("campaign.detail.scenes.viewport.token", { label: token.label })}
                  aria-pressed={selectedTokenId === token.tokenId}
                  data-visible={token.visible ? "true" : "false"}
                  style={{ opacity: token.visible ? 1 : 0.5 }}
                  onClick={() => props.onSelectToken?.(token.tokenId)}
                >
                  {token.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Panel>
  );
}

export function CampaignSceneView(props: {
  api: SceneViewportApi;
  campaignId: string;
  sceneId: string;
  actorId: string | null;
  generation?: number | undefined;
  online?: boolean | undefined;
}) {
  const online = props.online ?? true;
  const generation = props.generation ?? 0;
  const sceneQuery = useScene(props.api as CampaignsApi, props.campaignId, props.sceneId, props.actorId, generation, {
    enabled: props.sceneId !== "" && online,
    online,
  });
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);

  if (!online) {
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        <EmptyState title={t("campaign.detail.scenes.offline")} />
      </section>
    );
  }

  if (props.sceneId === "") {
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        <EmptyState
          title={t("campaign.detail.scenes.empty.title")}
          description={t("campaign.detail.scenes.empty.description")}
        />
      </section>
    );
  }

  if (sceneQuery.status === "pending") {
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        <p role="status">{t("campaign.detail.scenes.loading")}</p>
      </section>
    );
  }

  if (sceneQuery.status === "error") {
    if (isNotFound(sceneQuery.error)) {
      // Server-driven gate: players (and revoked readers) get 404, so the
      // route shows unavailable instead of any scene content.
      return (
        <section aria-label={t("campaign.detail.scenes.title")}>
          <PageHeader title={t("campaign.detail.scenes.title")} />
          <EmptyState
            title={t("campaign.detail.scenes.unavailable.title")}
            description={t("campaign.detail.scenes.unavailable.description")}
          />
        </section>
      );
    }
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        <EmptyState
          title={t("campaign.detail.scenes.loadFailed")}
          action={
            <Button variant="primary" onClick={() => void sceneQuery.refetch()}>
              {t("campaign.detail.scenes.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  const scene = sceneQuery.data.scene;
  const imageUrl = `/api/campaigns/${props.campaignId}/images/${scene.backgroundFileId}/original`;
  const refetch = (): void => {
    void sceneQuery.refetch();
  };
  return (
    <section aria-label={t("campaign.detail.scenes.title")}>
      <PageHeader title={t("campaign.detail.scenes.title")} />
      <SceneViewportView
        scene={scene}
        imageUrl={imageUrl}
        selectedTokenId={selectedTokenId}
        onSelectToken={setSelectedTokenId}
      />
      <FogToolbarView
        api={props.api}
        sceneId={scene.sceneId}
        sceneRevision={scene.revision}
        online={online}
        onChanged={refetch}
      />
      <TokenTrayView
        api={props.api}
        sceneId={scene.sceneId}
        sceneRevision={scene.revision}
        tokens={scene.tokens}
        online={online}
        onChanged={refetch}
      />
    </section>
  );
}
