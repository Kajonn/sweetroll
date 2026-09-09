import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

import { t } from "../i18n/index.js";
import { isOnboardingComplete, Onboarding } from "../player/Onboarding.js";
import { getStoredPreference, normalizePreference, persistPreference, THEME_STORAGE_KEY, type ThemePreference } from "../theme/theme.js";
import { Button } from "../ui/Button.js";
import { Select } from "../ui/Select.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { DevSignInPanel } from "./DevSignInPanel.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { StatusBar } from "./StatusBar.js";
import { useShortcut } from "./useShortcut.js";
import styles from "./AppShell.module.css";
import { createApiClient } from "../api/client.js";
import { createIdentityGate, type IdentityGate } from "../characters/identity.js";
import { openCharacterStore } from "../characters/store.js";
import { queryClient } from "../queryClient.js";

export type AuthState =
  | { state: "loading" }
  | { state: "anonymous" }
  | { state: "authenticated"; userId: string };

const AuthContext = createContext<AuthState>({ state: "loading" });
export const useAuth = (): AuthState => useContext(AuthContext);
const IdentityContext = createContext<IdentityGate | null>(null);
export const useIdentity = () => useContext(IdentityContext);

const isDevMode = (): boolean => {
  if (typeof import.meta === "undefined") return false;
  return import.meta.env?.MODE === "development";
};

/** Player paths where anonymous first-run sees the welcome instead of the sign-in prompt. */
function isPlayerPath(pathname: string): boolean {
  return (
    pathname === "/characters" ||
    pathname.startsWith("/characters/") ||
    pathname === "/activity" ||
    pathname === "/account"
  );
}

type BeforeInstallPromptEvent = Event & {
  prompt?: () => Promise<void>;
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const INSTALL_DISMISS_KEY = "sweetroll:pwa-install-dismissed";

function isInstallDismissed(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(INSTALL_DISMISS_KEY) === "1";
  } catch {
    return true;
  }
}

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

/**
 * Minimal device-theme switcher (G2-structural, reversible). Attribute-only:
 * switching sets data-theme via theme.ts, so no React tree remounts and no
 * editor/character state resets. Stays in sync with cross-tab updates.
 */
