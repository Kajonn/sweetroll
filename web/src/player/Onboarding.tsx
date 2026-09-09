import { t } from "../i18n/index.js";
import { Button, PageHeader } from "../ui/index.js";
import styles from "./Onboarding.module.css";

/** Persisted first-run flag, consumed by the Task 7 e2e. */
export function onboardingKey(actorId: string | null): string {
  return `sweetroll:onboarding:${actorId ?? "anonymous"}`;
}

export function isOnboardingComplete(actorId: string | null): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(onboardingKey(actorId)) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingComplete(actorId: string | null): void {
  try {
    localStorage.setItem(onboardingKey(actorId), "1");
  } catch {
    // First-run dismissal is best-effort: storage failure must not block
    // sign-in or navigation.
  }
}

export type OnboardingProps = {
  actorId: string | null;
  onDismiss?: (() => void) | undefined;
};

/**
 * First-run welcome. Entry links reuse the creation route (which owns the
 * Task 1 picker seam) and the library; dismissing only persists the flag
 * and never blocks sign-in.
 */
export function Onboarding({ actorId, onDismiss }: OnboardingProps) {
  const dismiss = () => {
    markOnboardingComplete(actorId);
    onDismiss?.();
  };
  return (
    <div className={styles.welcome} data-testid="onboarding">
      <PageHeader title={t("player.welcome.title")} description={t("player.welcome.description")} />
      <p className={styles.actions}>
        <a href="/characters/new" data-testid="welcome-create" className={styles.createLink}>
          {t("player.welcome.create")}
        </a>{" "}
        <a href="/characters" data-testid="welcome-library" className={styles.libraryLink}>
          {t("player.welcome.library")}
        </a>
      </p>
      <Button type="button" variant="secondary" onClick={dismiss} data-testid="welcome-dismiss">
        {t("player.welcome.dismiss")}
      </Button>
    </div>
  );
}
