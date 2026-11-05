import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScalarFieldEditor } from "./fields/ScalarFieldEditor.js";
import { StatusBar } from "../shell/StatusBar.js";
import { setDebugMode } from "../ui/debugMode.js";
import { SheetEditor } from "./sheet/SheetEditor.js";
import { DiagnosticsDrawer } from "./DiagnosticsDrawer.js";
import { MetadataEditor } from "./MetadataEditor.js";
import { blankDocument } from "../state/documentReducer.js";

afterEach(() => { act(() => setDebugMode(false)); localStorage.clear(); });

describe("technical metadata disclosure", () => {
  it("starts metadata with the system name and keeps appearance choices available on request", () => {
    render(<MetadataEditor document={blankDocument()} onChange={vi.fn()} />);
    expect(screen.getByTestId("metadata-name")).toBeVisible();
    expect(screen.getByLabelText("System colors")).not.toBeVisible();
    fireEvent.click(screen.getByText("Appearance"));
    expect(screen.getByLabelText("System colors")).toBeVisible();
  });
  it("keeps offline status visible while hiding the browser trace in normal mode", () => {
    render(<StatusBar online={false} requestId="browser-trace-uuid" />);
    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.queryByText("browser-trace-uuid")).not.toBeInTheDocument();
    act(() => setDebugMode(true));
    expect(screen.getByText(/browser-trace-uuid/)).toBeVisible();
  });

  it("hides generated IDs, preserves stable values and disambiguates duplicate labels", () => {
    const onChange = vi.fn();
    render(<SheetEditor onChange={onChange} sheet={{ id: "sheet_secret", label: "Hero", targetEntityId: "hero", sections: [{ id: "section_secret", label: "Stats", elements: [{ kind: "field", id: "element_secret", fieldId: "str" }] }] }} entities={[{ id: "hero", label: "Hero" }]} allDefinitions={[{ kind: "field", id: "str", label: "Strength" }, { kind: "field", id: "other_str", label: "Strength" }, { kind: "field", id: "dex", label: "Dexterity" }]} />);
    expect(screen.queryByText(/ID: sheet_secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/id: section_secret/i)).not.toBeInTheDocument();
    const select = screen.getByTestId("definition-reference-select");
    expect(within(select).getByRole("option", { name: "Dexterity" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Strength (str)" })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: "dex" } });
    expect(onChange.mock.lastCall?.[0].sections[0].elements[0].fieldId).toBe("dex");
    act(() => setDebugMode(true));
    expect(screen.getByText("ID: sheet_secret")).toBeVisible();
    expect(screen.getAllByText(/id: section_secret/i)).toHaveLength(1);
    expect(within(select).getByRole("option", { name: "Dexterity (dex)" })).toBeInTheDocument();
  });

  it("keeps actionable validation messages available without technical paths or codes", () => {
    render(<DiagnosticsDrawer assessment={{ ok: false, diagnostics: [{ code: "missing_reference", path: "/entities/0/fields/0", message: "Choose an existing attribute." }] } as any} />);
    expect(screen.getByText("Choose an existing attribute.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Jump to" })).toBeVisible();
    expect(screen.queryByText("missing_reference")).not.toBeInTheDocument();
    expect(screen.queryByText("/entities/0/fields/0")).not.toBeInTheDocument();
    act(() => setDebugMode(true));
    expect(screen.getByText("missing_reference")).toBeVisible();
    expect(screen.getByText("/entities/0/fields/0")).toBeVisible();
  });
  it("keeps labels and defaults visible while preserving collapsed constraints", () => {
    const onChange = vi.fn();
    render(<ScalarFieldEditor field={{ kind: "integer", id: "strength", label: "Strength", default: 10, required: true, min: 1, max: 20, step: 1 }} onChange={onChange} />);
    expect(screen.getByTestId("scalar-field-label-strength")).toBeVisible();
    expect(screen.getByTestId("scalar-field-default-strength")).toBeVisible();
    expect(screen.getByTestId("scalar-field-min-strength")).not.toBeVisible();
    expect(screen.getByTestId("definition-id-input")).not.toBeVisible();
    fireEvent.click(screen.getByText("Validation and limits"));
    expect(screen.getByTestId("scalar-field-min-strength")).toBeVisible();
    fireEvent.change(screen.getByTestId("scalar-field-min-strength"), { target: { value: "2" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: "strength", min: 2, max: 20, default: 10 }));
  });

});
