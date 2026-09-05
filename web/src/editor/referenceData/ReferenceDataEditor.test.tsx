import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ReferenceDataEditor,
  type ReferenceDataV1,
} from "./ReferenceDataEditor.js";

function makeRecord(
  id: string,
  label: string,
  values: Record<string, string | number | boolean | null> = {},
) {
  return { id, label, values };
}

const defaultReferenceData: ReferenceDataV1 = {
  id: "skills",
  label: "Skills",
  records: [
    makeRecord("skill_stealth", "Stealth", { stat: "dex", cost: 2 }),
    makeRecord("skill_athletics", "Athletics", { stat: "str", cost: 1 }),
  ],
};

type RenderOptions = {
  referenceData?: ReferenceDataV1;
  disabled?: boolean;
};

function renderEditor(options: RenderOptions = {}) {
  const { referenceData: initial = defaultReferenceData, disabled } = options;
  const onChange = vi.fn();
  const view = render(
    <ReferenceDataEditor
      referenceData={initial}
      onChange={onChange}
      disabled={disabled}
    />,
  );
  return { ...view, onChange };
}

function lastCallPayload(
  onChange: ReturnType<typeof vi.fn>,
): ReferenceDataV1 | undefined {
  const calls = onChange.mock.calls;
  return calls[calls.length - 1]?.[0];
}

describe("ReferenceDataEditor", () => {
  it("renders the typeId header and label control", () => {
    renderEditor();
    const section = screen.getByTestId("reference-data-skills");
    expect(section).toBeInTheDocument();
    expect(screen.getByTestId("reference-data-typeId-skills")).toHaveTextContent(
      "skills",
    );
    expect(screen.getByTestId("reference-data-label-skills")).toHaveValue(
      "Skills",
    );
  });

  it("renders each record with id, label, and values", () => {
    renderEditor();
    expect(screen.getByTestId("reference-data-records-skills")).toBeInTheDocument();
    expect(
      screen.getByTestId("reference-data-record-skill_stealth"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("reference-data-record-id-skill_stealth")).toHaveValue(
      "skill_stealth",
    );
    expect(
      screen.getByTestId("reference-data-record-label-skill_stealth"),
    ).toHaveValue("Stealth");
    const valuesEl = screen.getByTestId(
      "reference-data-record-values-skill_stealth",
    ) as HTMLTextAreaElement;
    expect(valuesEl.value).toContain('"cost"');
  });

  it("renders an empty state when there are no records", () => {
    renderEditor({
      referenceData: { id: "skills", label: "Skills", records: [] },
    });
    expect(
      screen.getByTestId("reference-data-records-empty-skills"),
    ).toBeInTheDocument();
  });

  it("adds a new record when 'Add record' is clicked", () => {
    const { onChange } = renderEditor();
    fireEvent.click(screen.getByTestId("reference-data-records-add-skills"));
    const last = lastCallPayload(onChange);
    expect(last?.records).toHaveLength(3);
    expect(last?.records[2]?.id).toBe("record_1");
    expect(last?.records[2]?.label).toBe("");
    expect(last?.records[2]?.values).toEqual({});
  });

  it("picks the next free record id when adding", () => {
    const { onChange } = renderEditor({
      referenceData: {
        id: "skills",
        label: "Skills",
        records: [makeRecord("record_1", "Existing")],
      },
    });
    fireEvent.click(screen.getByTestId("reference-data-records-add-skills"));
    const last = lastCallPayload(onChange);
    expect(last?.records).toHaveLength(2);
    expect(last?.records[1]?.id).toBe("record_2");
  });

  it("removes a record when its remove button is clicked", () => {
    const { onChange } = renderEditor();
    fireEvent.click(
      screen.getByTestId("reference-data-record-remove-skill_stealth"),
    );
    const last = lastCallPayload(onChange);
    expect(last?.records).toHaveLength(1);
    expect(last?.records[0]?.id).toBe("skill_athletics");
  });

  it("commits label changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("reference-data-label-skills"), {
      target: { value: "Skill list" },
    });
    const last = lastCallPayload(onChange);
    expect(last?.label).toBe("Skill list");
    expect(last?.records).toEqual(defaultReferenceData.records);
  });

  it("commits record id changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(screen.getByTestId("reference-data-record-id-skill_stealth"), {
      target: { value: "skill_sneak" },
    });
    const last = lastCallPayload(onChange);
    expect(last?.records[0]?.id).toBe("skill_sneak");
    expect(last?.records[1]?.id).toBe("skill_athletics");
  });

  it("commits record label changes through onChange", () => {
    const { onChange } = renderEditor();
    fireEvent.change(
      screen.getByTestId("reference-data-record-label-skill_stealth"),
      { target: { value: "Sneaking" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.records[0]?.label).toBe("Sneaking");
    expect(last?.records[0]?.id).toBe("skill_stealth");
  });

  it("commits values changes parsed from JSON through onChange", () => {
    const { onChange } = renderEditor({
      referenceData: {
        id: "skills",
        label: "Skills",
        records: [makeRecord("skill_stealth", "Stealth", {})],
      },
    });
    fireEvent.change(
      screen.getByTestId("reference-data-record-values-skill_stealth"),
      { target: { value: '{"cost": 5, "stat": "dex"}' } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.records[0]?.values).toEqual({ cost: 5, stat: "dex" });
  });

  it("ignores values changes that are not valid JSON", () => {
    const { onChange } = renderEditor({
      referenceData: {
        id: "skills",
        label: "Skills",
        records: [makeRecord("skill_stealth", "Stealth", { cost: 2 })],
      },
    });
    fireEvent.change(
      screen.getByTestId("reference-data-record-values-skill_stealth"),
      { target: { value: "not json" } },
    );
    const last = lastCallPayload(onChange);
    expect(last?.records[0]?.values).toEqual({});
  });

  it("disables every control when disabled=true", () => {
    renderEditor({ disabled: true });
    expect(screen.getByTestId("reference-data-label-skills")).toBeDisabled();
    expect(
      screen.getByTestId("reference-data-record-id-skill_stealth"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("reference-data-record-label-skill_stealth"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("reference-data-record-values-skill_stealth"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("reference-data-record-remove-skill_stealth"),
    ).toBeDisabled();
    expect(screen.getByTestId("reference-data-records-add-skills")).toBeDisabled();
  });
});
