import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { HelpCircle } from "lucide-react";

import { t } from "../i18n/index.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { StatusBar } from "./StatusBar.js";
import { useShortcut } from "./useShortcut.js";
import styles from "./AppShell.module.css";

export type AuthState = { state: "loading" } | { state: "anonymous" } | { state: "authenticated"; userId: string };

const AuthContext = createContext<AuthState>({ state: "loading" });
export const useAuth = (): AuthState => useContext(AuthContext);

export function AuthProvider({ initial, children }: { initial: AuthState; children: ReactNode }) {
  return <AuthContext.Provider value={initial}>{children}</AuthContext.Provider>;
}

export function AppShell({ children }: { children: ReactNode }) {
  const [online] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const requestId = useMemo(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : "req"), []);
  useShortcut("?", () => setHelpOpen(true));
  return (
    <div className={styles.shell}>
      <header role="banner" data-testid="app-header" className={styles.header}>
        <span>Sweetroll</span>
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
        <main role="main" className={styles.main}>{children}</main>
      </ErrorBoundary>
      <StatusBar requestId={requestId} online={online} />
      <ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}