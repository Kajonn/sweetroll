import { useSyncExternalStore, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { Checkbox } from "./Checkbox.js";

export const DEBUG_MODE_KEY = "sweetroll:debug-information";
const CHANGE_EVENT = "sweetroll:debug-information-changed";
let transientPreference: boolean | undefined;

function snapshot(): boolean {
  if (transientPreference !== undefined) return transientPreference;
  try { return localStorage.getItem(DEBUG_MODE_KEY) === "true"; }
  catch { return false; }
}

export function setDebugMode(enabled: boolean): void {
  try {
    localStorage.setItem(DEBUG_MODE_KEY, String(enabled));
    transientPreference = undefined;
  } catch { transientPreference = enabled; }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== null && event.key !== DEBUG_MODE_KEY) return;
    transientPreference = undefined;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener("storage", storageChanged);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", storageChanged);
  };
}

/** A device-local presentation preference, never an authorization switch. */
export function useDebugMode(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

export function DebugOnly({ children }: { children: ReactNode }) {
  return useDebugMode() ? <>{children}</> : null;
}

export function DebugSettings() {
  const enabled = useDebugMode();
  return <Checkbox aria-label={t("debug.enabled")} label={t("debug.enabled")} hint={t("debug.hint")} checked={enabled} onChange={event => setDebugMode(event.target.checked)} />;
}
