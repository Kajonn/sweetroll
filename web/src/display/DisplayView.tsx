// Restricted display shell: code entry → credential-scoped projection.
// Runs outside the GM chrome (the /display route skips AppShell): no
// identity gate and no campaign endpoints — only redeemDisplay plus the
// credential-scoped getDisplayProjection read.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { t } from "../i18n/index.js";
import { Button, EmptyState, FormField } from "../ui/index.js";
import type { CampaignsApi } from "../campaigns/api.js";
import { useDisplayProjection } from "../campaigns/campaignQueries.js";
import type { DisplayProjection } from "../campaigns/types.js";

export type DisplayViewApi = Pick<CampaignsApi, "redeemDisplay" | "getDisplayProjection">;

export type DisplayCredential = { displayId: string; secret: string };

export type DisplayStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export const DISPLAY_CREDENTIAL_STORAGE_KEY = "sweetroll:display-credential";
export const DISPLAY_PROJECTION_POLL_MS = 5000;

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

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; status?: unknown };
  return record.status === 404 || record.code === "not_found";
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
  pollMs?: number | undefined;
  storage?: DisplayStorage | undefined;
}) {
  const fallbackStorage: DisplayStorage | undefined =
    typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  const storage = props.storage ?? fallbackStorage;
  const online = useDisplayOnline(props.online);
  const pollMs = props.pollMs ?? DISPLAY_PROJECTION_POLL_MS;
  const queryClient = useQueryClient();
  const [credential, setCredential] = useState<DisplayCredential | null>(() => readStoredCredential(storage));
  const [code, setCode] = useState("");
  const [redeemPending, setRedeemPending] = useState(false);
  const [redeemFailed, setRedeemFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [shown, setShown] = useState<DisplayProjection | null>(null);

  // Entry purge: a shared tablet must not retain GM session or private cached
  // data (design §7.7). Cancel in-flight campaign reads and drop every cached
  // ["campaigns", ...] entry. Declared before the projection hook so the
  // removal runs before the first projection fetch on entry.
  const purgedRef = useRef(false);
  useEffect(() => {
    if (purgedRef.current) return;
    purgedRef.current = true;
    void queryClient.cancelQueries({ queryKey: ["campaigns"] });
    queryClient.removeQueries({ queryKey: ["campaigns"] });
  }, [queryClient]);

  const projection = useDisplayProjection(
    props.api as CampaignsApi,
    credential?.displayId ?? "",
    props.sceneId,
    revision,
    credential?.secret ?? null,
    { enabled: credential !== null && props.sceneId !== "" && online, online },
  );

  // Adopt the polled revision so the query key tracks the latest known
  // projection; the revision-keyed imageUrl stays Cache-Control friendly.
  useEffect(() => {
    const next = projection.data?.projection.sceneRevision;
    if (next !== undefined && next !== revision) setRevision(next);
  }, [projection.data, revision]);

  // Keep the last good frame across revision-key changes and poll failures:
  // a fresh credential with no frame yet renders connecting/blank instead.
  useEffect(() => {
    if (projection.data !== undefined) setShown(projection.data.projection);
  }, [projection.data]);

  const refetchRef = useRef((): void => {});
  refetchRef.current = () => {
    void projection.refetch();
  };
  useEffect(() => {
    if (credential === null || props.sceneId === "" || !online) return undefined;
    const id = window.setInterval(() => refetchRef.current(), pollMs);
    return () => window.clearInterval(id);
  }, [credential, props.sceneId, online, pollMs]);

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
      setRevision(0);
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
    setRevision(0);
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

  if (shown === null) {
    if (!online) {
      return (
        <section aria-label={t("display.title")}>
          <h1>{t("display.title")}</h1>
          <p role="status">{t("display.offline")}</p>
        </section>
      );
    }
    if (projection.status === "pending") {
      return (
        <section aria-label={t("display.title")}>
          <h1>{t("display.title")}</h1>
          <p role="status">{t("display.connecting")}</p>
        </section>
      );
    }
    const revoked = isNotFound(projection.error);
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.title")}</h1>
        <EmptyState
          title={revoked ? t("display.blank.title") : t("display.reconnecting.title")}
          description={revoked ? t("display.blank.description") : t("display.reconnecting.description")}
          action={
            <>
              <Button variant="primary" onClick={() => void projection.refetch()}>
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

  // A revoked credential must blank even when a good frame is cached
  // (design §7.7): a post-frame 404 replaces the frozen frame with the
  // blank state + disconnect affordance. Transient non-404 failures keep
  // the last good frame with a reconnecting notice instead.
  if (online && projection.status === "error" && isNotFound(projection.error)) {
    return (
      <section aria-label={t("display.title")}>
        <h1>{t("display.title")}</h1>
        <EmptyState
          title={t("display.blank.title")}
          description={t("display.blank.description")}
          action={
            <>
              <Button variant="primary" onClick={() => void projection.refetch()}>
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

  return (
    <section aria-label={t("display.title")}>
      <h1>{t("display.title")}</h1>
      <div style={{ position: "relative" }}>
        <img src={`/api${shown.imageUrl}`} alt={t("display.imageAlt")} style={{ display: "block", width: "100%" }} />
        <ul aria-label={t("display.tokensLabel")} style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.tokens.map((token) => (
            <li
              key={token.tokenId}
              style={{
                position: "absolute",
                left: `${token.x * 100}%`,
                top: `${token.y * 100}%`,
                transform: "translate(-50%, -50%)",
              }}
            >
              {token.label}
            </li>
          ))}
        </ul>
      </div>
      {!online ? <p role="status">{t("display.offline")}</p> : null}
      {online && projection.status === "error" ? (
        <p role="status">
          {t("display.reconnecting.title")}{" "}
          <Button variant="secondary" onClick={() => void projection.refetch()}>
            {t("display.retry")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
