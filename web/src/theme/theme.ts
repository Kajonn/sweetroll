/**
 * G2-structural device theme preference (I4a device-local).
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
 * The account-level default is I5 work and is explicitly out of scope here;
 * a per-device override stored here would take precedence over it.
 */

/** Device theme preference. "system" means follow the OS setting. */
export type ThemePreference = "light" | "dark" | "system";

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
  const storage = readStorage();
  try {
    storage?.setItem(THEME_STORAGE_KEY, normalized);
  } catch {
    // Private-mode / unavailable storage: still apply for this session.
  }
  const resolved = resolvePreference(normalized, readDeviceMatchesDark());
  applyTheme(resolved);
  return resolved;
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
