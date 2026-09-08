import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(navigator.onLine);
  const [helpOpen, setHelpOpen] = useState(false);
  const [auth, setAuth] = useState<AuthState>({ state: "loading" });
  const [identity, setIdentity] = useState<IdentityGate | null>(null);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [logoutStatus, setLogoutStatus] = useState<"pending" | "complete" | "error" | "serverError" | null>(null);
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
    if (
      previous !== null &&
      (previous.actor !== snapshot.actorId || previous.generation !== snapshot.generation)
    ) {
      void queryClient.cancelQueries().then(() => {
        queryClient.removeQueries();
      });
    }
  });
  useShortcut("?", () => setHelpOpen(true));
  const markSignedIn = async () => { await identity?.refresh(); };
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
  return (
    <IdentityContext.Provider value={identity}>
      <AuthProvider initial={auth}>
        <div className={styles.shell}>
          <header role="banner" data-testid="app-header" className={styles.header}>
            <span>Sweetroll</span>
            {/* Intentional plain anchor: AppShell also renders outside a
                RouterProvider (standalone/tests), where TanStack Link has no
                router context and crashes. */}
            <a href="/characters/new">{t("shell.nav.newCharacter")}</a>
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
              ) : auth.state === "anonymous" ? (
                // Production anonymous never keeps protected views mounted:
                // sign-out unmounts routed children (editor, library) instead
                // of leaving previous-identity data on screen.
                <p role="status">{t("character.detail.signIn")}</p>
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
