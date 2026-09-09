import { useEffect, useState, type ChangeEvent } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { ApiError, type ApiClient } from "../api/client.js";
import { useMe } from "../api/hooks.js";
import { storePostSigninPath } from "../characters/identity.js";
import { t } from "../i18n/index.js";
import { useOfflineAvailability } from "../offline/useOfflineAvailability.js";
import {
  PREFERENCES_QUERY_KEY,
  patchPreferences,
  usePreferences,
  type AccountThemeDefault,
} from "../theme/accountTheme.js";
import {
  THEME_STORAGE_KEY,
  applyDeviceSelection,
  applyEffectiveTheme,
  getStoredPreference,
  normalizePreference,
  toDevicePreference,
  type ThemePreference,
} from "../theme/theme.js";
import { Button, PageHeader, Panel, Select } from "../ui/index.js";

export type AccountIdentity = {
  getActorId(): string | null;
  isOnline(): boolean;
  signOut(): Promise<void>;
};

export type AccountProps = {
  client: ApiClient;
  identity: AccountIdentity;
  storageUnavailable: boolean;
};

/**
 * Account theme controls (G6 Task 4): the per-device override plus the
 * account-level default. Both selects share the `Select` control and the
 * `shell.theme.*` option labels with the shell ThemeSwitcher, and both apply
 * through the single `resolveTheme` resolver -- device override wins, then
 * the account default, then the OS setting. A failed account load maps to a
 * null default (device-only) with an inline notice and never blocks theme
 * application.
 */
export function AccountThemeSection({ client }: { client: ApiClient }) {
  const queryClient = useQueryClient();
  const preferences = usePreferences(client);
  const [device, setDevice] = useState<ThemePreference>(() => getStoredPreference());
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // A failed load is device-only; a pending one resolves once it settles.
  const accountDefault: AccountThemeDefault =
    preferences.isError ? null : (preferences.data ?? null);

  // Apply on hydration and whenever either input settles.
  useEffect(() => {
    applyEffectiveTheme({ device: toDevicePreference(device), accountDefault });
  }, [device, accountDefault]);

  // Stay in sync with device changes from other tabs (same as the switcher).
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      setDevice(getStoredPreference());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const onDeviceChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = normalizePreference(event.target.value);
    setDevice(next);
    applyDeviceSelection({ preference: next, accountDefault });
  };

  const onAccountChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = normalizePreference(event.target.value);
    setSaving(true);
    setSaveFailed(false);
    void patchPreferences(client, next).then(
      (saved) => {
        queryClient.setQueryData<AccountThemeDefault>(PREFERENCES_QUERY_KEY, saved);
        applyEffectiveTheme({ device: toDevicePreference(device), accountDefault: saved });
        setSaving(false);
      },
      () => {
        // The select stays controlled by the last saved value, so a failed
        // save visibly reverts; only the error text persists.
        setSaveFailed(true);
        setSaving(false);
      },
    );
  };

  const options = [
    { value: "light", label: t("shell.theme.light") },
    { value: "dark", label: t("shell.theme.dark") },
    { value: "system", label: t("shell.theme.system") },
  ];

  return (
    <section aria-label={t("shell.theme.label")} data-testid="account-theme-section">
      <Select
        label={t("shell.theme.label")}
        value={device}
        onChange={onDeviceChange}
        options={options}
      />
      {preferences.isLoading ? (
        <Select
          label={t("player.account.themeDefault")}
          value="system"
          disabled
          hint={t("player.account.loading")}
          onChange={() => {}}
          options={options}
        />
      ) : preferences.isError ? (
        <p role="alert">{t("player.account.themeUnavailable")}</p>
      ) : (
        <Select
          label={t("player.account.themeDefault")}
          value={accountDefault ?? "system"}
          pending={saving}
          {...(saveFailed ? { error: t("player.account.themeSaveFailed") } : {})}
          onChange={onAccountChange}
          options={options}
        />
      )}
    </section>
  );
}

function deviceLocale(): string {
  if (typeof navigator !== "undefined" && typeof navigator.language === "string" && navigator.language !== "") {
    return navigator.language;
  }
  if (typeof document !== "undefined") {
    const lang = document.documentElement.getAttribute("lang");
    if (lang !== null && lang !== "") return lang;
  }
  return "en";
}

