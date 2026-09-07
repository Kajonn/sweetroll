import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

import { t } from "../i18n/index.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { DevSignInPanel } from "./DevSignInPanel.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { StatusBar } from "./StatusBar.js";
import { useShortcut } from "./useShortcut.js";
import styles from "./AppShell.module.css";
import { createApiClient } from "../api/client.js";
import { createIdentityGate, type IdentityGate } from "../characters/identity.js";
import { openCharacterStore } from "../characters/store.js";

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

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [helpOpen, setHelpOpen] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [identity, setIdentity] = useState<IdentityGate | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [logoutStatus, setLogoutStatus] = useState<"pending" | "complete" | "error" | null>(null);
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
        if (snapshot.pendingLogout) setLogoutStatus("pending");
        else setLogoutStatus(previous => previous === "pending" ? "complete" : previous);
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
  useShortcut("?", () => setHelpOpen(true));
  const markSignedIn = async () => { await identity?.refresh(); };
  const signOut = async () => {
    if (!identity || !window.confirm(t("shell.signOut.confirm"))) return;
    try { await identity.signOut(); }
    catch { setLogoutStatus("error"); }
  };
  return (
    <IdentityContext.Provider value={identity}>
      <AuthProvider initial={auth}>
        <div className={styles.shell}>
          <header role="banner" data-testid="app-header" className={styles.header}>
            <span>Sweetroll</span>
            <a href="/characters/new">{t("shell.nav.newCharacter")}</a>
            {auth.state === "authenticated" && (
              <button type="button" onClick={() => { void signOut(); }}>{t("shell.signOut.button")}</button>
            )}
            {logoutStatus && <span role="status">{t(`shell.signOut.${logoutStatus}`)}</span>}
            <button
              type="button"
              aria-label={t("shortcutHelp.open")}
              className={styles.helpButton}
              onClick={() => setHelpOpen(true)}
            >
              <HelpCircle aria-hidden size={18} />
            </button>
          </header>
          <ErrorBoundary>
            <main role="main" className={styles.main}>
              {storageUnavailable && <p role="status">{t("shell.characterStorageUnavailable")}</p>}
              {auth.state === "anonymous" && isDevMode() ? (
                <DevSignInPanel onSignedIn={markSignedIn} />
              ) : (
                children
              )}
            </main>
          </ErrorBoundary>
          <StatusBar requestId={requestId} online={online} />
          <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
        </div>
      </AuthProvider>
    </IdentityContext.Provider>
  );
}
