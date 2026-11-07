import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneViewportView } from "./SceneViewport.js";

const scene = { sceneId: "s1", campaignId: "c1", backgroundFileId: "f1", revision: 3, fog: [], tokens: [{ tokenId: "t1", label: "Alpha", x: .25, y: .5, size: .1, visible: true, imageFileId: null }] };
function setup(mode = "move", extra = {}) {
  // jsdom has no PointerEvent; retain all pointer coordinates and IDs.
  class Pointer extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; this.isPrimary = init.isPrimary ?? true; }
  }
  vi.stubGlobal("PointerEvent", Pointer);
  const interaction = { mode, setMode: vi.fn(), disabled: false, onPlace: vi.fn(), onMove: vi.fn(), ...extra };
  const view = render(<SceneViewportView scene={scene} imageUrl="/bg" selectedTokenId="t1" interaction={interaction as never} />);
  const layer = screen.getByTestId("scene-zoom-layer"), region = screen.getByRole("region", { name: /Scene viewport/ });
  vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({ x: -50, y: 20, left: -50, top: 20, width: 500, height: 300, right: 450, bottom: 320, toJSON() {} });
  region.setPointerCapture = vi.fn(); region.releasePointerCapture = vi.fn(); region.hasPointerCapture = vi.fn().mockReturnValue(true);
  const pointer = (target: Element, type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", x: number, y: number, pointerType = "mouse", pointerId = 1) => fireEvent[type](target, { clientX: x, clientY: y, pointerType, pointerId, button: 0 });
  return { ...view, interaction, layer, region, pointer };
}

describe("scene pointer gestures", () => {
  it.each(["mouse", "touch"])("previews %s dragging and commits one bounded normalized move on release", type => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170, type);
    s.pointer(s.region, "pointerMove", 325, 245, type);
    expect(s.interaction.onMove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Token Alpha" }).parentElement).toHaveStyle({ left: "75%", top: "75%" });
    s.pointer(s.region, "pointerUp", 325, 245, type);
    expect(s.interaction.onMove).toHaveBeenCalledTimes(1);
    expect(s.interaction.onMove).toHaveBeenCalledWith("t1", { x: .75, y: .75 });
  });
  it("does not scroll the scene when capturing a pointer", () => {
    const s = setup(), focus = vi.spyOn(s.region, "focus");
    s.pointer(s.region, "pointerDown", 200, 95);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it("tap places or moves through the transformed layer rectangle", () => {
    const s = setup("place");
    s.pointer(s.region, "pointerDown", 200, 95); s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onPlace).toHaveBeenCalledWith({ x: .5, y: .25 });
  });
  it.each(["Escape", "pointerCancel", "lostpointercapture"])("discards the drag on %s", cancel => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170);
    s.pointer(s.region, "pointerMove", 200, 95);
    if (cancel === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (cancel === "pointerCancel") s.pointer(s.region, "pointerCancel", 200, 95);
    else fireEvent.lostPointerCapture(s.region, { pointerId: 1 });
    s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onMove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Token Alpha" }).parentElement).toHaveStyle({ left: "25%", top: "50%" });
  });
  it("pan and multi-touch cannot commit token edits", () => {
    const s = setup("pan");
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170);
    s.pointer(s.region, "pointerMove", 200, 95); s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onMove).not.toHaveBeenCalled();
    expect(s.layer.style.transform).not.toContain("translate(0px, 0px)");
  });
  it("preserves the grab offset when dragging from the edge of a token", () => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 85, 180);
    s.pointer(s.region, "pointerMove", 335, 255); s.pointer(s.region, "pointerUp", 335, 255);
    expect(s.interaction.onMove).toHaveBeenCalledWith("t1", { x: .75, y: .75 });
  });
  it("ignores a secondary touch and cancels an active gesture when a second finger lands", () => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170, "touch");
    s.pointer(s.region, "pointerMove", 200, 95, "touch");
    s.pointer(s.region, "pointerDown", 250, 100, "touch", 2);
    s.pointer(s.region, "pointerUp", 200, 95, "touch");
    expect(s.interaction.onMove).not.toHaveBeenCalled();
  });
  it("disables edits and bounds completed moves to the scene", () => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170);
    s.pointer(s.region, "pointerMove", 900, -100); s.pointer(s.region, "pointerUp", 900, -100);
    expect(s.interaction.onMove).toHaveBeenCalledWith("t1", { x: 1, y: 0 });
    s.rerender(<SceneViewportView scene={scene} imageUrl="/bg" selectedTokenId="t1" interaction={{ ...s.interaction, mode: "move", disabled: true } as never} />);
    s.pointer(s.region, "pointerDown", 200, 95); s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onMove).toHaveBeenCalledTimes(1);
  });
  it("cancels when page scrolling changes the captured scene rectangle", () => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170);
    s.pointer(s.region, "pointerMove", 200, 95); fireEvent.scroll(window);
    s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onMove).not.toHaveBeenCalled();
  });
  it("cancels a gesture when the scene revision changes", () => {
    const s = setup();
    s.pointer(screen.getByRole("button", { name: "Token Alpha" }), "pointerDown", 75, 170);
    s.pointer(s.region, "pointerMove", 200, 95);
    s.rerender(<SceneViewportView scene={{ ...scene, revision: 4 }} imageUrl="/bg" selectedTokenId="t1" interaction={s.interaction as never} />);
    s.pointer(s.region, "pointerUp", 200, 95);
    expect(s.interaction.onMove).not.toHaveBeenCalled();
  });
});
