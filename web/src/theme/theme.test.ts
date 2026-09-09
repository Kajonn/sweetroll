import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  THEME_STORAGE_KEY,
  applyTheme,
  getStoredPreference,
  initTheme,
  normalizePreference,
  persistPreference,
  resolvePreference,
  resolveStoredTheme,
} from "./theme.js";

function clearThemeState(): void {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  window.localStorage.clear();
}

beforeEach(() => {
  clearThemeState();
});

afterEach(() => {
  clearThemeState();
  vi.unstubAllGlobals();
});

describe("normalizePreference", () => {
  it.each([["light"], ["dark"], ["system"]])("keeps %s", (value) => {
    expect(normalizePreference(value)).toBe(value);
  });

  it.each([["sepia"], [""], [[null]], [[undefined]], [[42]], [[null]]])(
    "falls back to Follow-device for %s",
    (value) => {
      expect(normalizePreference(value)).toBe("system");
    },
  );
});

describe("resolvePreference", () => {
  it("passes explicit choices through regardless of the OS setting", () => {
    expect(resolvePreference("light", true)).toBe("light");
    expect(resolvePreference("light", false)).toBe("light");
    expect(resolvePreference("dark", true)).toBe("dark");
    expect(resolvePreference("dark", false)).toBe("dark");
  });

  it("follows the device for the system preference", () => {
    expect(resolvePreference("system", true)).toBe("dark");
    expect(resolvePreference("system", false)).toBe("light");
  });
});

describe("getStoredPreference", () => {
  it("reads the persisted device preference from localStorage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(getStoredPreference()).toBe("dark");
  });

  it("defaults to Follow-device when nothing is stored", () => {
    expect(getStoredPreference()).toBe("system");
  });

  it("defaults to Follow-device for unknown stored values", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "tablefolk");
    expect(getStoredPreference()).toBe("system");
  });

  it("defaults to Follow-device when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(getStoredPreference(broken)).toBe("system");
  });
});

describe("applyTheme", () => {
  it("applies the resolved theme to the document element only", () => {
    const before = document.getElementById("root")?.innerHTML;
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.getElementById("root")?.innerHTML).toBe(before);
  });

  it("reflects the resolved color scheme for native controls", () => {
    applyTheme("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("persistPreference", () => {
  it("persists the device preference and applies the resolved theme", () => {
    const resolved = persistPreference("dark");
    expect(resolved).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("normalizes unknown values to Follow-device before persisting", () => {
    const resolved = persistPreference("tablefolk" as "dark");
    expect(resolved).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });
});

describe("resolveStoredTheme", () => {
  it("combines the stored preference with the OS setting", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(resolveStoredTheme()).toBe("dark");
  });
});

describe("initTheme", () => {
  function stubDevice(matches: boolean) {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    const media = {
      matches,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn((_type: string, listener: (event: { matches: boolean }) => void) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((listener: (event: { matches: boolean }) => void) => {
        void listener;
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatcher: (next: boolean) => {
        for (const listener of listeners) listener({ matches: next });
      },
    };
    vi.stubGlobal("matchMedia", vi.fn(() => media));
    return media;
  }

  it("applies the stored preference on init", () => {
    stubDevice(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const stop = initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    stop();
  });

  it("follows OS changes only while the preference is Follow-device", () => {
    const media = stubDevice(false);
    const stop = initTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    media.dispatcher(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    persistPreference("light");
    media.dispatcher(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    stop();
  });

  it("unsubscribes OS and storage listeners on cleanup", () => {
    const media = stubDevice(false);
    const removeEventListener = vi.spyOn(window, "removeEventListener");
    const stop = initTheme();
    stop();
    expect(media.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("storage", expect.any(Function));
  });
});
