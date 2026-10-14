import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SheetEditor } from "./SheetEditor.js";

const sheet = {
  id: "sheet_1", label: "Character", targetEntityId: "character",
  sections: [{id:"section_1", label:"Stats", elements:[{kind:"field" as const,id:"element_1",fieldId:"strength"}]}],
};

describe("sheet reference selection", () => {
  it("shows entities by label and persists a stable entity ID", () => {
    const onChange = vi.fn();
    render(<SheetEditor sheet={sheet} onChange={onChange} entities={[{id:"character",label:"Character"},{id:"monster",label:"Monster"}]} />);
    fireEvent.change(screen.getByTestId("sheet-target-entity"), {target:{value:"monster"}});
    expect(onChange.mock.lastCall?.[0].targetEntityId).toBe("monster");
  });

  it("lists existing definitions, including those already placed", () => {
    const onChange = vi.fn();
    render(<SheetEditor sheet={sheet} onChange={onChange} allDefinitions={[
      {kind:"field",id:"strength",label:"Strength"},
      {kind:"field",id:"dexterity",label:"Dexterity"},
    ]} />);
    const selector = screen.getByTestId("definition-reference-select");
    expect(within(selector).getByRole("option",{name:"Strength (strength)"})).toBeInTheDocument();
    fireEvent.change(selector,{target:{value:"dexterity"}});
    expect(onChange.mock.lastCall?.[0].sections[0].elements[0].fieldId).toBe("dexterity");
  });

  it("preserves an unresolved ID instead of silently changing data", () => {
    render(<SheetEditor sheet={{...sheet,sections:[{...sheet.sections[0]!,elements:[{kind:"field",id:"element_1",fieldId:"deleted"}]}]}} onChange={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("deleted");
  });
});
