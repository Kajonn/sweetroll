import { SceneTokenArt } from "./SceneTokenArt.js";
import tokenStyles from "./SceneToken.module.css";
import { SceneLibrary } from "./SceneLibrary.js";
// GM scene viewport: normalized scene-space image with token markers, plus
// the GM scene route composition (viewport + fog toolbar + token tray).
// Positions are fractions of the scene extent; markers use percentage
// offsets so they track any rendered size. Zoom/pan expose button and
// keyboard (+/-/arrows) alternatives; token dragging alternatives live in
// TokenTray (numeric coordinates + nudge buttons).
import { useRef, useState, type RefObject } from "react";
import { useSceneGestures, type SceneInteraction, type SceneMode } from "./useSceneGestures.js";
import { useTokenCommands } from "./useTokenCommands.js";

import { t } from "../i18n/index.js";
import { Button, EmptyState, PageHeader, Panel } from "../ui/index.js";
import type { CampaignsApi } from "./api.js";
import { useScene } from "./campaignQueries.js";
import { useFogEditor, MAX_FOG_DABS, type FogMode, type FogDab } from "./useFogEditor.js";
import { SceneFogOverlay } from "./SceneFogOverlay.js";
import { FogToolbarView } from "./FogToolbar.js";
import { TokenTrayView, TokenCommandFeedback } from "./TokenTray.js";
import type { SceneView } from "./types.js";

export type SceneViewportApi = Pick<
  CampaignsApi,
  "openScene" | "applyFogEdit" | "placeToken" | "moveToken"
