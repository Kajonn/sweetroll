import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import { AccountThemeSection } from "../player/Account.js";
import {
  THEME_STORAGE_KEY,
  applyDeviceSelection,
  getDevicePreference,
  resolveTheme,
  toDevicePreference,
} from "./theme.js";
import { getPreferences, patchPreferences } from "./accountTheme.js";

function clearThemeState(): void {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  window.localStorage.clear();
}

beforeEach(() => {
  clearThemeState();
});

function apiError(status: number): ApiError {
  return new ApiError({
    code: status === 401 ? "unauthorized" : "internal",
    message: `Request failed: ${status}`,
    status,
    requestId: "r",
    latestRevision: null,
    diagnostics: [],
  });
}

function stubClient(options: {
  preferences?: unknown;
  failGetWith?: ApiError;
  savedValue?: unknown;
  failPatchWith?: ApiError;
}): { client: ApiClient; patches: Array<unknown> } {
  const patches: Array<unknown> = [];
  const client = {
    fetch: (async (method: string, path: string, init?: { body?: unknown }) => {
      expect(path).toBe("/me/preferences");
      if (method === "GET") {
        if (options.failGetWith !== undefined) throw options.failGetWith;
        return options.preferences ?? { theme_default: null };
      }
      if (method === "PATCH") {
        if (options.failPatchWith !== undefined) throw options.failPatchWith;
        patches.push(init?.body);
        const body = init?.body as { theme_default?: unknown };
        return { theme_default: options.savedValue ?? body?.theme_default ?? null };
      }
      throw new Error(`unexpected ${method} ${path}`);
    }) as ApiClient["fetch"],
  } as unknown as ApiClient;
  return { client, patches };
}

function renderSection(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AccountThemeSection client={client} />
    </QueryClientProvider>,
  );
  return qc;
}

const deviceSelect = () => screen.getByRole("combobox", { name: "Theme" });
const accountSelect = () => screen.getByRole("combobox", { name: "Account default" });

/** The account select renders disabled while loading; wait for the saved value. */
async function loadedAccountSelect(): Promise<HTMLElement> {
  await screen.findByRole("combobox", { name: "Account default" });
  await waitFor(() => expect(accountSelect()).toBeEnabled());
  return accountSelect();
}

describe("resolveTheme precedence (device > account > system)", () => {
  it.each([
    { device: "light" as const, account: "dark" as const, dark: true, expected: "light" },
    { device: "light" as const, account: "dark" as const, dark: false, expected: "light" },
    { device: "dark" as const, account: "light" as const, dark: false, expected: "dark" },
    { device: null, account: "dark" as const, dark: false, expected: "dark" },
    { device: null, account: "light" as const, dark: true, expected: "light" },
    { device: null, account: "system" as const, dark: true, expected: "dark" },
    { device: null, account: "system" as const, dark: false, expected: "light" },
    { device: null, account: null, dark: true, expected: "dark" },
    { device: null, account: null, dark: false, expected: "light" },
  ])(
    "device=$device account=$account osDark=$dark resolves $expected",
    ({ device, account, dark, expected }) => {
      expect(resolveTheme({ device, accountDefault: account, matchesDark: dark })).toBe(expected);
    },
  );
});

describe("device override reading", () => {
  it("maps an absent or Follow-device key to no override", () => {
    expect(getDevicePreference()).toBeNull();
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(getDevicePreference()).toBeNull();
  });

  it("passes explicit device choices through", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(getDevicePreference()).toBe("dark");
    expect(toDevicePreference("light")).toBe("light");
    expect(toDevicePreference("system")).toBeNull();
  });

  it("treats unknown stored values as no override", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");
    expect(getDevicePreference()).toBeNull();
  });

  it("applyDeviceSelection persists and applies the effective theme", () => {
    const resolved = applyDeviceSelection({ preference: "dark", accountDefault: "light", matchesDark: false });
    expect(resolved).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applyDeviceSelection with Follow-device reveals the account default", () => {
    const resolved = applyDeviceSelection({ preference: "system", accountDefault: "dark", matchesDark: false });
    expect(resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("preferences client", () => {
  it("parses the stored account default", async () => {
    const { client } = stubClient({ preferences: { theme_default: "dark" } });
    await expect(getPreferences(client)).resolves.toBe("dark");
  });

  it("normalizes a missing default to null", async () => {
    const { client } = stubClient({ preferences: {} });
    await expect(getPreferences(client)).resolves.toBeNull();
  });

  it("propagates load failures so callers fall back to device-only", async () => {
    const { client } = stubClient({ failGetWith: apiError(500) });
    await expect(getPreferences(client)).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects malformed payloads instead of guessing", async () => {
    const { client } = stubClient({ preferences: ["dark"] });
    await expect(getPreferences(client)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("saves the account default and returns the stored value", async () => {
    const { client, patches } = stubClient({});
    await expect(patchPreferences(client, "light")).resolves.toBe("light");
    expect(patches).toEqual([{ theme_default: "light" }]);
  });
});

describe("AccountThemeSection", () => {
  it("applies the account default on hydration when no device override exists", async () => {
    const { client } = stubClient({ preferences: { theme_default: "dark" } });
    renderSection(client);
    expect(await loadedAccountSelect()).toHaveValue("dark");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark"),
    );
  });

  it("keeps the device override applied over the account default", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const { client } = stubClient({ preferences: { theme_default: "dark" } });
    renderSection(client);
    expect(await loadedAccountSelect()).toHaveValue("dark");
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("light"),
    );
    expect(deviceSelect()).toHaveValue("light");
  });

  it("falls back to device-only with an inline notice when the account load fails", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const { client } = stubClient({ failGetWith: apiError(500) });
    renderSection(client);
    // The notice never blocks theme application: the device value applies.
    expect(await screen.findByRole("alert")).toHaveTextContent(/using this device's setting/i);
    expect(deviceSelect()).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Account default" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark"),
    );
  });

  it("saves the account default through PATCH and applies it", async () => {
    const { client, patches } = stubClient({ preferences: { theme_default: null } });
    renderSection(client);
    const select = await loadedAccountSelect();
    expect(select).toHaveValue("system");
    fireEvent.change(select, { target: { value: "light" } });
    await waitFor(() => expect(patches).toEqual([{ theme_default: "light" }]));
    await waitFor(() =>
      expect(document.documentElement.getAttribute("data-theme")).toBe("light"),
    );
  });

  it("shows a save error and reverts the select when PATCH fails", async () => {
    const { client, patches } = stubClient({
      preferences: { theme_default: "dark" },
      failPatchWith: apiError(500),
    });
    renderSection(client);
    const select = await loadedAccountSelect();
    fireEvent.change(select, { target: { value: "light" } });
    expect(await screen.findByText(/could not be saved/i)).toBeInTheDocument();
    // Controlled by the last saved value, so the failed edit visibly reverts.
    await waitFor(() => expect(accountSelect()).toHaveValue("dark"));
    expect(patches).toEqual([]);
  });

  it("shares the single Theme label and option copy with the shell switcher", async () => {
    const { client } = stubClient({ preferences: { theme_default: null } });
    renderSection(client);
    await loadedAccountSelect();
    expect(deviceSelect()).toBeInTheDocument();
    for (const label of ["Light", "Dark", "Follow device"]) {
      expect(screen.getAllByRole("option", { name: label })).toHaveLength(2);
    }
  });
});