/**
 * Player account: profile via `useMe`, locale display, the current session
 * only with sign-out (existing POST /signout + local purge through the
 * identity gate), and storage/sync/recovery guidance reusing the existing
 * StatusBar/offline texts — no new copy for guidance.
 */
export function Account({ client, identity, storageUnavailable }: AccountProps) {
  const me = useMe(client);
  const offline = useOfflineAvailability(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const online = identity.isOnline();

  const signOut = async () => {
    if (!window.confirm(t("shell.signOut.confirm"))) return;
    setSigningOut(true);
    setSignOutError(null);
    try {
      await identity.signOut();
    } catch {
      setSignOutError(t("shell.signOut.error"));
    } finally {
      setSigningOut(false);
    }
  };

  const status = ApiErrorStatus(me.error);
  // Expired reads as signed-out with a re-auth entry: a 401 from the query
  // (Task 3 mount point) or an explicit session_expired payload (Task 6).
  const expired = status === 401 || me.data?.state === "session_expired";

  // Provider-agnostic re-auth entry: stash the current path for the `/cb`
  // return journey, then fall back to the environment's sign-in entry
  // (whatever adapter is configured) by returning to the signed-out state.
  // No provider specifics here: no issuer URLs, no PKCE, no credentials.
  const startReauth = async () => {
    storePostSigninPath(window.location.pathname);
    try {
      await identity.signOut();
    } catch {
      // Local/server sign-out failures keep their existing handling (shell
      // status, retryable barrier); the stashed path survives for the retry.
    }
  };

  return (
    <div data-testid="account">
      <PageHeader title={t("player.account.title")} />
      {storageUnavailable ? <p role="status">{t("shell.characterStorageUnavailable")}</p> : null}
      {me.isLoading ? (
        <div data-testid="account-loading" role="status" aria-busy="true">
          {t("player.account.loading")}
        </div>
      ) : expired ? (
        <section aria-labelledby="account-expired-title">
          <h2 id="account-expired-title">{t("player.account.expired")}</h2>
          <p role="status">{t("character.detail.signIn")}</p>
          <div data-testid="account-reauth-mount">
            <p>{t("character.sync.reauthenticate")}</p>
            <Button type="button" variant="primary" onClick={() => void startReauth()}>
              {t("player.account.signInAgain")}
            </Button>
          </div>
        </section>
      ) : status === 403 ? (
        <p role="status">{t("character.detail.signIn")}</p>
      ) : me.isError ? (
        <Panel>
          <p role="alert">{t("player.library.loadFailed")}</p>
          <p>{t("player.library.retryHint")}</p>
          <Button type="button" variant="secondary" onClick={() => void me.refetch()}>
            {t("player.library.retry")}
          </Button>
        </Panel>
      ) : me.data === undefined || me.data.state !== "authenticated" || me.data.userId === "" ? (
        <Panel>
          <p role="status">{t("player.account.empty")}</p>
        </Panel>
      ) : (
        <>
          <Panel>
            <dl>
              <dt>{t("player.account.userId")}</dt>
              <dd>{me.data.userId}</dd>
              <dt>{t("player.account.locale")}</dt>
              <dd>{deviceLocale()}</dd>
            </dl>
          </Panel>
          <Panel title={t("player.account.sessions")}>
            <ul>
              <li>
                {me.data.userId} · {t("player.account.currentSession")}
              </li>
            </ul>
            {signOutError !== null ? <p role="alert">{signOutError}</p> : null}
            <Button
              type="button"
              variant="secondary"
              pending={signingOut}
              pendingText={t("shell.signOut.pending")}
              onClick={() => void signOut()}
            >
              {t("shell.signOut.button")}
            </Button>
          </Panel>
          <Panel title={t("player.account.sync")}>
            <p>{online ? t("status.online") : t("status.offline")}</p>
            <p>{offline.available ? t("character.offline.available") : t("character.offline.unavailable")}</p>
            <p>{t("player.library.manageHint")}</p>
          </Panel>
          <AccountThemeSection client={client} />
        </>
      )}
    </div>
  );
}

function ApiErrorStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  return null;
}
