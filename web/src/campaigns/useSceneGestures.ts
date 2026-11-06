import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Point, TokenMode } from "./useTokenCommands.js";

export type SceneInteraction = {
  mode: TokenMode;
  setMode(mode: TokenMode): void;
  disabled: boolean;
  onPlace(point: Point): void;
  onMove(tokenId: string, point: Point): void;
};
type Gesture = { id: number; tokenId: string | null; start: Point; origin: Point; point: Point; moved: boolean; mode: TokenMode; offset: Point; rect: DOMRect };
const clamp = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;

/** The rendered layer rect includes CSS scale and translation. Reading it at
 * pointer-down avoids viewport/layout assumptions and keeps image + overlays in
 * the same normalized space. Cancel on transform/layout changes mid-gesture. */
export function useSceneGestures(props: {
  layer: RefObject<HTMLDivElement>;
  scope: string;
  zoom: number;
  pan: Point;
  setPan(point: Point): void;
  selectedTokenId: string | null;
  tokenPosition(id: string): Point | undefined;
  onSelectToken?: ((id: string | null) => void) | undefined;
  interaction?: SceneInteraction | undefined;
}) {
  const gesture = useRef<Gesture | null>(null), element = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<{ tokenId: string; point: Point } | null>(null);
  const cancel = () => {
    const old = gesture.current; gesture.current = null; setPreview(null);
    if (old && element.current?.hasPointerCapture?.(old.id)) element.current.releasePointerCapture(old.id);
  };
  const latest = useRef(props); latest.current = props;
  useEffect(() => {
    cancel();
    if (props.interaction?.mode === "place") { props.layer.current?.parentElement?.scrollIntoView?.({ block: "center" }); props.layer.current?.parentElement?.focus(); }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { cancel(); latest.current.interaction?.setMode("move"); } };
    window.addEventListener("keydown", escape); window.addEventListener("resize", cancel); window.addEventListener("blur", cancel); window.addEventListener("scroll", cancel, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(cancel);
    if (props.layer.current) observer?.observe(props.layer.current);
    return () => { gesture.current = null; observer?.disconnect(); window.removeEventListener("keydown", escape); window.removeEventListener("resize", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("scroll", cancel, true); };
  }, [props.scope, props.zoom, props.interaction?.mode, props.interaction?.disabled]);

  const rawPosition = (e: ReactPointerEvent, rect: DOMRect): Point => ({ x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height });
  const position = (e: ReactPointerEvent, g: Gesture): Point => { const raw = rawPosition(e, g.rect); return { x: clamp(raw.x - g.offset.x), y: clamp(raw.y - g.offset.y) }; };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gesture.current) { cancel(); return; } // A second contact cancels; never interpret pinch as a move.
    if (!props.interaction || props.interaction.disabled || e.button !== 0 || e.isPrimary === false) return;
    const rect = props.layer.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const target = e.target as HTMLElement, tokenId = target.closest<HTMLElement>("[data-token-id]")?.dataset.tokenId ?? null;
    e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); e.currentTarget.setPointerCapture(e.pointerId); element.current = e.currentTarget;
    if (tokenId && props.interaction.mode === "move") props.onSelectToken?.(tokenId);
    const raw = rawPosition(e, rect), token = tokenId ? props.tokenPosition(tokenId) : undefined;
    const offset = token && props.interaction.mode === "move" ? { x: raw.x - token.x, y: raw.y - token.y } : { x: 0, y: 0 };
    gesture.current = { offset, id: e.pointerId, tokenId, start: { x: e.clientX, y: e.clientY }, origin: props.pan, point: raw, moved: false, mode: props.interaction.mode, rect };
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || props.interaction?.disabled) return;
    if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 4) g.moved = true;
    g.point = position(e, g);
    if (g.mode === "pan") props.setPan({ x: g.origin.x + (e.clientX - g.start.x) / props.zoom, y: g.origin.y + (e.clientY - g.start.y) / props.zoom });
    else if (g.mode === "move" && g.tokenId && g.moved) setPreview({ tokenId: g.tokenId, point: g.point });
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const point = position(e, g), interaction = props.interaction;
    cancel();
    if (!interaction || interaction.disabled || g.mode === "pan") return;
    if (g.mode === "place" && !g.moved) interaction.onPlace(point);
    else if (g.mode === "move") {
      if (g.tokenId && g.moved) interaction.onMove(g.tokenId, point);
      else if (!g.tokenId && !g.moved && props.selectedTokenId) interaction.onMove(props.selectedTokenId, point);
    }
  };
  return { preview, cancel, handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: cancel, onLostPointerCapture: cancel } };
}
