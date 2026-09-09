import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import { CharacterSheet } from "./CharacterSheet.js";
import { CharacterTools } from "./CharacterTools.js";
import { ConflictReview } from "./ConflictReview.js";
import { CreateCharacter, type CreateCharacterIdentity } from "./CreateCharacter.js";
import { createCharacterSession, type CoordinationPort, type IdentityPort } from "./session.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import { useCharacterSession } from "./useCharacterSession.js";
import { useOfflineAvailability } from "../offline/useOfflineAvailability.js";
import styles from "./characters.module.css";

/**
 * SPA navigation callbacks for the character detail surface. The route
 * adapter (router-owned) supplies these; reusable components never import
 * router internals. When absent, plain anchors preserve standalone use
 * outside a RouterProvider.
 */
export type CharacterDetailNavigation = {
  onCreateNew(): void;
  onOpenLibrary(): void;
  onOpenCharacter(characterId: string): void;
};

export type CharacterDetailProps = {
  characterId: string;
  api: CharactersApi;
  store: CharacterStore;
  identity: IdentityPort;
  coordination: CoordinationPort;
  navigation?: CharacterDetailNavigation | undefined;
  /**
   * Whether the browser supports Web Lock takeover. Defaults to a runtime
   * check; tests inject this to simulate supported/unsupported browsers.
   */
  locksSupported?: boolean | undefined;
};

function browserSupportsTakeover(): boolean {
  if (typeof navigator === "undefined") return false;
  const locks = (navigator as unknown as { locks?: LockManager | null }).locks;
  return locks !== undefined && locks !== null;
}

/**
 * Standalone character route. Composes the shipped identity gate, durable
 * store, character session and renderer; the session is disposed on
 * navigation away. Reads only the current account's partition, so a deep
 * link can never expose another account's cache.
 *
 * The identity gate runs before any hook creates a session: with a null
 * actor this returns the sign-in fallback without building or opening a
 * character session, so no session is ever opened or sent with an empty
 * identity.
 */
export function CharacterDetail({ characterId, api, store, identity, coordination, navigation, locksSupported }: CharacterDetailProps) {
  const actorId = identity.getActorId();
  if (actorId === null) {
    return (
      <section aria-labelledby="character-detail-title">
        <h1 id="character-detail-title">{t("character.loading")}</h1>
        <p role="status">{t("character.detail.signIn")}</p>
      </section>
    );
  }
  return (
    <CharacterDetailLoaded
      characterId={characterId}
      api={api}
      store={store}
      identity={identity}
      coordination={coordination}
      actorId={actorId}
      navigation={navigation}
      locksSupported={locksSupported}
    />
  );
}

