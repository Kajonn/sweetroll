import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CharacterSnapshot } from "./session.js";
import { makeView } from "./testing.js";
import { CharacterSheet } from "./CharacterSheet.js";

function snapshot(overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  const projection = {
    projectionVersion: "1.0" as const, systemId: "system", versionId: "version", packageChecksum: "checksum", entityId: "hero", entityLabel: "Hero",
    derivedValues: {}, validations: [],
    completionFields: [{ kind: "field" as const, id: "completion-name", fieldId: "name", label: "Name", fieldKind: "text" as const, value: "Aria", editable: true, constraints: { required: true }, validations: [] }],
    sheets: [
      { id: "identity", label: "Identity", sections: [{ id: "basics", label: "Basics", elements: [
        { kind: "heading" as const, id: "intro", text: "Who are you?", level: 2 as const },
        { kind: "field" as const, id: "name-first", fieldId: "name", label: "Name", fieldKind: "text" as const, value: "Aria", editable: true, constraints: { required: true }, validations: [] },
        { kind: "field" as const, id: "portrait", fieldId: "portrait", label: "Portrait", fieldKind: "image" as const, value: null, editable: false, constraints: {}, validations: [{ validationId: "portrait", severity: "error" as const, message: "Portrait is required", targetDefinitionId: "portrait" }] },
      ] }] },
      { id: "play", label: "Play", sections: [{ id: "moves", label: "Moves", elements: [
        { kind: "field" as const, id: "name-repeat", fieldId: "name", label: "Character name", fieldKind: "text" as const, value: "Aria", editable: true, constraints: { required: true }, validations: [] },
        { kind: "field" as const, id: "defense", fieldId: "defense", label: "Defense", fieldKind: "computed" as const, value: 12, editable: false, constraints: {}, validations: [{ validationId: "defense", severity: "warning" as const, message: "Defense is stale", targetDefinitionId: "defense" }] },
        { kind: "resource" as const, id: "health", resourceId: "health", label: "Health", value: { current: 4, max: 6 }, min: 0, max: 6, step: 1, resetTo: "max" as const, validations: [{ validationId: "health", severity: "warning" as const, message: "Health is low", targetDefinitionId: "health" }] },
        { kind: "action" as const, id: "roll", actionId: "roll-check", label: "Roll check", actionKind: "roll" as const, inputs: [{ id: "bonus", label: "Bonus", valueType: "integer" as const, required: false, default: 0 }], validations: [{ validationId: "roll", severity: "warning" as const, message: "Roll carefully", targetDefinitionId: "roll-check" }] },
        { kind: "action" as const, id: "rest", actionId: "rest", label: "Rest", actionKind: "resourceBump" as const, inputs: [], validations: [] },
      ] }] },
    ],
  };
  return {
    phase: "ready", confirmed: makeView({ characterId: "character", revision: 1, projection }), tentative: null,
    entries: [], editing: { owned: true }, error: null, lastRoll: null, ...overrides,
  };
}

