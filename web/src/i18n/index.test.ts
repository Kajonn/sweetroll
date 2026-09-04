import { describe, expect, it, vi } from "vitest";
import { t, registerLocale, resetLocale } from "./index.js";

describe("t", () => {
  it("returns the default English string for a known id", () => {
    expect(t("library.title")).toBe("Library");
  });

  it("warns and returns the key when missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetLocale();
    expect(t("nope.missing")).toBe("nope.missing");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("interpolates params", () => {
    registerLocale({ "editor.publish.disabled.reason": "Cannot publish ({diagnostics} diagnostics)" });
    expect(t("editor.publish.disabled.reason", { diagnostics: 3 })).toBe("Cannot publish (3 diagnostics)");
  });
});