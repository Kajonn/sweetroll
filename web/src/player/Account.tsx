import { useState } from "react";

import { ApiError, type ApiClient } from "../api/client.js";
import { useMe } from "../api/hooks.js";
import { t } from "../i18n/index.js";
import { useOfflineAvailability } from "../offline/useOfflineAvailability.js";
import { Button, PageHeader, Panel } from "../ui/index.js";

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
 * Task 4 mount point: the account screen owns the theme-default control
 * added there. This task provides the section only; the control and its
 * behavior land in Task 4.
 */
export function AccountThemeSection() {
  return <section aria-label={t("shell.theme.label")} data-testid="account-theme-section" />;
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

  return (
    <div data-testid="account">
      <PageHeader title={t("player.account.title")} />
      {storageUnavailable ? <p role="status">{t("shell.characterStorageUnavailable")}</p> : null}
      {me.isLoading ? (
        <div data-testid="account-loading" role="status" aria-busy="true">
          {t("player.account.loading")}
        </div>
      ) : status === 401 ? (
        <section aria-labelledby="account-expired-title">
          <h2 id="account-expired-title">{t("player.account.expired")}</h2>
          <p role="status">{t("character.detail.signIn")}</p>
          {/* Task 6 owns the expired-session re-auth entry; mount point only. */}
          <div data-testid="account-reauth-mount" />
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
      ) : me.data === undefined || me.data.state === "anonymous" || me.data.userId === "" ? (
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
          <AccountThemeSection />
        </>
      )}
    </div>
  );
}

function ApiErrorStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  return null;
}
