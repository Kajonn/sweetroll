import { useState } from "react";

import styles from "./DevSignInPanel.module.css";

export function DevSignInPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [code, setCode] = useState("code-dev");
  return (
    <form
      className={styles.panel}
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await fetch("/dev/signin", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, redirectUri: window.location.origin + "/cb" }) });
        if (res.ok) onSignedIn();
      }}
    >
      <label htmlFor="code">Dev code</label>
      <input id="code" value={code} onChange={(e) => setCode(e.target.value)} />
      <button type="submit" data-testid="dev-signin">Sign in</button>
    </form>
  );
}
