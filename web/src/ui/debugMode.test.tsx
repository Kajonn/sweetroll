import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEBUG_MODE_KEY, DebugOnly, DebugSettings, setDebugMode } from "./debugMode.js";

describe("device debug presentation", () => {
  beforeEach(() => { localStorage.clear(); setDebugMode(false); });
  afterEach(() => { vi.restoreAllMocks(); act(() => setDebugMode(false)); localStorage.clear(); });

  it("defaults to hidden and updates every mounted surface without navigation", () => {
    render(<><DebugSettings /><DebugOnly><p>Internal revision 7</p></DebugOnly></>);
    expect(screen.queryByText("Internal revision 7")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Show debug information/ }));
    expect(screen.getByText("Internal revision 7")).toBeVisible();
    expect(localStorage.getItem(DEBUG_MODE_KEY)).toBe("true");
    fireEvent.click(screen.getByRole("checkbox", { name: /^Show debug information/ }));
    expect(screen.queryByText("Internal revision 7")).not.toBeInTheDocument();
  });

  it("restores a saved preference and reacts to another tab clearing it", () => {
    localStorage.setItem(DEBUG_MODE_KEY, "true");
    render(<><DebugSettings /><DebugOnly>Technical data</DebugOnly></>);
    expect(screen.getByText("Technical data")).toBeVisible();
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(screen.queryByText("Technical data")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("still works for the current tab when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    render(<><DebugSettings /><DebugOnly>Technical data</DebugOnly></>);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("Technical data")).toBeVisible();
  });
});
