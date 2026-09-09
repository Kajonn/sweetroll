import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  d20Package,
} from "../../../src/systems/implementation/package/fixtures/index.js";
import type { SystemPackageV1 } from "../../../src/systems/implementation/package/schema/index.js";

import { generateSample } from "./sampleData.js";
import { PreviewFrame } from "./PreviewFrame.js";
import { PreviewSheet } from "./PreviewSheet.js";

function asPackage(pkg: unknown): SystemPackageV1 {
  return pkg as SystemPackageV1;
}

function renderD20() {
  const pkg = asPackage(d20Package);
  const sample = generateSample(pkg);
  return render(<PreviewSheet pkg={pkg} sample={sample} />);
}

describe("PreviewSheet", () => {
  describe("d20 fixture rendering", () => {
    it("renders the character sheet as a single-column layout", () => {
      renderD20();
      expect(screen.getByTestId("preview-sheet-character_sheet")).toBeInTheDocument();
      expect(screen.getByTestId("preview-section-basics")).toBeInTheDocument();
      expect(screen.getByTestId("preview-section-abilities")).toBeInTheDocument();
      expect(screen.getByTestId("preview-section-combat")).toBeInTheDocument();
    });

    it("renders every section heading as a level-2 heading with the declared text", () => {
      renderD20();
      expect(
        screen.getByRole("heading", { level: 2, name: "Basics" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 2, name: "Abilities" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { level: 2, name: "Combat" }),
      ).toBeInTheDocument();
    });

    it("renders the bound field for ancestry with the choice label 'Human'", () => {
      renderD20();
      const field = screen.getByTestId("preview-field-ancestry_element");
      expect(within(field).getByTestId("preview-field-label-ancestry_element"))
        .toHaveTextContent("Ancestry");
      expect(within(field).getByTestId("preview-field-value-ancestry_element"))
        .toHaveTextContent("Human");
    });

    it("renders the bound field for ability with the sample integer value 10", () => {
      renderD20();
      const field = screen.getByTestId("preview-field-ability_element");
      expect(within(field).getByTestId("preview-field-value-ability_element"))
        .toHaveTextContent("10");
    });

    it("renders the bound field for modifier with the sample integer value 0", () => {
      renderD20();
      const field = screen.getByTestId("preview-field-modifier_element");
      expect(within(field).getByTestId("preview-field-value-modifier_element"))
        .toHaveTextContent("0");
    });

    it("renders the bound field for defense with the evaluated computed value 10", () => {
      renderD20();
      const field = screen.getByTestId("preview-field-defense_element");
      expect(within(field).getByTestId("preview-field-value-defense_element"))
        .toHaveTextContent("10");
    });

    it("renders the bound resource for health with current/max = 30/30", () => {
      renderD20();
      const resource = screen.getByTestId("preview-resource-health_element");
      expect(within(resource).getByTestId("preview-resource-label-health_element"))
        .toHaveTextContent("Health");
      expect(within(resource).getByTestId("preview-resource-current-health_element"))
        .toHaveTextContent("30");
      expect(within(resource).getByTestId("preview-resource-max-health_element"))
        .toHaveTextContent("30");
    });

    it("renders the action button with the declared roll action label 'Check'", () => {
      renderD20();
      const action = screen.getByTestId("preview-action-check_element");
      expect(action).toBeInTheDocument();
      expect(action).toHaveTextContent("Check");
    });
  });

  describe("action button -> roll result", () => {
    it("opens a compact roll-result sheet when the action button is clicked", async () => {
      const user = userEvent.setup();
      renderD20();
      await user.click(screen.getByTestId("preview-action-check_element"));
      const sheet = screen.getByTestId("preview-roll-result-check");
      expect(sheet).toBeInTheDocument();
      expect(within(sheet).getByTestId("preview-roll-result-expression"))
        .toBeInTheDocument();
      expect(within(sheet).getByTestId("preview-roll-result-total"))
        .toBeInTheDocument();
    });

    it("uses 'Preview' as the roll-result audience", async () => {
      const user = userEvent.setup();
      renderD20();
      await user.click(screen.getByTestId("preview-action-check_element"));
      const sheet = screen.getByTestId("preview-roll-result-check");
      expect(within(sheet).getByTestId("preview-roll-result-audience"))
        .toHaveTextContent("Preview");
    });

    it("closes the compact sheet when the close button is clicked", async () => {
      const user = userEvent.setup();
      renderD20();
      await user.click(screen.getByTestId("preview-action-check_element"));
      expect(screen.getByTestId("preview-roll-result-check")).toBeInTheDocument();
      await user.click(screen.getByTestId("preview-roll-result-close"));
      expect(screen.queryByTestId("preview-roll-result-check")).not.toBeInTheDocument();
    });
  });

  describe("PreviewFrame", () => {
    function renderInFrame(initialWidth?: 360 | 1280) {
      const pkg = asPackage(d20Package);
      const sample = generateSample(pkg);
      return render(
        <PreviewFrame initialWidth={initialWidth}>
          <PreviewSheet pkg={pkg} sample={sample} />
        </PreviewFrame>,
      );
    }

    it("defaults to the 360 px width", () => {
      renderInFrame();
      const frame = screen.getByTestId("preview-frame");
      expect(frame).toHaveAttribute("data-width", "360");
      expect(screen.getByTestId("preview-frame-container")).toHaveAttribute("data-width", "360");
    });

    it("honors the initialWidth prop", () => {
      renderInFrame(1280);
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "1280");
      expect(screen.getByTestId("preview-frame-container")).toHaveAttribute("data-width", "1280");
    });

    it("toggles the width when the toggle button is clicked", async () => {
      const user = userEvent.setup();
      renderInFrame();
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "360");
      await user.click(screen.getByTestId("preview-frame-toggle"));
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "1280");
      await user.click(screen.getByTestId("preview-frame-toggle"));
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "360");
    });

    it("toggles the width when Alt+P is pressed", async () => {
      const user = userEvent.setup();
      renderInFrame();
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "360");
      await user.keyboard("{Alt>}p{/Alt}");
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "1280");
      await user.keyboard("{Alt>}p{/Alt}");
      expect(screen.getByTestId("preview-frame")).toHaveAttribute("data-width", "360");
    });

    it("renders the sheet content inside the frame container", () => {
      renderInFrame();
      const container = screen.getByTestId("preview-frame-container");
      expect(within(container).getByTestId("preview-sheet-character_sheet"))
        .toBeInTheDocument();
    });

    it("nests an exact-width canvas inside a scrolling viewport", () => {
      renderInFrame();
      const viewport = screen.getByTestId("preview-frame-viewport");
      const canvas = screen.getByTestId("preview-frame-container");
      expect(viewport).toContainElement(canvas);
      expect(canvas).toHaveStyle({ width: "360px" });
    });

    it("displays the Alt+P shortcut label", () => {
      renderInFrame();
      expect(screen.getByTestId("preview-frame-shortcut")).toHaveTextContent("Alt+P");
    });
  });
});
