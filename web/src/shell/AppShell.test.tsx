import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell } from "./AppShell.js";

describe("AppShell", () => {
  it("renders header, main, and footer landmarks", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("Online");
  });

  it("renders children in the main region", () => {
    render(<AppShell><span data-testid="child">x</span></AppShell>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});