> & Pick<CampaignsApi, "sceneLibrary">;

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
  feedback?: React.ReactNode;
  viewportRef?: RefObject<HTMLDivElement> | undefined;
  fog?: { mode: FogMode; radius: number; draft: FogDab[] } | undefined;
  interaction?: SceneInteraction | undefined;
  scene: SceneView;
  imageUrl: string;
  selectedTokenId?: string | null | undefined;
  onSelectToken?: ((tokenId: string | null) => void) | undefined;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const selectedTokenId = props.selectedTokenId ?? null;
  const layer = useRef<HTMLDivElement>(null);
  const gestures = useSceneGestures({ layer, scope: `${props.scene.sceneId}:${props.scene.backgroundFileId}:${props.scene.revision}`, zoom, pan, setPan, selectedTokenId, tokenPosition: id => props.scene.tokens.find(token => token.tokenId === id), onSelectToken: props.onSelectToken, interaction: props.interaction });

  const zoomIn = (): void => { gestures.cancel(); setZoom((current) => Math.min(ZOOM_MAX, current * ZOOM_STEP)); };
  const zoomOut = (): void => { gestures.cancel(); setZoom((current) => Math.max(ZOOM_MIN, current / ZOOM_STEP)); };
  const resetView = (): void => {
    gestures.cancel();
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  return (
    <Panel title={t("campaign.detail.scenes.title")}>
      {props.interaction ? <div role="group" aria-label={t("scene.gestures.tools")}>
        <Button variant="secondary" aria-pressed={props.interaction.mode === "move"} onClick={() => props.interaction?.setMode("move")}>{t("scene.gestures.move")}</Button>{" "}
        <Button variant="secondary" aria-pressed={props.interaction.mode === "pan"} onClick={() => props.interaction?.setMode("pan")}>{t("scene.gestures.pan")}</Button>
        {props.fog ? <Button variant="secondary" aria-pressed={props.interaction.mode === "brush"} onClick={() => props.interaction?.setMode("brush")}>{t("scene.fog.paint")}</Button> : null}
        <p role="status">{t(props.interaction.mode === "brush" ? "scene.fog.brushHint" : props.interaction.mode === "place" ? "scene.gestures.placeHint" : props.interaction.mode === "pan" ? "scene.gestures.panHint" : "scene.gestures.moveHint")}</p>
      </div> : null}
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
        {...gestures.handlers}
        ref={props.viewportRef}
        role="region"
        aria-label={t("campaign.detail.scenes.viewport.regionLabel")}
        tabIndex={0}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          gestures.cancel();
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
        style={{ position: "relative", overflow: "hidden", touchAction: props.interaction ? "none" : "auto", userSelect: "none" }}
      >
        <div ref={layer} data-testid="scene-zoom-layer" style={{ transform: `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)` }}>
          <img
            draggable={false}
            src={props.imageUrl}
            alt={t("campaign.detail.scenes.viewport.imageAlt")}
            style={{ display: "block", width: "100%" }}
          />
          <ul aria-label={t("campaign.detail.scenes.viewport.tokensLabel")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {props.scene.tokens.map((token) => (
              <li
                key={token.tokenId}
                className={tokenStyles.token}
                style={{
                  width: `${token.size * 100}%`,
                  position: "absolute",
                  left: `${(gestures.preview?.tokenId === token.tokenId ? gestures.preview.point.x : token.x) * 100}%`,
                  top: `${(gestures.preview?.tokenId === token.tokenId ? gestures.preview.point.y : token.y) * 100}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <button
                  data-token-id={token.tokenId}
                  type="button"
                  className={tokenStyles.marker}
                  aria-label={t("campaign.detail.scenes.viewport.token", { label: token.label })}
                  aria-pressed={selectedTokenId === token.tokenId}
                  data-visible={token.visible ? "true" : "false"}
                  style={{ opacity: token.visible ? 1 : 0.5 }}
                  onClick={() => { if (!props.interaction || props.interaction.mode === "move") props.onSelectToken?.(token.tokenId); }}
                >
                  {token.imageFileId ? <SceneTokenArt key={token.imageFileId} campaignId={props.scene.campaignId} fileId={token.imageFileId} /> : null}
                  <span className={tokenStyles.label}>{token.label}</span>
                </button>
              </li>
            ))}
          </ul>
          {props.fog ? <SceneFogOverlay fog={props.scene.fog} draft={props.fog.draft} active={gestures.fogPreview} mode={props.fog.mode} radius={props.fog.radius} cursor={gestures.cursor} /> : null}
        </div>
      </div>
      {props.feedback}
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
  return <CampaignSceneScope key={`${props.actorId}:${props.generation}:${props.campaignId}:${props.sceneId}:${props.online}`} {...props} />;
}

function CampaignSceneScope(props: {
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

  if (!online) {
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        <EmptyState title={t("campaign.detail.scenes.offline")} />
      </section>
    );
  }

  const library = props.api.sceneLibrary ? <SceneLibrary api={props.api.sceneLibrary} campaignId={props.campaignId} actorId={props.actorId} generation={generation} online={online} scene={sceneQuery.data?.scene} onChanged={async () => { if (props.sceneId) await sceneQuery.refetch(); }} onOpenScene={id => { window.location.assign(`/campaigns/${encodeURIComponent(props.campaignId)}/scenes?sceneId=${encodeURIComponent(id)}`); }} /> : null;
  if (props.sceneId === "") {
    return (
      <section aria-label={t("campaign.detail.scenes.title")}>
        <PageHeader title={t("campaign.detail.scenes.title")} />
        {library}
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

  if (sceneQuery.status === "error" && (!sceneQuery.data || isNotFound(sceneQuery.error) || [401, 403].includes(Number((sceneQuery.error as { status?: number })?.status)))) {
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

  return <SceneEditor key={sceneQuery.data!.scene.backgroundFileId} scene={sceneQuery.data!.scene} library={library} props={props} refresh={async () => { const result = await sceneQuery.refetch(); if (result.error) throw result.error; return result.data!.scene.revision; }} />;
}

function SceneEditor({ scene, library, props, refresh }: { scene: SceneView; library: React.ReactNode; props: Parameters<typeof CampaignSceneView>[0]; refresh(): Promise<number> }) {
  const online = props.online ?? true, generation = props.generation ?? 0;
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [mode, setMode] = useState<SceneMode>("move");
  const viewportRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ label: string; size: number; visible: boolean; imageFileId: string | null } | null>(null);
  const commands = useTokenCommands({ api: props.api, sceneId: scene.sceneId, sceneRevision: scene.revision, online, onChanged: refresh });
  const fog = useFogEditor({ api: props.api, sceneId: scene.sceneId, sceneRevision: scene.revision, online, enabled: !commands.blocked, onChanged: refresh });
  const imageUrl = `/api/campaigns/${props.campaignId}/images/${scene.backgroundFileId}/original`;
  const refetch = (): void => { void refresh().catch(() => {}); };
  if (commands.status === "unavailable" || fog.status === "unavailable") return <EmptyState title={t("campaign.detail.scenes.unavailable.title")} description={t("campaign.detail.scenes.unavailable.description")} />;
  return (
    <section>
      <PageHeader title={t("campaign.detail.scenes.title")} />
      {library}
      <SceneViewportView
        scene={scene}
        fog={fog}
        viewportRef={viewportRef}
        imageUrl={imageUrl}
        feedback={<TokenCommandFeedback commands={commands} online={online} />}
        selectedTokenId={selectedTokenId}
        onSelectToken={setSelectedTokenId}
        interaction={{ mode, setMode, disabled: commands.blocked || fog.blocked, brush: { mode: fog.mode, radius: fog.radius, remaining: MAX_FOG_DABS-fog.draft.length, onStroke: fog.addStroke }, onPlace: point => { if (placement && !fog.blocked) { commands.place({ ...placement, ...point }); setPlacement(null); setMode("move"); } }, onMove: (id, point) => { const token = scene.tokens.find(t => t.tokenId === id); if (token && !fog.blocked) commands.move(id, token.label, point); } }}
      />
      <FogToolbarView api={props.api} sceneId={scene.sceneId} sceneRevision={scene.revision} online={online} editor={fog} disabled={commands.blocked} onChanged={refetch} onPaint={() => { setMode("brush"); viewportRef.current?.scrollIntoView({block:"center"}); viewportRef.current?.focus({preventScroll:true}); }} />
      <TokenTrayView
        mediaApi={props.api.sceneLibrary}
        campaignId={props.campaignId}
        actorId={props.actorId}
        generation={generation}
        api={props.api}
        sceneId={scene.sceneId}
        sceneRevision={scene.revision}
        tokens={scene.tokens}
        online={online}
        disabled={fog.blocked}
        onChanged={refetch}
        commands={commands}
        onPlaceOnScene={draft => { setPlacement(draft); setMode("place"); }}
      />
    </section>
  );
}
