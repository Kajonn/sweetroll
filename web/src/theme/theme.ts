/**
 * G2-structural device theme preference (I4a device-local) with the G6
 * account-level default (I5) layered on top.
 *
 * Precedence: an explicit stored device preference ("light" | "dark") wins;
 * otherwise the account default applies; otherwise the OS setting ("system").
 * A stored "system" is deliberately equivalent to an absent key -- both mean
 * "no device override", so legacy Follow-device values and cleared keys
 * resolve identically through every reader (the before-paint script, the
 * stored-preference helpers, and `resolveTheme` below).
 *
 * The stored value is one of Light / Dark / Follow-device ("system"). Only
 * the resolved "light" | "dark" value is ever written to
 * `document.documentElement` as `data-theme`, so theme switching changes
 * presentation only: no React tree above feature components is touched and
 * editor/character state is preserved.
 *
 * Tokens live on `:root` / `[data-theme]` on `documentElement`, which every
 * in-document tree inherits -- including portaled Radix dialogs/popovers
 * attached to `document.body`.
 *
 * Account timing honesty: the before-paint inline script in web/index.html is
 * device-only (the account is unknown before first paint), and the account
 * default applies on hydration once `/me/preferences` resolves. There is no
 * flash-of-wrong-theme guarantee beyond the stored device value.
 */

/** Device theme preference. "system" means follow the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

/**
 * Device preference with "no override" made explicit. Null means the stored
 * key is absent, "system", or unreadable: the account default shows through.
 */
export type DevicePreference = ThemePreference | null;

/** Theme actually applied to the document. */
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "sweetroll:theme";

export const DEFAULT_PREFERENCE: ThemePreference = "system";

const PREFERENCES: ReadonlyArray<ThemePreference> = ["light", "dark", "system"];

export function normalizePreference(value: unknown): ThemePreference {
  return (PREFERENCES as ReadonlyArray<unknown>).includes(value)
    ? (value as ThemePreference)
    : DEFAULT_PREFERENCE;
}

type PreferenceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function readStorage(): PreferenceStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read the persisted device preference; falls back to Follow-device. */
export function getStoredPreference(
  storage: PreferenceStorage | null = readStorage(),
): ThemePreference {
  try {
    if (storage === null) return DEFAULT_PREFERENCE;
    return normalizePreference(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFERENCE;
  }
}

/**
 * Read the device override: an explicit "light" | "dark", or null when there
 * is no override (absent key, stored "system", unknown value, or unreadable
 * storage). A null device reveals the account default via `resolveTheme`.
 */
export function getDevicePreference(
  storage: PreferenceStorage | null = readStorage(),
): DevicePreference {
  return toDevicePreference(getStoredPreference(storage));
}

/** Map a stored-style preference to its device-override meaning. */
export function toDevicePreference(preference: ThemePreference): DevicePreference {
  return preference === "light" || preference === "dark" ? preference : null;
}

/** Resolve a preference to a concrete theme given the OS dark-mode state. */
export function resolvePreference(
  preference: ThemePreference,
  matchesDark: boolean,
): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return matchesDark ? "dark" : "light";
}

function readDeviceMatchesDark(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Resolve the currently stored preference against the live OS setting. */
export function resolveStoredTheme(): ResolvedTheme {
  return resolvePreference(getStoredPreference(), readDeviceMatchesDark());
}

/**
 * Single effective-theme resolver (G6): device override wins, then the
 * account default, then the OS setting. Used by the shell ThemeSwitcher and
 * the account screen alike -- never fork it. A fetch failure maps to a null
 * accountDefault upstream, so the theme still applies device-only.
 */
export function resolveTheme(input: {
  device: DevicePreference;
  accountDefault: ThemePreference | null;
  matchesDark?: boolean | undefined;
}): ResolvedTheme {
  const preference = input.device ?? input.accountDefault ?? DEFAULT_PREFERENCE;
  return resolvePreference(preference, input.matchesDark ?? readDeviceMatchesDark());
}

/** Apply the effective theme to the document element; returns it. */
export function applyEffectiveTheme(input: {
  device: DevicePreference;
  accountDefault: ThemePreference | null;
  matchesDark?: boolean | undefined;
}): ResolvedTheme {
  const resolved = resolveTheme(input);
  applyTheme(resolved);
  return resolved;
}

/**
 * Apply the resolved theme to the document element. Attribute-only: no
 * component remounts, no state resets.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
  try {
    document.documentElement.style.colorScheme = resolved;
  } catch {
    // colorScheme is progressive enhancement; the data-theme attribute
    // alone drives the token presets.
  }
}

/**
 * Persist a device preference and apply its resolved theme.
 * Returns the resolved theme.
 */
export function persistPreference(preference: ThemePreference): ResolvedTheme {
  const normalized = normalizePreference(preference);
  setStoredPreference(normalized);
  const resolved = resolvePreference(normalized, readDeviceMatchesDark());
  applyTheme(resolved);
  return resolved;
}

/** Write a device preference without applying it (apply via the resolver). */
export function setStoredPreference(preference: ThemePreference): void {
  const normalized = normalizePreference(preference);
  try {
    readStorage()?.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Private-mode / unavailable storage: apply-only, same as persistPreference.
  }
}

/**
 * Persist a device selection and apply the effective theme (device >
 * account > system). Shared by the shell ThemeSwitcher and the account
 * screen so the two writers can never diverge.
 * Returns the resolved theme.
 */
export function applyDeviceSelection(input: {
  preference: ThemePreference;
  accountDefault: ThemePreference | null;
  matchesDark?: boolean | undefined;
}): ResolvedTheme {
  const normalized = normalizePreference(input.preference);
  setStoredPreference(normalized);
  return applyEffectiveTheme({
    device: toDevicePreference(normalized),
    accountDefault: input.accountDefault,
    matchesDark: input.matchesDark,
  });
}

function deviceMediaQuery(): MediaQueryList | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return null;
  }
}

/**
 * Subscribe to OS dark-mode changes. The shell ThemeSwitcher uses this to
 * re-apply the *effective* theme (device > account > system); initTheme's
 * own listener covers the device-only baseline.
 */
export function subscribeMatchesDark(listener: (matchesDark: boolean) => void): () => void {
  const media = deviceMediaQuery();
  if (media === null) return () => {};
  const onChange = (event: MediaQueryListEvent): void => {
    listener(event.matches);
  };
  if (typeof media.addEventListener === "function") {
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }
  if (typeof media.addListener === "function") {
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }
  return () => {};
}

/**
 * Apply the stored preference now and keep Follow-device in sync with OS
 * changes and cross-tab storage updates. Returns an unsubscribe function.
 * Wired into web/src/main.tsx; the before-paint inline script in
 * web/index.html covers first paint before app startup.
 */
export function initTheme(): () => void {
  applyTheme(resolveStoredTheme());
  const cleanups: Array<() => void> = [];
  const media = deviceMediaQuery();
  if (media !== null) {
    const onChange = (event: MediaQueryListEvent): void => {
      if (getStoredPreference() === "system") {
        applyTheme(event.matches ? "dark" : "light");
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      cleanups.push(() => media.removeEventListener("change", onChange));
    } else if (typeof media.addListener === "function") {
      media.addListener(onChange);
      cleanups.push(() => media.removeListener(onChange));
    }
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      applyTheme(resolveStoredTheme());
    };
    window.addEventListener("storage", onStorage);
    cleanups.push(() => window.removeEventListener("storage", onStorage));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
