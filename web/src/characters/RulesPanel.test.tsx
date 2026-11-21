import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RulesPanel } from "./RulesPanel.js";

describe("RulesPanel", () => {
  it("lists the tables on request, loads one and searches its records", async () => {
    const user = userEvent.setup();
    const referenceDataset = vi.fn(async () => ({ dataset: { datasetId: "conditions", label: "Conditions", records: [
      { id: "blinded", label: "Blinded", values: { description: "A blinded creature can't see." } },
      { id: "prone", label: "Prone", values: { description: "A prone creature can only crawl." } },
    ] } }));
    const api = {
      referenceData: vi.fn(async () => ({ datasets: [{ datasetId: "conditions", label: "Conditions", records: 2 }] })),
      referenceDataset,
    };
    render(<RulesPanel characterId="c1" api={api} />);
    await user.click(screen.getByRole("button", { name: "Show rules tables" }));
    await user.selectOptions(await screen.findByTestId("rules-panel-table"), "conditions");
    expect(referenceDataset).toHaveBeenCalledWith("c1", "conditions");
    expect(await screen.findByText("Blinded")).toBeVisible();
    await user.type(screen.getByTestId("rules-panel-search"), "crawl");
    expect(screen.queryByText("Blinded")).not.toBeInTheDocument();
    expect(screen.getByText("Prone")).toBeVisible();
  });

  it("reports a failed load", async () => {
    const user = userEvent.setup();
    render(<RulesPanel characterId="c1" api={{ referenceData: async () => { throw new Error("offline"); }, referenceDataset: async () => { throw new Error("offline"); } }} />);
    await user.click(screen.getByRole("button", { name: "Show rules tables" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
  });
});
