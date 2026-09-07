import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConflictReview } from "./ConflictReview.js";
import type { CharacterSnapshot } from "./session.js";
import { makeEntry, makeRequest, makeView } from "./testing.js";
import type { OnlineAttempt } from "./store.js";

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
    lastMigration: null,
    pendingOnlineAttempts: [],
    connected: true,
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
    render(<ConflictReview snapshot={snapshot()} onResolve={onResolve} onClose={vi.fn()} />);
    await user.click(screen.getByRole("checkbox", { name: /LocalName|e-set|name/ }));
    await user.click(screen.getByRole("button", { name: "Reapply" }));
    expect(screen.getByRole("dialog")).toBeVisible();
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

  it("offers a correction path for invalid snapshots instead of a dead-end disabled reapply", async () => {
    const user = userEvent.setup();
    const snap = snapshot({
      phase: "invalid",
      error: {
        kind: "invalid",
        message: "Health must be positive",
        details: { diagnostics: [{ validationId: "v", severity: "error", message: "Health must be positive", targetDefinitionId: "health" }] },
      },
    });
    render(<ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByRole("button", { name: "Reapply" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).not.toBeDisabled();
    expect(screen.getByText(/correct the highlighted/i)).toBeVisible();
    expect(screen.getByLabelText(/correct/i)).toBeVisible();
  });

  it("names dependent queued entries following the selection in the confirm dialog", async () => {
    const user = userEvent.setup();
    const snap = snapshot({
      entries: [
        makeEntry({
          id: "e-set",
          actorId: "actor-A",
          characterId: "char-1",
          intent: { kind: "setField", fieldId: "name", value: "LocalName" },
        }),
        makeEntry({
          id: "e-next",
          actorId: "actor-A",
          characterId: "char-1",
          sequence: 1,
          intent: { kind: "setField", fieldId: "name", value: "Other" },
        }),
      ],
    });
    render(<ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    await user.click(screen.getByRole("button", { name: "Reapply" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText(/e-next/)).toBeVisible();
  });

  it("traps Tab inside the confirm dialog", async () => {
    const user = userEvent.setup();
    render(<ConflictReview snapshot={snapshot()} onResolve={vi.fn(async () => {})} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    const dialog = screen.getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: /confirm discard/i });
    expect(confirmButton).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.tab();
    expect(confirmButton).toHaveFocus();
  });

  it("drops selection for entries that disappear in a new snapshot", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ConflictReview snapshot={snapshot()} onResolve={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByRole("button", { name: "Discard" })).not.toBeDisabled();
    rerender(<ConflictReview snapshot={snapshot({ entries: [] })} onResolve={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("uses the injected clock for expiry instead of Date.now", () => {
    render(
      <ConflictReview
        snapshot={snapshot()}
        onResolve={vi.fn()}
        onClose={vi.fn()}
        now={Date.parse("2027-06-01T00:00:00.000Z")}
      />,
    );
    expect(screen.getAllByText(/uncertain/i).length).toBeGreaterThan(0);
  });

  it("corrects an invalid field through reapply with a new intent instead of disabling reapply", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    const snap = snapshot({
      phase: "invalid",
      error: {
        kind: "invalid",
        message: "Name is too short",
        details: { diagnostics: [{ validationId: "v", severity: "error", message: "Name is too short", targetDefinitionId: "name" }] },
      },
    });
    render(<ConflictReview snapshot={snap} onResolve={onResolve} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    const correction = screen.getByLabelText(/correct.*name/i);
    await user.clear(correction);
    await user.type(correction, "Briar Longname");
    await user.click(screen.getByRole("button", { name: "Reapply" }));
    await user.click(screen.getByRole("button", { name: /confirm reapply/i }));
    expect(onResolve).toHaveBeenCalledWith({
      mode: "reapply",
      selectedIds: ["e-set"],
      correctedIntents: { "e-set": { kind: "setField", fieldId: "name", value: "Briar Longname" } },
    });
  });

  it("rejects a correction that violates the projected field constraints", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    const confirmed = makeView({
      characterId: "char-1",
      revision: 7,
      state: { schemaVersion: "1.0", values: { level: 1 } },
      projection: {
        projectionVersion: "1.0",
        systemId: "22222222-2222-4000-8000-000000000000",
        versionId: "11111111-1111-4000-8000-000000000000",
        packageChecksum: "abc",
        entityId: "hero",
        entityLabel: "Hero",
        sheets: [
          {
            id: "sheet-1",
            label: "Sheet",
            sections: [
              {
                id: "section-1",
                label: "Section",
                elements: [
                  {
                    id: "element-level",
                    kind: "field",
                    fieldId: "level",
                    label: "Level",
                    value: 1,
                    fieldKind: "integer",
                    constraints: { min: 1, max: 10 },
                    validations: [],
                  },
                ],
              },
            ],
          },
        ],
        derivedValues: {},
        validations: [],
      },
    } as unknown as Parameters<typeof makeView>[0]);
    const snap = snapshot({
      phase: "invalid",
      confirmed,
      entries: [
        makeEntry({
          id: "e-level",
          actorId: "actor-A",
          characterId: "char-1",
          intent: { kind: "setField", fieldId: "level", value: 99 },
        }),
      ],
      error: {
        kind: "invalid",
        message: "Level must be between 1 and 10",
        details: { diagnostics: [{ validationId: "v", severity: "error", message: "Level must be between 1 and 10", targetDefinitionId: "level" }] },
      },
    });
    render(<ConflictReview snapshot={snap} onResolve={onResolve} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    const correction = screen.getByLabelText(/correct.*level/i);
    await user.clear(correction);
    await user.type(correction, "99");
    await user.click(screen.getByRole("button", { name: "Reapply" }));
    await user.click(screen.getByRole("button", { name: /confirm reapply/i }));
    expect(screen.getByRole("alert")).toBeVisible();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps unselected entries in review after a partial discard", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    const snap = snapshot({
      entries: [
        makeEntry({
          id: "e-first",
          actorId: "actor-A",
          characterId: "char-1",
          intent: { kind: "setField", fieldId: "name", value: "LocalName" },
        }),
        makeEntry({
          id: "e-second",
          actorId: "actor-A",
          characterId: "char-1",
          sequence: 1,
          intent: { kind: "setField", fieldId: "name", value: "Other" },
        }),
      ],
    });
    const { rerender } = render(<ConflictReview snapshot={snap} onResolve={onResolve} onClose={vi.fn()} />);
    await user.click(screen.getAllByRole("checkbox")[0]!);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await user.click(screen.getByRole("button", { name: /confirm discard/i }));
    expect(onResolve).toHaveBeenCalledWith({ mode: "discard", selectedIds: ["e-first"] });
    // The unselected intention stays in review with its own selection.
    rerender(
      <ConflictReview
        snapshot={snapshot({
          entries: [
            makeEntry({
              id: "e-second",
              actorId: "actor-A",
              characterId: "char-1",
              sequence: 1,
              intent: { kind: "setField", fieldId: "name", value: "Other" },
            }),
          ],
        })}
        onResolve={onResolve}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/Other/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  function onlineAttempt(overrides: Partial<OnlineAttempt> = {}): OnlineAttempt {
    return {
      id: "online-1",
      actorId: "actor-A",
      characterId: "char-1",
      kind: "archive",
      request: makeRequest({
        method: "PATCH",
        path: "/characters/char-1",
        body: { command: "archive", expectedRevision: 7, idempotencyKey: "online-key" },
        firstAttemptAt: "2026-01-01T00:00:00.000Z",
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("requires an explicit unknown-outcome acknowledgment before retiring an expired attempt", async () => {
    const user = userEvent.setup();
    const onReview = vi.fn(async () => {});
    const snap = snapshot({
      entries: [],
      error: {
        kind: "expired-attempt",
        message: "older than the server's replay window",
        details: { attemptId: "online-1" },
      },
      pendingOnlineAttempts: [onlineAttempt({ replayExpired: true })],
    });
    render(
      <ConflictReview snapshot={snap} onResolve={vi.fn()} onClose={vi.fn()} onReviewExpiredAttempt={onReview} now={Date.parse("2026-09-06T00:00:00.000Z")} />,
    );
    expect(screen.getAllByText(/outcome is unknown|unknown outcome/i).length).toBeGreaterThan(0);
    const reviewButton = screen.getByRole("button", { name: /acknowledge.*retire|retire.*acknowledge/i });
    expect(reviewButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /accept the unknown outcome/i }));
    await user.click(reviewButton);
    expect(onReview).toHaveBeenCalledWith({ attemptId: "online-1", acknowledgeUnknownOutcome: true });
  });

  it("keeps unexpired uncertain attempts out of ordinary discard and reapply", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn(async () => {});
    const snap = snapshot({
      pendingOnlineAttempts: [onlineAttempt({ createdAt: "2026-09-06T00:00:00.000Z" })],
    });
    render(
      <ConflictReview snapshot={snap} onResolve={onResolve} onClose={vi.fn()} now={Date.parse("2026-09-06T00:00:00.000Z")} />,
    );
    await user.click(screen.getAllByRole("checkbox")[0]!);
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reapply" })).toBeDisabled();
    expect(screen.getByText(/uncertain.*outcome|resolve.*uncertain/i)).toBeVisible();
    expect(onResolve).not.toHaveBeenCalled();
  });
});
