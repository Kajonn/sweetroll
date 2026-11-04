import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "../ui/Dialog.js";
import { SystemPresentationScope } from "./SystemPresentation.js";
import { buildPreviewPackage } from "../editor/DocumentEditor.js";
import { blankDocument } from "../state/documentReducer.js";
import { MetadataEditor } from "../editor/MetadataEditor.js";

describe("system presentation scope", () => {
  it("updates a portal without remounting inputs or changing another system/global scope", () => {
    function Example({ preset }: { preset: "blue" | "ochre" }) {
      const [text, setText] = useState("");
      return <><div data-testid="global">Library</div><SystemPresentationScope presentation={{ colorPreset: preset }}><input aria-label="Uncommitted" value={text} onChange={e => setText(e.target.value)} /><Dialog title="System dialog" open onOpenChange={() => {}}>Details</Dialog></SystemPresentationScope><SystemPresentationScope presentation={{ colorPreset: "default" }}><span>Other system</span></SystemPresentationScope></>;
    }
    const view = render(<Example preset="blue" />);
    fireEvent.change(screen.getByLabelText("Uncommitted"), { target: { value: "kept" } });
    expect(screen.getByRole("dialog")).toHaveAttribute("data-system-preset", "blue");
    view.rerender(<Example preset="ochre" />);
    expect(screen.getByLabelText("Uncommitted")).toHaveValue("kept");
    expect(screen.getByRole("dialog")).toHaveAttribute("data-system-preset", "ochre");
    expect(screen.getByText("Other system").closest("[data-system-preset]")).toHaveAttribute("data-system-preset", "default");
    expect(screen.getByTestId("global").closest("[data-system-preset]")).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-system-preset");
  });

  it("keeps unflushed metadata when changing the creator preset and passes it to preview", () => {
    const emitted: unknown[] = [];
    const document = blankDocument();
    document.entities = [{ id: "hero", label: "Hero", fields: [] }];
    render(<MetadataEditor document={document} onChange={next => emitted.push(next)} />);
    fireEvent.change(screen.getByTestId("metadata-name"), { target: { value: "Still editing" } });
    fireEvent.change(screen.getByLabelText("System colors"), { target: { value: "blue" } });
    const next = emitted.at(-1) as typeof document;
    expect(next.metadata.name).toBe("Still editing");
    expect(next.metadata).toHaveProperty("presentation", { colorPreset: "blue" });
    expect(buildPreviewPackage(next)).toHaveProperty("presentation", { colorPreset: "blue" });
    fireEvent.click(screen.getByRole("button", { name: "Reset system colors" }));
    expect(emitted.at(-1)).toHaveProperty("metadata.presentation.colorPreset", "default");
  });
});
