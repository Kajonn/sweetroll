import { useEffect, useRef } from "react";
import {
  AmbientLight,
  Quaternion,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Group,
  type BufferGeometry,
} from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { tray } from "../../../src/systems/physical-dice/launch.js";
import type { RollStarted } from "../../../src/campaigns/physical-dice-stream.js";
import type { Frame } from "./simulation.js";
import styles from "./dice.module.css";

export type PoseBuffer = { previous: Frame | null; frame: Frame | null; updated: number };

export default function DiceCanvas({
  roll,
  poses,
  onUnavailable,
}: {
  roll: Pick<RollStarted, "dice" | "color">;
  poses: PoseBuffer;
  onUnavailable: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current!;
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas: element,
        alpha: true,
        antialias: true,
        powerPreference: "low-power",
      });
    } catch {
      onUnavailable();
      return;
    }
    const controller = new AbortController();
    const scene = new Scene();
    scene.add(new AmbientLight(0xffffff, 1.4));
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(-5, 8, 15);
    scene.add(key);
    const rim = new DirectionalLight(0xdce9ff, 0.7);
    rim.position.set(8, -3, 10);
    scene.add(rim);
    const camera = new OrthographicCamera(
      -tray.halfWidth,
      tray.halfWidth,
      tray.halfHeight,
      -tray.halfHeight,
      0.1,
      100,
    );
    camera.position.z = 40;
    const color = new Color(roll.color);
    const ink = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 > 0.18 ? 0x111111 : 0xffffff;
    const bodyMaterial = new MeshStandardMaterial({ color, roughness: 0.38 });
    const inkMaterial = new MeshStandardMaterial({ color: ink, roughness: 0.55 });
    const geometry = new Set<BufferGeometry>();
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = element;
      if (!width || !height) return;
      const aspect = width / height;
      const halfWidth = Math.max(tray.halfWidth + 0.8, (tray.halfHeight + 0.8) * aspect);
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = halfWidth / aspect;
      camera.bottom = -camera.top;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.setSize(width, height, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    let animation = 0;
    element.addEventListener("webglcontextlost", onUnavailable);
    const shapes = [...new Set(roll.dice.map((die) => die.sides))];
    const loader = new OBJLoader();
    void Promise.all(
      shapes.map(async (sides) => {
        const response = await fetch(`/dice/v1/${sides}Dice.obj`, { signal: controller.signal });
        if (!response.ok) throw Error("The dice model is unavailable.");
        const source = await response.text();
        controller.signal.throwIfAborted();
        const model = loader.parse(source);
        model.scale.setScalar(tray.modelScale);
        model.traverse((child) => {
          if (!(child instanceof Mesh)) return;
          geometry.add(child.geometry);
          const tint = (material: { name: string; dispose(): void }) => {
            const replacement = material.name === "Black" ? inkMaterial : bodyMaterial;
            material.dispose();
            return replacement;
          };
          child.material = Array.isArray(child.material) ? child.material.map(tint) : tint(child.material);
        });
        return [sides, model] as const;
      }),
    )
      .then((models) => {
        if (controller.signal.aborted) return;
        const templates = new Map(models);
        const meshes = new Map<string, Group>();
        for (const die of roll.dice) {
          const mesh = templates.get(die.sides)!.clone();
          mesh.visible = false;
          meshes.set(die.id, mesh);
          scene.add(mesh);
        }
        const before = new Vector3();
        const after = new Vector3();
        const next = new Quaternion();
        const render = (now: number) => {
          const { frame, previous, updated } = poses;
          const blend =
            frame && previous
              ? Math.min(
                  1,
                  (now - updated) / Math.max(16, ((frame.tick - previous.tick) * 1000) / tray.ticksPerSecond),
                )
              : 1;
          for (const [index, pose] of (frame?.dice ?? []).entries()) {
            const mesh = meshes.get(pose.id);
            if (!mesh) continue;
            const { position: p, orientation: q } = pose;
            const prior = previous?.dice[index];
            after.set(p.x, p.y, p.z);
            mesh.position.copy(after);
            mesh.quaternion.set(q.x, q.y, q.z, q.w);
            if (prior && prior.id === pose.id && blend < 1) {
              before.set(prior.position.x, prior.position.y, prior.position.z);
              mesh.position.lerpVectors(before, after, blend);
              const r = prior.orientation;
              next.copy(mesh.quaternion);
              mesh.quaternion.set(r.x, r.y, r.z, r.w).slerp(next, blend);
            }
            mesh.visible = true;
          }
          renderer.render(scene, camera);
          if (frame && !element.dataset.diceReady) element.dataset.diceReady = "true";
          animation = requestAnimationFrame(render);
        };
        animation = requestAnimationFrame(render);
      })
      .catch(() => {
        if (!controller.signal.aborted) onUnavailable();
      });
    return () => {
      controller.abort();
      cancelAnimationFrame(animation);
      observer.disconnect();
      element.removeEventListener("webglcontextlost", onUnavailable);
      for (const buffer of geometry) buffer.dispose();
      bodyMaterial.dispose();
      inkMaterial.dispose();
      renderer.dispose();
    };
  }, [roll, poses, onUnavailable]);
  return (
    <canvas ref={canvas} className={styles.canvas} aria-hidden="true" data-testid="physical-dice-canvas" />
  );
}
