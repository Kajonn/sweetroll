import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { FieldV1 } from "../../state/documentFieldTypes.js";
import type { ReferenceDataV1 } from "../referenceData/ReferenceDataEditor.js";
import { ChoiceFieldEditor } from "./ChoiceFieldEditor.js";

const dataset: ReferenceDataV1 = {
  id: "ranks", label: "Ranks", records: [{ id: "rookie", label: "Rookie", values: {} }],
};

function Editor({ datasets }: { datasets: ReferenceDataV1[] }) {
  const [field, setField] = useState<FieldV1>({
    kind: "singleChoice", id: "rank", label: "Rank", required: false,
    default: "rookie", options: [], optionsFrom: dataset.id,
  });
  return <ChoiceFieldEditor field={field} onChange={setField} datasets={datasets} />;
}

describe("ChoiceFieldEditor", () => {
  it("allows manual options after the last dataset is deleted", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Editor datasets={[dataset]} />);
    expect(screen.getByRole("combobox", { name: "Options source" })).toHaveValue("ranks");

    rerender(<Editor datasets={[]} />);
    const source = screen.getByRole("combobox", { name: "Options source" });
    expect(source).toHaveValue("ranks");
    expect(screen.getByRole("option", { name: "Missing dataset (ranks)" })).toBeDisabled();

    await user.selectOptions(source, "Manual options");
    await user.click(screen.getByTestId("choice-field-add-option-rank"));
    expect(screen.getByTestId("choice-field-option-label-0-rank")).toBeEnabled();
  });
});
