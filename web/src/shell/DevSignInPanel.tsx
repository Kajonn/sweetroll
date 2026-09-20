import { useState } from "react";

import { t } from "../i18n/index.js";

import styles from "./DevSignInPanel.module.css";

export function DevSignInPanel({
  onSignedIn,
  acceptance = false,
}: {
  onSignedIn: () => void | Promise<void>;
  acceptance?: boolean;
}) {
  const [code, setCode] = useState("code-dev");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <form
      className={styles.panel}
      aria-label={t("shell.devSignIn.title")}
      data-testid="dev-signin-panel"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setFailed(false);
        try {
          const res = await fetch("/dev/signin", {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code, redirectUri: window.location.origin + "/cb" }),
          });
          if (res.ok) await onSignedIn();
          else setFailed(true);
        } catch {
          setFailed(true);
        } finally {
          setPending(false);
        }
      }}
    >
      {acceptance ? (
        <strong>{t("shell.acceptanceSignIn.title")}</strong>
      ) : (
        <>
          <label htmlFor="dev-signin-code">{t("shell.devSignIn.code")}</label>
          <input
            id="dev-signin-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            data-testid="dev-signin-code"
          />
        </>
      )}
      <button type="submit" data-testid="dev-signin" disabled={pending}>
        {pending
          ? t("shell.acceptanceSignIn.pending")
          : t(acceptance ? "shell.acceptanceSignIn.button" : "shell.devSignIn.button")}
      </button>
      {failed ? <p role="alert">{t("shell.acceptanceSignIn.failed")}</p> : null}
    </form>
  );
}
