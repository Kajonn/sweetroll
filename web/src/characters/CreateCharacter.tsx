import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import type { CharacterStore, OnlineAttempt } from "./store.js";
import type { CreationOptions, FrozenRequest } from "./types.js";

export type CreateCharacterIdentity = {
  getActorId(): string | null;
  isOnline(): boolean;
  /** Identity generation; when present, a change invalidates in-flight recovery. */
  getGeneration?(): number;
  /** Durable account recheck; when present, recovery is discarded unless current. */
  isCurrent?(): Promise<boolean>;
};

export type CreateCharacterProps = {
  api: CharactersApi;
  store: CharacterStore;
  identity: CreateCharacterIdentity;
  onCreated(characterId: string): void;
  /** Optional version ID from the `/characters/new` search input. */
  initialSystemVersionId?: string | undefined;
  newId?: () => string;
  now?: () => string;
};

type EntityOption = CreationOptions["data"]["entities"][number];

function extractCharacterId(response: unknown): string | null {
  if (response === null || typeof response !== "object") return null;
  const envelope = response as {
    result?: { character?: { characterId?: unknown } };
    character?: { characterId?: unknown };
  };
  const fromResult = envelope.result?.character?.characterId;
  const direct = envelope.character?.characterId;
  const candidate = typeof fromResult === "string" ? fromResult : typeof direct === "string" ? direct : null;
  return candidate !== null && candidate.length > 0 ? candidate : null;
}

function errorMessageKey(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "character.create.unauthorized";
  if (error instanceof ApiError && error.status === 422) return "character.create.invalid";
  return "character.create.uncertain";
}

/**
 * Online-only character creation. The exact frozen request (body and
 * idempotency key) is persisted per account before sending, so an uncertain
 * outcome or a reload retries the identical request instead of minting a
 * fresh key. This component never parses package exports; entity choices
 * come solely from authorized creation metadata.
 */
