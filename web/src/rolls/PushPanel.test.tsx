import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PushPanel } from "./PushPanel.js";
import type { CommandResult } from "../characters/types.js";
const root: NonNullable<CommandResult["roll"]> = {
  actionId: "roll",
  expression: "group(base,2d6)",
  total: 8,
  output: "Private result",
  audience: "owner_only",
  bindings: [],
  dice: [
    { sides: 6, value: 2, kept: true, id: "base:0", groupId: "base" },
    { sides: 6, value: 6, kept: true, id: "base:1", groupId: "base" },
  ],
  breakdown: {
    version: "1.0",
    rootId: "root",
    groups: [
      {
        id: "base",
        label: "Base",
        count: 2,
        sides: 6,
        operation: "sum",
        diceIds: ["base:0", "base:1"],
        total: 8,
      },
    ],
    terms: [
      {
        id: "root",
        operation: "dice",
        operandIds: [],
        value: 8,
        groupId: "base",
      },
    ],
  },
  push: {
    version: "1.0",
    rollId: "root",
    rootRollId: "root",
    parentRollId: null,
    attempt: 0,
    maxAttempts: 2,
    rerolledDiceIds: [],
    faceOutcomes: [],
  },
};
function api() {
  return {
    pushOptions: vi
      .fn()
      .mockResolvedValue({
        options: {
          canPush: true,
          reason: null,
          eligibleDiceIds: ["base:0"],
          revision: 3,
          nextAttempt: 1,
          maxAttempts: 2,
        },
      }),
    readRoll: vi.fn().mockResolvedValue({ roll: root }),
  };
}
describe("authoritative push controls", () => {
  it("keeps a denied private result hidden when switching offline", async () => {
    const a=api();a.pushOptions.mockRejectedValue(Object.assign(new Error("denied"),{status:404}));
    const onDenied=vi.fn(async()=>{});
    const props={roll:root,characterId:"hero",api:a,revision:3,onDenied};
    const view=render(<PushPanel {...props} online />);
    await screen.findByText("This roll is no longer available.");
    view.rerender(<PushPanel {...props} online={false} />);
    expect(screen.queryByText("Private result")).toBeNull();
    expect(screen.getByText("This roll is no longer available.")).toBeVisible();
    expect(onDenied).toHaveBeenCalledWith("root");
  });
  it("explains narrowed child visibility and disables pushing", async () => {
    const a = api(), onPush = vi.fn();
    a.pushOptions.mockResolvedValue({options:{canPush:false,reason:"audience_restricted",eligibleDiceIds:[],revision:3,nextAttempt:1,maxAttempts:2}});
    render(<PushPanel roll={root} characterId="hero" api={a} online revision={3} onPush={onPush} />);
    expect(await screen.findByText("The current sharing rules do not let you push this roll.")).toBeVisible();
    expect(screen.getByRole("button", {name:"Push saved roll"})).toBeDisabled();
    expect(onPush).not.toHaveBeenCalled();
  });
  it("loads fresh options and sends only the saved parent, retaining keyboard focus while busy", async () => {
    const a = api(),
      onPush = vi.fn(async () => {});
    render(
      <PushPanel
        roll={root}
        characterId="hero"
        api={a}
        online
        revision={3}
        disabled={false}
        onPush={onPush}
      />,
    );
    const button = await screen.findByRole("button", {
      name: "Push saved roll",
    });
    await waitFor(() => expect(button).toBeEnabled());
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(onPush).toHaveBeenCalledWith("root"));
    expect(
      screen.getByRole("region", { name: "Saved pool result" }),
    ).toHaveFocus();
    expect(a.pushOptions).toHaveBeenCalledWith("hero", "root");
  });
  it("shows cached lineage offline but cannot fetch or create a push", async () => {
    const a = api(),
      onPush = vi.fn();
    render(
      <PushPanel
        roll={root}
        characterId="hero"
        api={a}
        online={false}
        revision={3}
        disabled={false}
        onPush={onPush}
      />,
    );
    expect(await screen.findByText("Private result")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Push saved roll" }),
    ).toBeDisabled();
    expect(a.pushOptions).not.toHaveBeenCalled();
    expect(onPush).not.toHaveBeenCalled();
  });
  it("hides a cached result after a current authorization denial", async () => {
    const a = api();
    a.pushOptions.mockRejectedValue(
      Object.assign(new Error("unavailable"), { status: 404 }),
    );
    render(
      <PushPanel
        roll={root}
        characterId="hero"
        api={a}
        online
        revision={3}
        disabled={false}
        onPush={vi.fn()}
      />,
    );
    expect(
      await screen.findByText("This roll is no longer available."),
    ).toBeVisible();
    expect(screen.queryByText("Private result")).toBeNull();
  });
  it("reauthorizes parent navigation and reports retained/rerolled dice in text", async () => {
    const a = api();
    const child = {
      ...root,
      push: {
        ...root.push!,
        rollId: "child",
        parentRollId: "root",
        attempt: 1,
        rerolledDiceIds: ["base:0"],
      },
    };
    render(
      <PushPanel
        roll={child}
        characterId="hero"
        api={a}
        online
        revision={3}
        disabled={false}
        onPush={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "View parent roll" }),
    );
    await waitFor(() =>
      expect(a.readRoll).toHaveBeenCalledWith("hero", "root"),
    );
    expect(screen.getAllByText(/Rerolled/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Retained/).length).toBeGreaterThan(0);
  });
});
