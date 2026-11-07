import tokenStyles from "../campaigns/SceneToken.module.css";
// Restricted display shell: code entry → credential-scoped live scene stream.
// Runs outside the GM chrome (the /display route skips AppShell): no
// identity gate and no campaign endpoints — only redeemDisplay plus the
// credential-scoped scene event stream and redacted image reads.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { DisplayImage } from "./DisplayImage.js";
import { Button, EmptyState, FormField } from "../ui/index.js";
import type { CampaignsApi } from "../campaigns/api.js";
import type { DisplayProjection } from "../campaigns/types.js";
import { connectSceneStream, type SceneStreamFactory, type SceneStreamHandle, type SceneStreamStatus } from "./sceneStream.js";

export type DisplayViewApi = Pick<CampaignsApi, "redeemDisplay">;

export type DisplayCredential = { displayId: string; secret: string };

export type DisplayStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const DISPLAY_CREDENTIAL_STORAGE_KEY = "sweetroll:display-credential";

function readStoredCredential(storage: DisplayStorage | undefined): DisplayCredential | null {
  if (storage === undefined) return null;
  try {
    const raw = storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { displayId, secret } = parsed as { displayId?: unknown; secret?: unknown };
    if (typeof displayId !== "string" || displayId === "" || typeof secret !== "string" || secret === "") {
      return null;
    }
    return { displayId, secret };
  } catch {
    return null;
  }
}

/** Live browser online state, unless the caller pins a test/route value. */
function useDisplayOnline(override: boolean | undefined): boolean {
  const [browserOnline, setBrowserOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    if (override !== undefined) return;
    const goOnline = (): void => setBrowserOnline(true);
    const goOffline = (): void => setBrowserOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, [override]);
  return override ?? browserOnline;
}

