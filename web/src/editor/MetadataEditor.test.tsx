import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SystemDocumentV1 } from "../state/documentReducer.js";
import { MetadataEditor } from "./MetadataEditor.js";

function docWithName(name: string): SystemDocumentV1 {
  return {
    schemaVersion: "1.0",
    metadata: { name, description: "d", language: "en", defaultDice: "d20" },
    entities: [],
    referenceData: [],
    sheets: [],
    expressions: [],
    actions: [],
    validations: [],
  };
}

describe("MetadataEditor", () => {
  it("renders the four metadata fields from the document", () => {
    render(
      <MetadataEditor
        document={{
          schemaVersion: "1.0",
          metadata: {
            name: "Pocket Quest",
            description: "A brave little game",
            language: "en",
            defaultDice: "d20",
          },
          entities: [],
          referenceData: [],
          sheets: [],
          expressions: [],
          actions: [],
          validations: [],
        }}
      />,
    );
    expect(screen.getByTestId("metadata-name")).toHaveValue("Pocket Quest");
    expect(screen.getByTestId("metadata-description")).toHaveValue("A brave little game");
    expect(screen.getByTestId("metadata-language")).toHaveValue("en");
    expect(screen.getByTestId("metadata-default-dice")).toHaveValue("d20");
  });

  it("updates local state when the user types in a field", async () => {
    const user = userEvent.setup();
    render(
      <MetadataEditor
        document={{
          schemaVersion: "1.0",
          metadata: { name: "", description: "", language: "en", defaultDice: "d20" },
          entities: [],
          referenceData: [],
          sheets: [],
          expressions: [],
          actions: [],
          validations: [],
        }}
      />,
    );

    await user.type(screen.getByTestId("metadata-name"), "Cairn");
    await user.type(screen.getByTestId("metadata-description"), "Into the odd");
    await user.clear(screen.getByTestId("metadata-language"));
    await user.type(screen.getByTestId("metadata-language"), "fr");
    await user.clear(screen.getByTestId("metadata-default-dice"));
    await user.type(screen.getByTestId("metadata-default-dice"), "2d6");

    expect(screen.getByTestId("metadata-name")).toHaveValue("Cairn");
    expect(screen.getByTestId("metadata-description")).toHaveValue("Into the odd");
    expect(screen.getByTestId("metadata-language")).toHaveValue("fr");
    expect(screen.getByTestId("metadata-default-dice")).toHaveValue("2d6");
  });

  it("calls onChange with the full document on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <MetadataEditor
        document={{
          schemaVersion: "1.0",
          metadata: { name: "", description: "", language: "en", defaultDice: "d20" },
          entities: [],
          referenceData: [],
          sheets: [],
          expressions: [],
          actions: [],
          validations: [],
        }}
        onChange={onChange}
      />,
    );

    const nameInput = screen.getByTestId("metadata-name");
    await user.type(nameInput, "X");
    nameInput.blur();

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]?.[0];
    expect(next?.metadata.name).toBe("X");
    expect(next?.metadata.defaultDice).toBe("d20");
  });

  it("does not call onChange when no edits were made", async () => {
    const onChange = vi.fn();
    const document = {
      schemaVersion: "1.0" as const,
      metadata: { name: "Untouched", description: "d", language: "en", defaultDice: "d20" },
      entities: [],
      referenceData: [],
      sheets: [],
      expressions: [],
      actions: [],
      validations: [],
    };
    render(<MetadataEditor document={document} onChange={onChange} />);
    screen.getByTestId("metadata-name").blur();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adopts a refreshed server document in visible inputs when clean", () => {
    const { rerender } = render(<MetadataEditor document={docWithName("Server v1")} />);
    expect(screen.getByTestId("metadata-name")).toHaveValue("Server v1");
    rerender(<MetadataEditor document={docWithName("Server v2")} />);
    expect(screen.getByTestId("metadata-name")).toHaveValue("Server v2");
  });

  it("preserves unflushed local edits when a server refresh arrives", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MetadataEditor document={docWithName("Server v1")} />);
    await user.type(screen.getByTestId("metadata-name"), " + local");
    rerender(<MetadataEditor document={docWithName("Server v2")} />);
    expect(screen.getByTestId("metadata-name")).toHaveValue("Server v1 + local");
  });
});
