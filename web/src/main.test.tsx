import { beforeAll, describe, expect, it, vi } from "vitest";

import { THEME_STORAGE_KEY } from "./theme/theme.js";

// Startup wiring must stay hermetic: the real router would boot the whole
// route tree, so the test boots main.tsx with a stubbed router and asserts
// the theme.ts contract (data-theme + colorScheme now, cross-tab storage
// sync while mounted).
vi.mock("./router.js", () => ({ router: { id: "stub-router" } }));
vi.mock("@tanstack/react-router", () => ({ RouterProvider: () => null }));

beforeAll(async () => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
  document.body.innerHTML = '<div id="root"></div>';
  await import("./main.js");
});

describe("main startup theme wiring", () => {
  it("applies the stored preference at startup, including colorScheme", () => {
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("stays in sync with cross-tab storage updates", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
