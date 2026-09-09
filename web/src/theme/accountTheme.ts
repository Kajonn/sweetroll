import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "../api/client.js";
import type { ThemePreference } from "./theme.js";

/**
 * Account-level theme default (G6). Null means no default is stored -- or,
 * for `usePreferences`, not yet loaded. A load failure never blocks theme
 * application: callers map it to null (device-only) and show an inline
 * notice instead.
 */
export type AccountThemeDefault = ThemePreference | null;

export const PREFERENCES_QUERY_KEY = ["preferences"] as const;

type PreferencesResponse = {
  theme_default?: unknown;
};

function normalizeAccountDefault(value: unknown): AccountThemeDefault {
  return value === "light" || value === "dark" || value === "system" ? value : null;
}

function expectPreferencesObject(resolved: unknown): PreferencesResponse {
  if (resolved === null || typeof resolved !== "object" || Array.isArray(resolved)) {
    throw new ApiError({
      code: "malformed_response",
      message: "The server returned an unexpected response.",
      status: 200,
      requestId: "",
      latestRevision: null,
      diagnostics: [],
    });
  }
  return resolved as PreferencesResponse;
}

/** Fetch the account theme default. Unknown payloads normalize to null. */
export async function getPreferences(client: ApiClient): Promise<AccountThemeDefault> {
  const response = await client.fetch<PreferencesResponse>("GET", "/me/preferences");
  return normalizeAccountDefault(expectPreferencesObject(response).theme_default);
}

/** Save the account theme default. Returns the stored value. */
export async function patchPreferences(
  client: ApiClient,
  value: ThemePreference,
): Promise<AccountThemeDefault> {
  const response = await client.fetch<PreferencesResponse, { theme_default: ThemePreference }>(
    "PATCH",
    "/me/preferences",
    { body: { theme_default: value } },
  );
  return normalizeAccountDefault(expectPreferencesObject(response).theme_default);
}

/**
 * Shared cached account default (shell switcher + account screen read the
 * same entry, so one request serves both). Anonymous or failed loads surface
 * as `undefined` data with `isError`; callers fall back to device-only.
 */
export function usePreferences(client: ApiClient): UseQueryResult<AccountThemeDefault> {
  return useQuery({
    queryKey: PREFERENCES_QUERY_KEY,
    queryFn: () => getPreferences(client),
    staleTime: 60_000,
  });
}
