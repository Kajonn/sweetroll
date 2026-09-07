import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConflictReview } from "./ConflictReview.js";
import type { CharacterSnapshot } from "./session.js";
import { makeEntry, makeView } from "./testing.js";

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  const confirmed = makeView({
    characterId: "char-1",
    revision: 7,
    state: { schemaVersion: "1.0", values: { name: "ServerName", health: 4 } },
  });
  return {
    phase: "conflict",
    confirmed,
    tentative: { name: "LocalName" },
    entries: [
      makeEntry({
        id: "e-set",
        actorId: "actor-A",
        characterId: "char-1",
        intent: { kind: "setField", fieldId: "name", value: "LocalName" },
        attempt: {
          method: "POST",
          path: "/characters/char-1/fields/name/set",
          body: { value: "LocalName", expectedRevision: 1, idempotencyKey: "conflicted-key" },
          firstAttemptAt: "2026-09-06T00:00:00.000Z",
        },
      }),
    ],
    editing: { owned: true },
    error: { kind: "conflict", message: "The character changed on the server. Review before re-sending." },
    lastRoll: null,
    ...overrides,
  };
}

describe("ConflictReview", () => {
  it("compares server versus local values for scalar sets", () => {
    render(<ConflictReview snapshot={snapshot()} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/ServerName/)).toBeVisible();
    expect(screen.getByText(/LocalName/)).toBeVisible();
  });

  it("compares bump direction against the server value", () => {
    const confirmed = makeView({
      characterId: "char-1",
      revision: 7,
      state: { schemaVersion: "1.0", values: { health: 4 } },
    });
    const snap = snapshot({
      confirmed,
      tentative: { health: { up: 1, down: 0 } },
      entries: [
        makeEntry({
          id: "e-bump",
          actorId: "actor-A",
          characterId: "char-1",
          intent: { kind: "bumpResource", resourceId: "health", direction: "up" },
        }),
      ],
    });
    render(<ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/up/)).toBeVisible();
    expect(screen.getByText(/4/)).toBeVisible();
  });

  it("confirms before discarding the selected intentions", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    render(<ConflictReview snapshot={snapshot()} onResolve={onResolve} onClose={vi.fn()} />);
    await user.click(screen.getByRole("checkbox", { name: /LocalName|e-set|name/ }));
    await user.click(screen.getByRole("button", { name: /discard/i }));
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /confirm discard/i }));
    expect(onResolve).toHaveBeenCalledWith({ mode: "discard", selectedIds: ["e-set"] });
  });

  it("confirms before reapplying the selected intentions", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    render(<ConflictReview snapshot={snapshot()} onResolve={vi.fn()} onClose={vi.fn()} />);
    const rerender = (onResolveFn: typeof onResolve) => {
      // re-render is handled by caller; this test submits via the component
      void onResolveFn;
    };
    void rerender;
    render(<ConflictReview snapshot={snapshot()} onResolve={onResolve} onClose={vi.fn()} />);
    const boxes = screen.getAllByRole("checkbox");
    await user.click(boxes[boxes.length - 1]!);
    const reapply = screen.getAllByRole("button", { name: /reapply/i });
    await user.click(reapply[reapply.length - 1]!);
    await user.click(screen.getByRole("button", { name: /confirm reapply/i }));
    expect(onResolve).toHaveBeenCalledWith({ mode: "reapply", selectedIds: ["e-set"] });
  });

  it("keeps showing a repeated conflict after reapply", () => {
    const { rerender } = render(<ConflictReview snapshot={snapshot()} onResolve={vi.fn()} onClose={vi.fn()} />);
    const again = snapshot({
      confirmed: makeView({
        characterId: "char-1",
        revision: 9,
        state: { schemaVersion: "1.0", values: { name: "ServerAgain" } },
      }),
    });
    rerender(<ConflictReview snapshot={again} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/ServerAgain/)).toBeVisible();
  });

  it("warns when an uncertain attempt is past the replay window", () => {
    const snap = snapshot({
      entries: [
        makeEntry({
          id: "e-old",
          actorId: "actor-A",
          characterId: "char-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          intent: { kind: "setField", fieldId: "name", value: "LocalName" },
          attempt: {
            method: "POST",
            path: "/characters/char-1/fields/name/set",
            body: { value: "LocalName", expectedRevision: 1, idempotencyKey: "old-key" },
            firstAttemptAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ],
      error: { kind: "expired-attempt", message: "older than the server's replay window" },
    });
    render(<ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText(/replay window|expired|uncertain/i).length).toBeGreaterThan(0);
  });

  it("shows invalid diagnostics for correction", () => {
    const snap = snapshot({
      phase: "invalid",
      error: {
        kind: "invalid",
        message: "Health must be positive",
        details: { diagnostics: [{ validationId: "v", severity: "error", message: "Health must be positive", targetDefinitionId: "health" }] },
      },
    });
    render(<ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText(/Health must be positive/).length).toBeGreaterThan(0);
  });

  it("restores focus to the opener after the confirmation dialog closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <div>
        <ConflictReview snapshot={snapshot()} onResolve={vi.fn(async () => {})} onClose={onClose} />
      </div>,
    );
    await user.click(screen.getByRole("checkbox", { name: /LocalName|e-set|name/ }));
    const discard = screen.getByRole("button", { name: /discard/i });
    await user.click(discard);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /confirm discard/i })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(discard).toHaveFocus();
  });
});