function RecoveryNav({
  cached,
  navigation,
}: {
  cached: Array<{ characterId: string; name: string }>;
  navigation: CharacterDetailNavigation | undefined;
}) {
  const linkProps = (navigate: () => void): { onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void } =>
    navigation === undefined
      // Intentional plain anchors: CharacterDetail also renders standalone
      // without a RouterProvider, where TanStack Link has no router context
      // and crashes.
      ? {}
      : {
        onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          navigate();
        },
      };
  return (
    <nav aria-label={t("character.detail.recoveryTitle")}>
      {cached.length > 0 ? (
        <>
          <h2>{t("character.detail.recoveryTitle")}</h2>
          <ul>
            {cached.map(entry => (
              <li key={entry.characterId}>
                <a
                  href={`/characters/${entry.characterId}`}
                  {...linkProps(() => navigation?.onOpenCharacter(entry.characterId))}
                >
                  {entry.name}
                </a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <a href="/characters/new" {...linkProps(() => navigation?.onCreateNew())}>{t("character.detail.createNew")}</a>
      <a href="/" {...linkProps(() => navigation?.onOpenLibrary())}>{t("character.detail.backToLibrary")}</a>
    </nav>
  );
}

function CharacterDetailLoaded({
  characterId,
  api,
  store,
  identity,
  coordination,
  actorId,
  navigation,
  locksSupported: locksSupportedProp,
}: CharacterDetailProps & { actorId: string }) {
  const online = identity.isOnline();
  const createSession = useMemo(
    () => () =>
      createCharacterSession({
        actorId,
        characterId,
        api,
        store,
        identity,
        coordination,
        now: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      }),
    [actorId, characterId, api, store, identity, coordination],
  );
  const { session, snapshot } = useCharacterSession(createSession);
  const offline = useOfflineAvailability(snapshot.confirmed);

  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    const fields = snapshot.confirmed?.projection.completionFields;
    if (snapshot.confirmed === null || fields === undefined || fields.length === 0) return;
    const key = `${actorId}:${characterId}`;
    if (focusedFor.current === key) return;
    focusedFor.current = key;
    document.getElementById("character-completion")?.focus();
  }, [snapshot.confirmed, actorId, characterId]);

  const [cached, setCached] = useState<Array<{ characterId: string; name: string }>>([]);
  const showRecovery =
    !online || snapshot.error !== null || (snapshot.confirmed === null && snapshot.phase !== "loading");
  useEffect(() => {
    if (!showRecovery) return;
    let cancelled = false;
    void store
      .listCharacters(actorId)
      .then(list => {
        if (!cancelled) setCached(list.filter(entry => entry.characterId !== characterId));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showRecovery, store, actorId, characterId]);

  // Explicit conflict/error review: conflicts, invalid values and expired
  // online attempts mount the review surface; every other session error is
  // shown as a command alert. Closing the review keeps a reopen control so
  // the workflow stays reachable until the session error clears.
  const reviewable =
    snapshot.error !== null &&
    (snapshot.error.kind === "conflict" ||
      snapshot.error.kind === "invalid" ||
      snapshot.error.kind === "expired-attempt");
  const [reviewDismissed, setReviewDismissed] = useState(false);
  useEffect(() => {
    if (!reviewable) setReviewDismissed(false);
  }, [reviewable]);
  const reviewOpen = reviewable && !reviewDismissed;

  // Single-tab editing takeover. The session owns coordination lifetime; this
  // control only asks the session to request editing. Unsupported Web Locks
  // explain why the tab stays read-only instead of offering unsafe editing.
  const locksSupported = locksSupportedProp ?? browserSupportsTakeover();
  const readOnly = session !== null && snapshot.confirmed !== null && !snapshot.editing.owned;
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [takeoverDenied, setTakeoverDenied] = useState(false);
  const requestTakeover = () => {
    if (session === null || takeoverBusy) return;
    setTakeoverBusy(true);
    setTakeoverDenied(false);
    const current = session;
    void current.requestEditing().then(
      granted => {
        setTakeoverBusy(false);
        if (!granted) setTakeoverDenied(true);
      },
      () => {
        setTakeoverBusy(false);
        setTakeoverDenied(true);
      },
    );
  };

  if (session === null || (snapshot.confirmed === null && snapshot.phase === "loading")) {
    return (
      <section aria-labelledby="character-detail-title">
        <h1 id="character-detail-title">{t("character.loading")}</h1>
        <p role="status">{t("character.loading")}</p>
      </section>
    );
  }
  if (snapshot.confirmed === null) {
    return (
      <section aria-labelledby="character-detail-title">
        <h1 id="character-detail-title">{t("character.loading")}</h1>
        <p role="alert">{t("character.detail.unavailable")}</p>
        {showRecovery ? <RecoveryNav cached={cached} navigation={navigation} /> : null}
      </section>
    );
  }
  return (
    <div className={styles.detail}>
      {!online ? <p role="status">{t("character.detail.offlineCached")}</p> : null}
      <p role="status">{snapshot.editing.owned ? t("character.detail.editing") : t("character.detail.readOnly")}</p>
      {readOnly ? (
        <section aria-labelledby="character-takeover-title">
          <h2 id="character-takeover-title">{t("character.detail.takeoverTitle")}</h2>
          {locksSupported ? (
            <>
              <button
                type="button"
                disabled={takeoverBusy || snapshot.phase === "loading"}
                onClick={requestTakeover}
              >
                {takeoverBusy ? t("character.detail.requestingEditing") : t("character.detail.requestEditing")}
              </button>
              {takeoverDenied ? <p role="alert">{t("character.detail.takeoverFailed")}</p> : null}
            </>
          ) : (
            <p>{t("character.detail.takeoverUnsupported")}</p>
          )}
        </section>
      ) : null}
      {snapshot.error !== null && !reviewOpen ? <p role="alert">{snapshot.error.message}</p> : null}
      <CharacterSheet
        snapshot={snapshot}
        onSetField={session.setField}
        onBump={session.bumpResource}
        onExecuteAction={session.executeAction}
        offlineAvailable={offline.available}
      />
      {reviewOpen ? (
        <ConflictReview
          snapshot={snapshot}
          onResolve={session.resolveConflict}
          onClose={() => setReviewDismissed(true)}
          onReviewExpiredAttempt={session.reviewExpiredAttempt}
        />
      ) : null}
      {reviewable && !reviewOpen ? (
        <button type="button" onClick={() => setReviewDismissed(false)}>
          {t("character.conflict.title")}
        </button>
      ) : null}
      <CharacterTools characterId={characterId} api={api} session={session} />
      {showRecovery ? <RecoveryNav cached={cached} navigation={navigation} /> : null}
    </div>
  );
}

export type NewCharacterRouteProps = {
  api: CharactersApi;
  store: CharacterStore | null;
  identity: CreateCharacterIdentity;
  initialSystemVersionId?: string | undefined;
  onCreated(characterId: string): void;
};

export function NewCharacterRoute({ api, store, identity, initialSystemVersionId, onCreated }: NewCharacterRouteProps) {
  if (store === null) {
    return (
      <section aria-labelledby="create-character-title">
        <h1 id="create-character-title">{t("character.create.title")}</h1>
        <p role="status">{t("shell.characterStorageUnavailable")}</p>
      </section>
    );
  }
  return (
    <CreateCharacter
      api={api}
      store={store}
      identity={identity}
      initialSystemVersionId={initialSystemVersionId}
      onCreated={onCreated}
    />
  );
}

let sharedStore: Promise<CharacterStore | null> | null = null;

function sharedStorePromise(): Promise<CharacterStore | null> {
  if (sharedStore === null) {
    sharedStore = openCharacterStore("sweetroll-characters").catch(() => null);
  }
  return sharedStore;
}

/** Router wrappers share one IndexedDB handle; null means storage is unavailable. */
export function useSharedCharacterStore(): CharacterStore | null | undefined {
  const [store, setStore] = useState<CharacterStore | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void sharedStorePromise().then(next => {
      if (!cancelled) setStore(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return store;
}