export function DisplayView(props: {
  api: DisplayViewApi;
  sceneId: string;
  online?: boolean | undefined;
  storage?: DisplayStorage | undefined;
  /** Test seam: replaces the fetch-based scene event stream. */
  openSceneStream?: SceneStreamFactory | undefined;
}) {
  const fallbackStorage: DisplayStorage | undefined =
    typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  const storage = props.storage ?? fallbackStorage;
  const online = useDisplayOnline(props.online);
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState<DisplayCredential | null>(() => readStoredCredential(storage));
  const [code, setCode] = useState("");
  const [redeemPending, setRedeemPending] = useState(false);
  const [redeemFailed, setRedeemFailed] = useState(false);
  const [shown, setShown] = useState<DisplayProjection | null>(null);
  const [status, setStatus] = useState<SceneStreamStatus>("connecting");
  // The map URL whose redacted bytes have arrived. Tokens render only over
  // the map they belong to: after an image revision change the old frame is
  // cleared immediately and the new one appears only once its bytes load.
  const [loadedMapUrl, setLoadedMapUrl] = useState<string | null>(null);
  const streamRef = useRef<SceneStreamHandle | null>(null);

  // Entry purge: a shared tablet must not retain GM session or private cached
  // data (design §7.7). Cancel in-flight campaign reads and drop every cached
  // ["campaigns", ...] entry before the stream opens.
  const purgedRef = useRef(false);
  useEffect(() => {
    if (purgedRef.current) return;
    purgedRef.current = true;
    void queryClient.cancelQueries({ queryKey: ["campaigns"] });
    queryClient.removeQueries({ queryKey: ["campaigns"] });
  }, [queryClient]);

  // One live stream per (credential, scene) while online. Every snapshot is
  // complete; a disconnect or lost authorization blanks the frame.
  const openStream = props.openSceneStream ?? connectSceneStream;
  useEffect(() => {
    setShown(null);
    setLoadedMapUrl(null);
    if (credential === null || props.sceneId === "" || !online) return undefined;
    setStatus("connecting");
    const handle = openStream(
      { displayId: credential.displayId, sceneId: props.sceneId, secret: credential.secret },
      {
        onSnapshot: (projection) => setShown(projection),
        onStatus: (next) => {
          setStatus(next);
          if (next !== "open") {
            setShown(null);
            setLoadedMapUrl(null);
          }
        },
      },
    );
    streamRef.current = handle;
    return () => {
      handle.close();
      if (streamRef.current === handle) streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential?.displayId, credential?.secret, props.sceneId, online]);

  const retry = (): void => {
    streamRef.current?.retryNow();
  };

  const redeem = async (): Promise<void> => {
    if (redeemPending) return;
    const trimmed = code.trim();
    if (trimmed === "") return;
    setRedeemPending(true);
    setRedeemFailed(false);
    try {
      const response = await props.api.redeemDisplay({ code: trimmed });
      const next: DisplayCredential = {
        displayId: response.display.displayId,
        secret: response.display.secret,
      };
      setCredential(next);
      setShown(null);
      setCode("");
      try {
        storage?.setItem(DISPLAY_CREDENTIAL_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Persistence is best-effort: the redeemed credential still works
        // for this session even when storage is unavailable.
      }
    } catch {
      setRedeemFailed(true);
    } finally {
      setRedeemPending(false);
    }
  };

  const disconnect = (): void => {
    setCredential(null);
    setShown(null);
    setCode("");
    setRedeemFailed(false);
    try {
      storage?.removeItem(DISPLAY_CREDENTIAL_STORAGE_KEY);
    } catch {
      // Best-effort only; the in-memory credential is already dropped.
    }
  };

  if (credential === null) {
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.code.title")}</h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void redeem();
          }}
        >
          <FormField
            label={t("display.code.label")}
            hint={t("display.code.hint")}
            error={redeemFailed ? t("display.code.error") : undefined}
          >
            <input
              type="text"
              value={code}
              autoComplete="one-time-code"
              disabled={!online || redeemPending}
              onChange={(event) => setCode(event.target.value)}
            />
          </FormField>
          <Button
            type="submit"
            variant="primary"
            pending={redeemPending}
            pendingText={t("display.code.submitting")}
            disabled={code.trim() === "" || !online}
          >
            {t("display.code.submit")}
          </Button>
        </form>
        {!online ? <p role="status">{t("display.offline")}</p> : null}
      </section>
    );
  }

  if (props.sceneId === "") {
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.title")}</h1>
        <EmptyState title={t("display.empty.title")} description={t("display.empty.description")} />
      </section>
    );
  }

  if (!online) {
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.title")}</h1>
        <p role="status">{t("display.offline")}</p>
      </section>
    );
  }

  if (status === "revoked" || shown === null || shown.sceneId !== props.sceneId) {
    if (status === "connecting") {
      return (
        <section aria-label={t("display.title")}>
          <h1>{t("display.title")}</h1>
          <p role="status">{t("display.connecting")}</p>
        </section>
      );
    }
    // Revoked credentials stop retrying until the display is paired again;
    // Retry here is an explicit, single user-initiated attempt.
    const revoked = status === "revoked";
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.title")}</h1>
        <EmptyState
          title={revoked ? t("display.blank.title") : t("display.reconnecting.title")}
          description={revoked ? t("display.blank.description") : t("display.reconnecting.description")}
          action={
            <>
              <Button variant="primary" onClick={retry}>
                {t("display.retry")}
              </Button>{" "}
              <Button variant="secondary" onClick={disconnect}>
                {t("display.disconnect")}
              </Button>
            </>
          }
        />
      </section>
    );
  }

  const mapReady = loadedMapUrl === shown.imageUrl;
  return (
    <section aria-label={t("display.title")}>
      <h1>{t("display.title")}</h1>
      <div style={{ position: "relative", overflow: "hidden" }}>
        <DisplayImage
          key={`${credential.displayId}:${shown.imageUrl}`}
          path={shown.imageUrl}
          secret={credential.secret}
          alt={t("display.imageAlt")}
          onReady={setLoadedMapUrl}
        />
        {mapReady ? (
          <ul aria-label={t("display.tokensLabel")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {shown.tokens.map((token) => (
              <li
                key={token.tokenId}
                className={tokenStyles.token}
                style={{
                  width: `${token.size * 100}%`,
                  position: "absolute",
                  left: `${token.x * 100}%`,
                  top: `${token.y * 100}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                {token.imageUrl ? <DisplayImage key={`${credential.displayId}:${token.imageUrl}`} path={token.imageUrl} secret={credential.secret} alt="" /> : null}
                <span className={tokenStyles.label}>{token.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