describe("CharacterSheet", () => {
  it("renders every projected element in sequential sheets and uses unique labels for duplicate fields", () => {
    render(<CharacterSheet snapshot={snapshot()} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1, name: "Aria" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Identity" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Play" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Who are you?" })).toBeVisible();
    expect(screen.getByText("12")).toBeVisible();
    expect(screen.getByText("Images are unavailable.")).toBeVisible();
    expect(screen.getByText("Portrait is required")).toBeVisible();
    expect(screen.getByText("Defense is stale")).toBeVisible();
    expect(screen.getByText("Health is low")).toBeVisible();
    expect(screen.getByText("Roll carefully")).toBeVisible();
    expect(screen.getByRole("button", { name: "Increase Health" })).toBeEnabled();
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
  });

  it("shows completion fields, stale tentative estimates, a live pending state, and disables actions offline", async () => {
    const user = userEvent.setup();
    const onBump = vi.fn();
    render(<CharacterSheet snapshot={snapshot({ phase: "offline", tentative: { name: "Briar", health: { up: 1, down: 0 } }, entries: [{ id: "pending", actorId: "a", characterId: "character", sequence: 0, baseRevision: 1, packageChecksum: "checksum", createdAt: "2026-09-06T00:00:00Z", intent: { kind: "setField", fieldId: "name", value: "Briar" }, attempt: null }] })} onSetField={vi.fn()} onBump={onBump} onExecuteAction={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Complete Your Character" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Changes pending");
    expect(screen.getAllByDisplayValue("Briar")).toHaveLength(3);
    expect(screen.getByText("Validation is based on saved values.")).toBeVisible();
    expect(screen.getByText("5 / 6")).toBeVisible();
    expect(screen.getByRole("button", { name: "Roll check" })).toBeDisabled();

    await user.tab();
    expect(document.activeElement).toBe(screen.getAllByRole("textbox")[0]);
    await user.click(screen.getByRole("button", { name: "Increase Health" }));
    expect(onBump).toHaveBeenCalledWith("health", "up");
  });

  it("renders the server-returned roll result without predicting action effects", () => {
    render(<CharacterSheet snapshot={snapshot({ lastRoll: { actionId: "roll-check", expression: "d20 + 2", dice: [{ sides: 20, value: 14, kept: true }], bindings: [{ scope: "inputs", definitionId: "bonus", value: 2 }], total: 16, output: "Success", audience: "owner_only" } })} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Roll result" })).toBeVisible();
    expect(screen.getByText("d20 + 2")).toBeVisible();
    expect(screen.getByText("16")).toBeVisible();
    expect(screen.getByText("Success")).toBeVisible();
    expect(screen.getByText("Owner only")).toBeVisible();
    expect(screen.queryByText("d20=14")).not.toBeInTheDocument();
  });

  it("shows roll dice and bindings only when details are requested", async () => {
    const user = userEvent.setup();
    render(<CharacterSheet snapshot={snapshot({ lastRoll: { actionId: "roll-check", expression: "d20 + 2", dice: [{ sides: 20, value: 14, kept: true }], bindings: [{ scope: "inputs", definitionId: "bonus", value: 2 }], total: 16, output: "Success", audience: "owner_only" } })} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Show roll details" }));
    expect(screen.getByText("d20=14")).toBeVisible();
    expect(screen.getByText("inputs.bonus: 2")).toBeVisible();
  });

  it("explains why actions are unavailable and preserves resource-bump actions", async () => {
    const user = userEvent.setup();
    const onExecuteAction = vi.fn();
    render(<CharacterSheet snapshot={snapshot({ phase: "offline" })} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={onExecuteAction} />);
    expect(screen.getByText("Actions require an online connection.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Rest" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Rest" }));
    expect(onExecuteAction).not.toHaveBeenCalled();
  });

  it("submits a resource-bump action without predicting its effect", async () => {
    const user = userEvent.setup();
    const onExecuteAction = vi.fn();
    render(<CharacterSheet snapshot={snapshot()} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={onExecuteAction} />);
    await user.click(screen.getByRole("button", { name: "Rest" }));
    expect(onExecuteAction).toHaveBeenCalledWith("rest", {});
  });

  it("describes read-only and archived action restrictions to assistive technology", () => {
    const { rerender } = render(<CharacterSheet snapshot={snapshot({ editing: { owned: false } })} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    const readOnlyAction = screen.getByRole("button", { name: "Roll check" });
    expect(screen.getByText("Actions are unavailable while this character is read-only.")).toBeVisible();
    expect(readOnlyAction).toHaveAttribute("aria-describedby", "character-action-unavailable");

    rerender(<CharacterSheet snapshot={snapshot({ confirmed: { ...snapshot().confirmed!, lifecycle: "archived" } })} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    expect(screen.getByText("Actions are unavailable while this character is archived.")).toBeVisible();
  });

  it("labels unavailable completion metadata instead of treating it as an empty list", () => {
    const state = snapshot();
    delete state.confirmed!.projection.completionFields;
    render(<CharacterSheet snapshot={state} onSetField={vi.fn()} onBump={vi.fn()} onExecuteAction={vi.fn()} />);
    expect(screen.getByText("Completion fields are unavailable until this character refreshes.")).toBeVisible();
  });
});