function ThemeSwitcher() {
  const [preference, setPreference] = useState<ThemePreference>(() => getStoredPreference());
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
      setPreference(getStoredPreference());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return (
    <span style={{ display: "inline-block", minWidth: 160 }}>
      <Select
        label={t("shell.theme.label")}
        value={preference}
        onChange={(event) => {
          const next = normalizePreference(event.target.value);
          setPreference(next);
          persistPreference(next);
        }}
        options={[
          { value: "light", label: t("shell.theme.light") },
          { value: "dark", label: t("shell.theme.dark") },
          { value: "system", label: t("shell.theme.system") },
        ]}
      />
    </span>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [helpOpen, setHelpOpen] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [identity, setIdentity] = useState<IdentityGate | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [logoutStatus, setLogoutStatus] = useState<"pending" | "complete" | "error" | "serverError" | null>(null);
  const [, setOnboardingTick] = useState(0);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installDismissed, setInstallDismissed] = useState<boolean>(() => isInstallDismissed());
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    void openCharacterStore("sweetroll-characters").catch(() => null).then(store => {
      if (disposed) { void store?.close(); return; }
      setStorageUnavailable(store === null);
      const gate = createIdentityGate({ store, client: createApiClient({ baseUrl: "/api" }) });
      setIdentity(gate);
      const update = () => {
        const snapshot = gate.getSnapshot();
        // A server-revocation failure keeps the pending-logout barrier while
        // surfacing its own retryable message: a later snapshot with
        // pendingLogout must not downgrade serverError/error back to generic
        // pending, and clearing the barrier resolves either into complete.
        if (snapshot.pendingLogout) setLogoutStatus(previous => previous === "error" || previous === "serverError" ? previous : "pending");
        else setLogoutStatus(previous => previous === "pending" || previous === "serverError" ? "complete" : previous);
        setAuth(snapshot.actorId ? { state: "authenticated", userId: snapshot.actorId } : { state: "anonymous" });
        setOnline(navigator.onLine);
      };
      const unsubscribe = gate.subscribe(update);
      cleanup = () => { unsubscribe(); gate.dispose(); void store?.close(); };
      void gate.refresh();
    }).catch(() => { if (!disposed) setAuth({ state: "anonymous" }); });
    return () => { disposed = true; cleanup(); };
  }, []);
  const requestId = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : "req"), []);
  // Account-lifetime query hygiene: the shared client outlives sign-out and
  // account switches, so every lifetime change cancels in-flight queries
  // (late responses from the previous identity must not commit) and drops
  // cached account data. The character subsystem guards its own lifetimes;
  // this covers the React Query surface (me, library, versions, drafts).
  // In-flight draft PUTs cannot be aborted (no abort signal reaches the HTTP
  // layer in the installed TanStack Query v5); they are neutralized instead:
  // sign-out/switch unmounts the protected editor (see below and the
  // lifetime-keyed SystemEditorRoute), whose unmount cleanup calls
  // sync.cancel(), and the draft-sync epoch guard ignores late resolutions
  // from a previous lifetime so they commit no state and flush no follow-up.
  const lastLifetimeRef = useRef<{ actor: string | null; generation: number } | null>(null);
  useEffect(() => {
    if (identity === null) return;
    const snapshot = identity.getSnapshot();
    const previous = lastLifetimeRef.current;
    lastLifetimeRef.current = { actor: snapshot.actorId, generation: snapshot.generation };
    // Lifetime transitions and query hygiene:
    // - AWAY from a previous account (switch, sign-out, generation bump):
    //   cancel in-flight work and purge cached account data so the next
    //   lifetime never reads it.
    // - NULL → actor settle (initial load, reload, direct link, sign-in):
    //   only invalidate. The editor/library may already be fetching under
    //   the fresh lifetime, and cancelling then strands the open query
    //   pending forever; invalidation still refetches error-state queries
    //   (e.g. the library's anonymous 401) without killing live fetches.
    //   Skipping the purge here is safe: sign-out already purged the previous
    //   account on its actor→null transition, and anonymous flights only
    //   ever 401.
    if (
      previous !== null &&
      (previous.actor !== snapshot.actorId || previous.generation !== snapshot.generation)
    ) {
      if (previous.actor !== null) {
        void queryClient.cancelQueries().then(() => {
          queryClient.removeQueries();
        });
      } else {
        void queryClient.invalidateQueries();
      }
    }
  });
  useShortcut("?", () => setHelpOpen(true));
  const markSignedIn = async () => { await identity?.refresh(); };
  // PWA install: capture the deferred prompt so the shell can offer the
  // shared Install button; dismissal persists per device.
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  const install = async () => {
    const event = installEvent;
    setInstallEvent(null);
    try {
      await event?.prompt?.();
      await event?.userChoice;
    } catch {
      // A denied or failed prompt simply clears the banner; the user can
      // still reach every route without installing.
    }
  };
  const dismissInstall = () => {
    try {
      localStorage.setItem(INSTALL_DISMISS_KEY, "1");
    } catch {
      // Best-effort persistence only.
    }
    setInstallDismissed(true);
    setInstallEvent(null);
  };
  const signOut = async () => {
    if (!identity || !window.confirm(t("shell.signOut.confirm"))) return;
    try { await identity.signOut(); }
    catch (error) {
      // Local-storage failures and server-revocation failures both reject,
      // but only the latter keeps a retryable pending-logout barrier with
      // local data already hidden. Distinguish them so the UI does not blame
      // local storage when the server call failed. 401/invalid-credential vs
      // storage-unavailable at shell level remains a follow-up (see report).
      // TECH DEBT: discriminates on the gate's English error text, so a gate
      // message change breaks this. Switch to a typed code discriminant if
      // the gate ever gains one; kept as-is to avoid over-engineering.
      if (error instanceof Error && /Server sign-out failed/.test(error.message)) setLogoutStatus("serverError");
      else setLogoutStatus("error");
    }
  };
  const pathname = typeof window !== "undefined" ? window.location.pathname : "/";
  const showFirstRunWelcome =
    auth.state === "anonymous" && pathname !== "/welcome" && isPlayerPath(pathname) && !isOnboardingComplete(null);
  return (
    <IdentityContext.Provider value={identity}>
      <AuthProvider initial={auth}>
        <div className={styles.shell}>
          <a href="#main-content" className={styles.skipLink}>{t("shell.skipToContent")}</a>
          <header role="banner" data-testid="app-header" className={styles.header}>
            <span className={styles.brand}>Sweetroll</span>
            <nav aria-label={t("shell.nav.label")} className={styles.nav}>
              {/* Intentional plain anchors: AppShell also renders outside a
                  RouterProvider (standalone/tests), where TanStack Link has no
                  router context and crashes. */}
              <a href="/" className={styles.navLink}>{t("shell.nav.home")}</a>
              <a href="/characters" className={styles.navLink}>{t("shell.nav.characters")}</a>
              <a href="/characters/new" className={styles.navLink}>{t("shell.nav.newCharacter")}</a>
              <a href="/activity" className={styles.navLink}>{t("shell.nav.activity")}</a>
              <a href="/account" className={styles.navLink}>{t("shell.nav.account")}</a>
            </nav>
            <div className={styles.actions}>
            {auth.state === "authenticated" && (
              <button type="button" onClick={() => { void signOut(); }}>{t("shell.signOut.button")}</button>
            )}
            {/* Server-revocation failure keeps a retryable barrier while the
                session reads anonymous (local data hidden): keep the same
                sign-out action available as the retry so pendingLogout can be
                cleared without new strings. */}
            {logoutStatus === "serverError" && auth.state !== "authenticated" && (
              <button type="button" onClick={() => { void signOut(); }}>{t("shell.signOut.button")}</button>
            )}
            {logoutStatus && <span role="status" className={styles.signOutStatus}>{t(`shell.signOut.${logoutStatus}`)}</span>}
            <ThemeSwitcher />
            <button
              type="button"
              aria-label={t("shortcutHelp.open")}
              className={styles.helpButton}
              onClick={() => setHelpOpen(true)}
            >
              <HelpCircle aria-hidden size={18} />
            </button>
            </div>
          </header>
          <ErrorBoundary>
            <main role="main" id="main-content" data-testid="app-content" className={styles.main}>
              {storageUnavailable && <p role="status">{t("shell.characterStorageUnavailable")}</p>}
              {showFirstRunWelcome ? (
                // Anonymous first-run on player paths sees the welcome inline:
                // /welcome itself is exempt below and renders the routed
                // Onboarding, while returning visitors fall through to the
                // sign-in prompt. Dismissing only persists the flag and never
                // blocks sign-in.
                <Onboarding actorId={null} onDismiss={() => setOnboardingTick(tick => tick + 1)} />
              ) : auth.state === "anonymous" && pathname === "/welcome" ? (
                children
              ) : auth.state === "anonymous" && isDevMode() ? (
                <DevSignInPanel onSignedIn={markSignedIn} />
              ) : auth.state === "anonymous" ? (
                // Production anonymous never keeps protected views mounted:
                // sign-out unmounts routed children (editor, library) instead
                // of leaving previous-identity data on screen.
                <p role="status">{t("character.detail.signIn")}</p>
              ) : (
                children
              )}
              {/* Phone bottom nav: Characters · Activity · Account. Plain
                  anchors like the header nav (no router context required).
                  Hidden on desktop, where the header keeps serving. */}
              <nav aria-label={t("shell.bottomNav.label")} data-testid="player-bottom-nav" className={styles.bottomNav}>
                <a href="/characters" className={styles.bottomNavLink}>{t("shell.nav.characters")}</a>
                <a href="/activity" className={styles.bottomNavLink}>{t("shell.nav.activity")}</a>
                <a href="/account" className={styles.bottomNavLink}>{t("shell.nav.account")}</a>
              </nav>
            </main>
          </ErrorBoundary>
          {installEvent !== null && !installDismissed ? (
            <div role="region" aria-label={t("pwa.install")} data-testid="pwa-install" className={styles.installBanner}>
              <Button type="button" variant="primary" onClick={() => { void install(); }}>
                {t("pwa.install")}
              </Button>
              <Button type="button" variant="secondary" onClick={dismissInstall}>
                {t("pwa.dismiss")}
              </Button>
            </div>
          ) : null}
          <StatusBar requestId={requestId} online={online} />
          <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </AuthProvider>
    </IdentityContext.Provider>
  );
}
