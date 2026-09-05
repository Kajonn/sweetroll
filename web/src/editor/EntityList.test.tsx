import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { EntityList } from "./EntityList.js";
import type { FieldV1 } from "../state/documentFieldTypes.js";

function makeEntity(id: string, label: string, fields: FieldV1[] = []) {
  return { id, label, fields };
}

type Entity = ReturnType<typeof makeEntity>;

function ControlledList({
  initial,
  onChange,
  initialSelectedEntityId,
  ...rest
}: {
  initial: Entity[];
  onChange?: (next: Entity[]) => void;
  initialSelectedEntityId?: string | null;
} & Partial<React.ComponentProps<typeof EntityList>>) {
  const [entities, setEntities] = useState<Entity[]>(initial);
  const [selected, setSelected] = useState<string | null>(
    initialSelectedEntityId ?? initial[0]?.id ?? null,
  );
  return (
    <EntityList
      entities={entities}
      onChange={(next) => {
        setEntities(next);
        onChange?.(next);
      }}
      selectedEntityId={selected}
      onSelectEntity={setSelected}
      {...rest}
    />
  );
}

function renderList(
  entities: Entity[],
  overrides: Partial<React.ComponentProps<typeof EntityList>> = {},
) {
  const onChange = vi.fn();
  const view = render(
    <ControlledList initial={entities} onChange={onChange} {...overrides} />,
  );
  return { ...view, onChange };
}

describe("EntityList", () => {
  it("renders an empty state when there are no entities", () => {
    renderList([]);
    expect(screen.getByTestId("entity-list-empty")).toBeInTheDocument();
  });

  it("lists each entity with its label and field count", () => {
    renderList([
      makeEntity("character", "Character", [
        { kind: "text", id: "name", label: "Name", default: "", required: true, minLength: 0, maxLength: 120 } as FieldV1,
        { kind: "integer", id: "hp", label: "HP", default: 10, required: false, min: 0, max: 999, step: 1 } as FieldV1,
      ]),
      makeEntity("npc", "NPC", []),
    ]);
    expect(screen.getByTestId("entity-row-character")).toHaveTextContent("Character");
    expect(screen.getByTestId("entity-row-character")).toHaveTextContent(/2/);
    expect(screen.getByTestId("entity-row-npc")).toHaveTextContent("NPC");
    expect(screen.getByTestId("entity-row-npc")).toHaveTextContent(/0/);
  });

  it("calls onChange with a new entity when 'Add entity' is clicked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([]);
    await user.click(screen.getByTestId("entity-list-add"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ label: "Entity" });
    expect(next[0]?.fields).toEqual([]);
  });

  it("selects an entity when its row is clicked", async () => {
    const user = userEvent.setup();
    const onSelectEntity = vi.fn();
    render(
      <ControlledList
        initial={[
          makeEntity("character", "Character"),
          makeEntity("npc", "NPC"),
        ]}
        initialSelectedEntityId="character"
        onSelectEntity={onSelectEntity}
      />,
    );
    await user.click(screen.getByTestId("entity-row-npc-select"));
    expect(onSelectEntity).toHaveBeenCalledWith("npc");
  });

  it("opens a remove confirmation dialog when 'Remove' is clicked", async () => {
    const user = userEvent.setup();
    renderList([makeEntity("npc", "NPC")]);
    await user.click(screen.getByTestId("entity-row-npc-remove"));
    expect(screen.getByTestId("entity-remove-confirm")).toBeInTheDocument();
  });

  it("removes the entity after confirming the dialog", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([
      makeEntity("character", "Character"),
      makeEntity("npc", "NPC"),
    ]);
    await user.click(screen.getByTestId("entity-row-npc-select"));
    await user.click(screen.getByTestId("entity-row-npc-remove"));
    await user.click(screen.getByTestId("entity-remove-confirm-submit"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.map((e: { id: string }) => e.id)).toEqual(["character"]);
  });

  it("does not remove when the confirmation is cancelled", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([makeEntity("npc", "NPC")]);
    await user.click(screen.getByTestId("entity-row-npc-remove"));
    await user.click(screen.getByTestId("entity-remove-confirm-cancel"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders the selected entity's fields", () => {
    render(
      <ControlledList
        initial={[
          makeEntity("character", "Character", [
            {
              kind: "text",
              id: "name",
              label: "Name",
              default: "",
              required: true,
              minLength: 0,
              maxLength: 120,
            } as FieldV1,
          ]),
          makeEntity("npc", "NPC"),
        ]}
        initialSelectedEntityId="character"
      />,
    );
    expect(screen.getByTestId("scalar-field-name")).toBeInTheDocument();
  });

  it("dispatches field changes through onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([
      makeEntity("character", "Character", [
        {
          kind: "text",
          id: "name",
          label: "Name",
          default: "",
          required: true,
          minLength: 0,
          maxLength: 120,
        } as FieldV1,
      ]),
    ]);
    const input = screen.getByTestId("scalar-field-default-name");
    await user.type(input, "X");
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    const character = lastCall?.find((e: { id: string }) => e.id === "character");
    expect(character?.fields[0]?.default).toBe("X");
  });

  it("dispatches entity label changes through onChange", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([makeEntity("npc", "NPC")]);
    const input = screen.getByTestId("entity-label-input-npc");
    await user.clear(input);
    await user.type(input, "Foe");
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    const npc = lastCall?.find((e: { id: string }) => e.id === "npc");
    expect(npc?.label).toBe("Foe");
  });

  it("adds a new field via 'Add field'", async () => {
    const user = userEvent.setup();
    const { onChange } = renderList([makeEntity("character", "Character")]);
    await user.click(screen.getByTestId("entity-add-field-character"));
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
    const character = lastCall?.find((e: { id: string }) => e.id === "character");
    expect(character?.fields).toHaveLength(1);
    expect(character?.fields[0]?.kind).toBe("text");
  });
});
