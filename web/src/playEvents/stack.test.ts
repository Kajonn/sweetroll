import { describe, expect, it } from "vitest";
import { createEventStack } from "./stack.js";

describe("play event stack", () => {
  it("stacks distinct results immediately and expires them independently", () => {
    const stack = createEventStack();
    stack.add([{ id: "a", text: "Roll 12" }], 0);
    stack.add([{ id: "b", text: "Roll 12" }], 1000);
    stack.add([{ id: "a", text: "duplicate" }], 2000);
    expect(stack.snapshot(2000).cards.map(card => card.id)).toEqual(["b", "a"]);
    expect(stack.snapshot(6000).cards.map(card => card.fading)).toEqual([false, true]);
    stack.add([{ id: "c", text: "Draw" }], 6100);
    expect(stack.snapshot(6240).cards.map(card => card.id)).toEqual(["c", "b"]);
    expect(stack.snapshot(7240).cards.map(card => card.id)).toEqual(["c"]);
  });

  it("counts overflow and promotes it without resetting its timer", () => {
    const stack = createEventStack();
    stack.add(["a", "b", "c"].map(id => ({ id, text: id })), 0);
    stack.add([{ id: "d", text: "d" }], 1000);
    expect(stack.snapshot(1000)).toMatchObject({
      overflow: 1,
      cards: [{ id: "c" }, { id: "b" }, { id: "a" }],
    });
    expect(stack.snapshot(6240)).toMatchObject({ overflow: 0, cards: [{ id: "d", fading: false }] });
    expect(stack.snapshot(7240).cards).toEqual([]);
  });

  it("clears denied cards and keeps their IDs seen", () => {
    const stack = createEventStack();
    stack.add([{ id: "a", text: "Restricted", watch: true }, { id: "b", text: "Another" }], 0);
    stack.retainAuthorized([], ["a"]);
    stack.add([{ id: "a", text: "Restricted" }], 1000);
    expect(stack.snapshot(1000).cards.map(card => card.id)).toEqual(["b"]);
  });
});