export function CreateCharacter({
  api, store, identity, onCreated, initialSystemVersionId,
  newId = () => crypto.randomUUID(), now = () => new Date().toISOString(),
}: CreateCharacterProps) {
  const [versionId, setVersionId] = useState(initialSystemVersionId ?? "");
  const [metadata, setMetadata] = useState<CreationOptions["data"] | null>(null);
  const [entityId, setEntityId] = useState("");
  const [name, setName] = useState("");
  const [metaLoading, setMetaLoading] = useState(false);
  const [metaDenied, setMetaDenied] = useState(false);
  const [pending, setPending] = useState<OnlineAttempt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const created = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const online = identity.isOnline();
  const actorId = identity.getActorId();
  const generation = identity.getGeneration?.() ?? 0;
  const seenActor = useRef<string | null | undefined>(undefined);

  // Recover a durable creation attempt left by an uncertain outcome or reload.
  // The recovery is scoped to the current account: an account switch clears
  // the previous account's pending attempt and restored fields instead of
  // replaying its frozen body/key under the new actor/session.
  useEffect(() => {
    let cancelled = false;
    const actorAtStart = identity.getActorId();
    const generationAtStart = identity.getGeneration?.() ?? 0;
    if (seenActor.current !== undefined && seenActor.current !== actorAtStart) {
      setPending(null);
      setVersionId("");
      setEntityId("");
      setName("");
      setMetadata(null);
      setMetaDenied(false);
      setError(null);
    }
    seenActor.current = actorAtStart;
    if (actorAtStart === null || !identity.isOnline()) {
      setPending(null);
      return;
    }
    void (async () => {
      let attempts;
      try {
        attempts = await store.readOnlineAttempts(actorAtStart);
      } catch {
        return;
      }
      if (cancelled || !mounted.current) return;
      if (identity.getActorId() !== actorAtStart) return;
      if ((identity.getGeneration?.() ?? 0) !== generationAtStart) return;
      if (identity.isCurrent) {
        try {
          if (!(await identity.isCurrent())) return;
        } catch {
          return;
        }
      }
      if (cancelled || !mounted.current) return;
      const create = attempts.find(attempt => attempt.kind === "create") ?? null;
      if (create === null) {
        setPending(null);
        return;
      }
      setPending(create);
      const body = create.request.body as { systemVersionId?: unknown; entityDefinitionId?: unknown; name?: unknown };
      if (typeof body.systemVersionId === "string") setVersionId(body.systemVersionId);
      if (typeof body.entityDefinitionId === "string") setEntityId(body.entityDefinitionId);
      if (typeof body.name === "string") setName(body.name);
      setError(t("character.create.pending"));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, actorId, online, generation]);

  const loadMetadata = async (version: string) => {
    setMetaLoading(true);
    setMetaDenied(false);
    setError(null);
    try {
      const options = await api.creationOptions(version);
      if (!mounted.current) return;
      setMetadata(options.data);
      // The entity list belongs to the freshly loaded version; a selection
      // restored from an older attempt may not exist here, so always reset.
      setEntityId("");
    } catch (metadataError) {
      if (!mounted.current) return;
      setMetadata(null);
      setEntityId("");
      if (
        metadataError instanceof ApiError &&
        (metadataError.status === 403 || metadataError.status === 404)
      ) {
        setMetaDenied(true);
      } else if (metadataError instanceof ApiError && metadataError.status === 401) {
        setMetaDenied(false);
        setError(t("character.create.unauthorized"));
      } else {
        setMetaDenied(false);
        setError(t("character.create.uncertain"));
      }
    } finally {
      if (mounted.current) setMetaLoading(false);
    }
  };

  // Prefill from the route search input exactly once.
  const initialLoaded = useRef(false);
  useEffect(() => {
    if (initialLoaded.current || !initialSystemVersionId || !online) return;
    initialLoaded.current = true;
    void loadMetadata(initialSystemVersionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSystemVersionId, online]);

  if (!online) {
    return (
      <section aria-labelledby="create-character-title">
        <h1 id="create-character-title">{t("character.create.title")}</h1>
        <p role="status">{t("character.create.offline")}</p>
      </section>
    );
  }

  if (actorId === null) {
    return (
      <section aria-labelledby="create-character-title">
        <h1 id="create-character-title">{t("character.create.title")}</h1>
        <p role="status">{t("character.create.signIn")}</p>
      </section>
    );
  }

  const submit = async (retry: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    // The durable attempt (not `pending` state, which is stale in this
    // closure on first submit) is the source of truth for cleanup.
    let attempt: OnlineAttempt | null = null;
    try {
      const actor = identity.getActorId();
      if (actor === null) {
        setError(t("character.create.signIn"));
        return;
      }
      if (!identity.isOnline()) {
        setError(t("character.create.offline"));
        return;
      }
      const stored = await store.readOnlineAttempts(actor);
      attempt = stored.find(entry => entry.kind === "create") ?? null;
      if (attempt === null) {
        if (!retry && (versionId.trim() === "" || entityId === "" || name.trim() === "")) return;
        // Only replay a frozen body/key that belongs to the current actor;
        // a previous account's attempt must never be sent under this actor.
        const source =
          retry && pending !== null && pending.actorId === actor
            ? (pending.request.body as Record<string, unknown>)
            : null;
        const body: Record<string, unknown> & { idempotencyKey: string } = source !== null && typeof source["idempotencyKey"] === "string"
          ? { ...(source as Record<string, unknown>), idempotencyKey: source["idempotencyKey"] as string }
          : {
            systemVersionId: versionId.trim(),
            entityDefinitionId: entityId,
            name: name.trim(),
            idempotencyKey: newId(),
          };
        const request: FrozenRequest = {
          method: "POST",
          path: "/characters",
          body,
          firstAttemptAt: now(),
        };
        attempt = {
          id: newId(),
          actorId: actor,
          characterId: null,
          kind: "create",
          request,
          createdAt: request.firstAttemptAt,
        };
        await store.saveOnlineAttempt(attempt);
        if (mounted.current) setPending(attempt);
      }
      // Reuse the durable attempt verbatim: the transport never mints a key.
      const response = await api.send(attempt.request);
      const characterId = extractCharacterId(response);
      if (characterId === null) {
        throw new ApiError({
          code: "malformed_response",
          message: "The server returned an unexpected response.",
          status: 200,
          requestId: "",
          latestRevision: null,
          diagnostics: [],
        });
      }
      await store.deleteOnlineAttempt(actor, attempt.id);
      if (mounted.current) setPending(null);
      if (!created.current) {
        created.current = true;
        onCreated(characterId);
      }
    } catch (requestError) {
      if (!mounted.current) return;
      if (requestError instanceof ApiError && requestError.status === 401) {
        setError(t(errorMessageKey(requestError)));
        return;
      }
      if (requestError instanceof ApiError && (requestError.status === 403 || requestError.status === 404)) {
        const failedId = attempt?.id;
        const actorNow = identity.getActorId();
        if (failedId && actorNow) {
          await store.deleteOnlineAttempt(actorNow, failedId).catch(() => {});
          if (mounted.current) setPending(null);
        }
        setError(t("character.create.denied"));
        return;
      }
      if (requestError instanceof ApiError && requestError.status === 422) {
        const failedId = attempt?.id;
        const actorNow = identity.getActorId();
        if (failedId && actorNow) {
          await store.deleteOnlineAttempt(actorNow, failedId).catch(() => {});
          if (mounted.current) setPending(null);
        }
        setError(t(errorMessageKey(requestError)));
        return;
      }
      setError(t(errorMessageKey(requestError)));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const entities: EntityOption[] = metadata?.entities ?? [];
  const canCreate =
    metadata !== null &&
    entityId !== "" &&
    entities.some(entity => entity.id === entityId) &&
    name.trim() !== "" &&
    !busy;

  return (
    <section aria-labelledby="create-character-title">
      <h1 id="create-character-title">{t("character.create.title")}</h1>
      {pending !== null ? <p role="status">{t("character.create.pending")}</p> : null}
      <form
        onSubmit={event => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <label htmlFor="create-character-version">{t("character.create.versionId")}</label>
        <input
          id="create-character-version"
          value={versionId}
          onChange={event => setVersionId(event.target.value)}
        />
        <button
          type="button"
          disabled={metaLoading || versionId.trim() === ""}
          onClick={() => void loadMetadata(versionId.trim())}
        >
          {metaLoading ? t("character.create.loadingMetadata") : t("character.create.lookUp")}
        </button>
        {metaDenied ? <p role="alert">{t("character.create.denied")}</p> : null}
        {metadata !== null ? (
          <>
            <label htmlFor="create-character-entity">{t("character.create.entity")}</label>
            <select
              id="create-character-entity"
              value={entityId}
              onChange={event => setEntityId(event.target.value)}
            >
              <option value="">{t("character.choice.empty")}</option>
              {entities.map(entity => (
                <option key={entity.id} value={entity.id}>{entity.label}</option>
              ))}
            </select>
            <label htmlFor="create-character-name">{t("character.create.name")}</label>
            <input
              id="create-character-name"
              value={name}
              onChange={event => setName(event.target.value)}
              required
            />
            <button type="submit" disabled={!canCreate}>
              {busy ? t("character.create.submitting") : t("character.create.submit")}
            </button>
          </>
        ) : null}
      </form>
      {error !== null ? <p role="alert">{error}</p> : null}
      {pending !== null ? (
        <button type="button" disabled={busy} onClick={() => void submit(true)}>
          {t("character.create.retry")}
        </button>
      ) : null}
    </section>
  );
}
