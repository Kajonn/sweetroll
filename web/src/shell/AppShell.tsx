import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import { ErrorBoundary } from "./ErrorBoundary.js";
import { StatusBar } from "./StatusBar.js";
import styles from "./AppShell.module.css";

export type AuthState = { state: "loading" } | { state: "anonymous" } | { state: "authenticated"; userId: string };

const AuthContext = createContext<AuthState>({ state: "loading" });
export const useAuth = (): AuthState => useContext(AuthContext);

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online] = useState(true);
  const requestId = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : "req"), []);
  return (
    <div className={styles.shell}>
      <header role="banner" data-testid="app-header">Sweetroll</header>
      <ErrorBoundary>
        <main role="main" className={styles.main}>{children}</main>
      </ErrorBoundary>
      <StatusBar requestId={requestId} online={online} />
    </div>
  );
}