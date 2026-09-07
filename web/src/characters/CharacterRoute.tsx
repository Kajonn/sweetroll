import { useEffect, useMemo, useRef, useState } from "react";

import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import { CharacterSheet } from "./CharacterSheet.js";
import { CreateCharacter, type CreateCharacterIdentity } from "./CreateCharacter.js";
import { createCharacterSession, type CoordinationPort, type IdentityPort } from "./session.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import { useCharacterSession } from "./useCharacterSession.js";
import { useOfflineAvailability } from "../offline/useOfflineAvailability.js";

export type CharacterDetailProps = {
  characterId: string;
  api: CharactersApi;
  store: CharacterStore;
  identity: IdentityPort;
  coordination: CoordinationPort;
};

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
export function CharacterDetail({ characterId, api, store, identity, coordination }: CharacterDetailProps) {
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
    />
  );
}

function CharacterDetailLoaded({ characterId, api, store, identity, coordination, actorId }: CharacterDetailProps & { actorId: string }) {
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
        {showRecovery ? (
          <nav aria-label={t("character.detail.recoveryTitle")}>
            {/* Intentional plain anchors: CharacterDetail also renders
                standalone without a RouterProvider, where TanStack Link has
                no router context and crashes. */}
            <a href="/characters/new">{t("character.detail.createNew")}</a>
            <a href="/">{t("character.detail.backToLibrary")}</a>
          </nav>
        ) : null}
      </section>
    );
  }
  return (
    <div>
      {!online ? <p role="status">{t("character.detail.offlineCached")}</p> : null}
      <CharacterSheet snapshot={snapshot} onSetField={session.setField} onBump={session.bumpResource} offlineAvailable={offline.available} />
      {showRecovery ? (
        <nav aria-label={t("character.detail.recoveryTitle")}>
          <h2>{t("character.detail.recoveryTitle")}</h2>
          <ul>
            {cached.map(entry => (
              <li key={entry.characterId}>
                <a href={`/characters/${entry.characterId}`}>{entry.name}</a>
              </li>
            ))}
          </ul>
          <a href="/characters/new">{t("character.detail.createNew")}</a>
          <a href="/">{t("character.detail.backToLibrary")}</a>
        </nav>
      ) : null}
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
