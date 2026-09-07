import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api/client.js";
import { t } from "../i18n/index.js";
import type { CharactersApi } from "./api.js";
import type { CharacterStore, OnlineAttempt } from "./store.js";
import type { CreationOptions, FrozenRequest, ReviewExpiredAttemptInput } from "./types.js";

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

/** Mirrors the backend 30-day idempotency replay window (REPLAY_TTL_MS). */
const CREATION_REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_EXPIRED_RE = /replay window/i;

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
 * A creation attempt is reviewable only when replay can no longer resolve
 * it: locally aged past the 30-day replay window or durably flagged after
 * the backend declared this exact key's replay window expired. Anything
 * else still has a resolvable outcome and must be replayed, not retired.
 */
function isReviewableExpired(attempt: OnlineAttempt, nowIso: string): boolean {
  if (attempt.replayExpired === true) return true;
  const timestamp = attempt.createdAt || attempt.request.firstAttemptAt;
  return Date.parse(timestamp) < Date.parse(nowIso) - CREATION_REPLAY_TTL_MS;
}

/** Oldest-first creation ordering so one review boundary handles the earliest request. */
function oldestCreate(attempts: OnlineAttempt[]): OnlineAttempt | null {
  const creates = attempts.filter(attempt => attempt.kind === "create");
  creates.sort((a, b) => {
    const time =
      Date.parse(a.createdAt || a.request.firstAttemptAt) -
      Date.parse(b.createdAt || b.request.firstAttemptAt);
    return time !== 0 ? time : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return creates[0] ?? null;
}

function isReplayExpiredConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === "conflict" && REPLAY_EXPIRED_RE.test(error.message);
}

/**
 * Online-only character creation. The exact frozen request (body and
 * idempotency key) is persisted per account before sending, so an uncertain
 * outcome or a reload retries the identical request instead of minting a
 * fresh key. This component never parses package exports; entity choices
 * come solely from authorized creation metadata.
 *
 * Every submission captures its actor and identity generation up front and
 * revalidates the operation lifetime after each awaited boundary, with a
 * durable `isCurrent()` recheck immediately before the network send. All
 * online-attempt writes use transaction-level identity guards, so a delayed
 * response or broadcast can never send, retire or navigate under a changed
 * or disposed account lifetime.
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
  const [pending, setPendingState] = useState<OnlineAttempt | null>(null);
  const [expired, setExpiredState] = useState<OnlineAttempt | null>(null);
  const [recoveryLinks, setRecoveryLinks] = useState<Array<{ characterId: string; name: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const created = useRef(false);
  const mounted = useRef(true);
  /** Operation lifetime: bumped per submission and on every identity change. */
  const opToken = useRef(0);
  /** Ref mirrors so in-flight closures never act on stale state snapshots. */
  const pendingRef = useRef<OnlineAttempt | null>(null);
  const expiredRef = useRef<OnlineAttempt | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const setPending = (attempt: OnlineAttempt | null) => {
    pendingRef.current = attempt;
    if (mounted.current) setPendingState(attempt);
  };
  const setExpired = (attempt: OnlineAttempt | null) => {
    expiredRef.current = attempt;
    if (mounted.current) setExpiredState(attempt);
  };

  const online = identity.isOnline();
  const actorId = identity.getActorId();
  const generation = identity.getGeneration?.() ?? 0;
  const seenLifetime = useRef<{ actor: string | null; generation: number } | undefined>(undefined);

  const restoreFromAttempt = (attempt: OnlineAttempt) => {
    const body = attempt.request.body as { systemVersionId?: unknown; entityDefinitionId?: unknown; name?: unknown };
    if (typeof body.systemVersionId === "string") setVersionId(body.systemVersionId);
    if (typeof body.entityDefinitionId === "string") setEntityId(body.entityDefinitionId);
    if (typeof body.name === "string") setName(body.name);
  };

  // Recover a durable creation attempt left by an uncertain outcome or reload.
  // The recovery is scoped to the current account lifetime (actor and
  // identity generation): a switch clears the previous lifetime's pending
  // attempt and restored fields instead of replaying its frozen body/key
  // under the new actor/session. Late results from old lifetimes are ignored;
  // unresolved attempts stay preserved under their original account unless
  // explicit logout cleared them.
  useEffect(() => {
    let cancelled = false;
    const actorAtStart = identity.getActorId();
    const generationAtStart = identity.getGeneration?.() ?? 0;
    const previous = seenLifetime.current;
    if (previous !== undefined && (previous.actor !== actorAtStart || previous.generation !== generationAtStart)) {
      opToken.current += 1;
      submitting.current = false;
      created.current = false;
      pendingRef.current = null;
      expiredRef.current = null;
      setPendingState(null);
      setExpiredState(null);
      setRecoveryLinks([]);
      setVersionId("");
      setEntityId("");
      setName("");
      setMetadata(null);
      setMetaDenied(false);
      setError(null);
      setBusy(false);
    }
    seenLifetime.current = { actor: actorAtStart, generation: generationAtStart };
    if (actorAtStart === null || !identity.isOnline()) {
      setPendingState(null);
      setExpiredState(null);
      pendingRef.current = null;
      expiredRef.current = null;
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
      if (identity.getActorId() !== actorAtStart) return;
      if ((identity.getGeneration?.() ?? 0) !== generationAtStart) return;
      const create = oldestCreate(attempts);
      if (create === null) {
        setPending(null);
        setExpired(null);
        return;
      }
      if (isReviewableExpired(create, now())) {
        setPending(null);
        setExpired(create);
        setError(t("character.create.expired"));
        let links: Array<{ characterId: string; name: string }> = [];
        try {
          links = await store.listCharacters(actorAtStart);
        } catch {
          links = [];
        }
        if (cancelled || !mounted.current) return;
        if (identity.getActorId() !== actorAtStart) return;
        if ((identity.getGeneration?.() ?? 0) !== generationAtStart) return;
        setRecoveryLinks(links);
        return;
      }
      setExpired(null);
      setPending(create);
      restoreFromAttempt(create);
      setError(t("character.create.pending"));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, actorId, online, generation]);

  const loadMetadata = async (version: string) => {
    const actorAtStart = identity.getActorId();
    const generationAtStart = identity.getGeneration?.() ?? 0;
    const alive = () =>
      mounted.current &&
      identity.getActorId() === actorAtStart &&
      (identity.getGeneration?.() ?? 0) === generationAtStart;
    setMetaLoading(true);
    setMetaDenied(false);
    setError(null);
    try {
      const options = await api.creationOptions(version);
      if (!alive()) return;
      setMetadata(options.data);
      // The entity list belongs to the freshly loaded version; a selection
      // restored from an older attempt may not exist here, so always reset.
      setEntityId("");
    } catch (metadataError) {
      if (!alive()) return;
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
      if (alive()) setMetaLoading(false);
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

  /** Durable currency recheck used immediately before sending and after responses. */
  const recheckDurable = async (): Promise<boolean> => {
    if (!identity.isCurrent) return true;
    try {
      return await identity.isCurrent();
    } catch {
      return false;
    }
  };

  async function handleSendError(
    sendError: unknown,
    attempt: OnlineAttempt,
    guard: { generation: number; accountGeneration: number },
    alive: () => boolean,
  ): Promise<void> {
    if (sendError instanceof ApiError && sendError.status === 401) {
      if (!alive()) return;
      setPending(attempt);
      setError(t(errorMessageKey(sendError)));
      return;
    }
    if (sendError instanceof ApiError && (sendError.status === 403 || sendError.status === 404)) {
      // Definitive rejection: the server answered, so nothing is uncertain.
      // Retire exactly the captured attempt under its own actor/ID — never
      // whichever account happens to be current later.
      try {
        await store.retireOnlineAttempt(attempt.actorId, null, attempt.id, guard);
      } catch {
        if (!alive()) return;
        setPending(attempt);
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      setPending(null);
      setError(t("character.create.denied"));
      return;
    }
    if (sendError instanceof ApiError && sendError.status === 422) {
      try {
        await store.retireOnlineAttempt(attempt.actorId, null, attempt.id, guard);
      } catch {
        if (!alive()) return;
        setPending(attempt);
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      setPending(null);
      setError(t(errorMessageKey(sendError)));
      return;
    }
    if (sendError instanceof ApiError && sendError.code === "idempotency_mismatch") {
      // Protocol stop, mirroring the session: the key collided with different
      // input, so replaying it can never succeed and minting a new key would
      // hide a possible duplicate. Retire the captured attempt, clear pending
      // so no Retry is offered, and require manual review before creating.
      try {
        await store.retireOnlineAttempt(attempt.actorId, null, attempt.id, guard);
      } catch {
        if (!alive()) return;
        setPending(attempt);
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      setPending(null);
      setError(t("character.create.protocolStop"));
      return;
    }
    if (isReplayExpiredConflict(sendError)) {
      // Uncertain, not rejected: the server forgot this key's receipt, which
      // proves nothing about whether the effect applied. Retain verbatim,
      // flag for explicit review and never auto-retry or auto-mint.
      try {
        await store.markOnlineAttemptReplayExpired(attempt.actorId, null, attempt.id, guard);
      } catch {
        if (!alive()) return;
        setPending(attempt);
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      await enterExpiredReview({ ...attempt, replayExpired: true }, alive);
      return;
    }
    if (!alive()) return;
    setPending(attempt);
    setError(t(errorMessageKey(sendError)));
  }

  /**
   * Shows the expired-create review for a retained attempt: the original
   * request is kept for explicit review, never retried automatically and
   * never replaced with a fresh key. Ordinary creation stays blocked until
   * the user explicitly acknowledges the unknown outcome.
   */
  async function enterExpiredReview(attempt: OnlineAttempt, alive: () => boolean): Promise<void> {
    let links: Array<{ characterId: string; name: string }> = [];
    try {
      links = await store.listCharacters(attempt.actorId);
    } catch {
      links = [];
    }
    if (!alive()) return;
    setPending(null);
    setExpired(attempt);
    setRecoveryLinks(links);
    setError(t("character.create.expired"));
  }

  const submit = async (retry: boolean) => {
    if (submitting.current) return;
    submitting.current = true;
    const token = ++opToken.current;
    const actorAtSubmit = identity.getActorId();
    const generationAtSubmit = identity.getGeneration?.() ?? 0;
    const alive = () =>
      mounted.current &&
      opToken.current === token &&
      identity.getActorId() === actorAtSubmit &&
      (identity.getGeneration?.() ?? 0) === generationAtSubmit;
    setBusy(true);
    setError(null);
    // The durable attempt (not `pending` state, which is stale in this
    // closure on first submit) is the source of truth for cleanup.
    let attempt: OnlineAttempt | null = null;
    try {
      if (actorAtSubmit === null) {
        if (alive()) setError(t("character.create.signIn"));
        return;
      }
      if (!identity.isOnline()) {
        if (alive()) setError(t("character.create.offline"));
        return;
      }
      let accountGeneration: number;
      try {
        accountGeneration = (await store.readIdentity()).generation;
      } catch {
        if (alive()) setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      let stored: OnlineAttempt[];
      try {
        stored = await store.readOnlineAttempts(actorAtSubmit);
      } catch {
        if (alive()) setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      if (!(await recheckDurable())) return;
      if (!alive()) return;
      const guard = { generation: 0, accountGeneration };
      attempt = oldestCreate(stored);
      if (attempt !== null) {
        // Only replay a frozen body/key that belongs to the current actor;
        // a previous account's attempt must never be sent under this actor.
        if (attempt.actorId !== actorAtSubmit) return;
        if (isReviewableExpired(attempt, now())) {
          await enterExpiredReview(attempt, alive);
          return;
        }
      }
      if (attempt === null) {
        if (!retry && (versionId.trim() === "" || entityId === "" || name.trim() === "")) return;
        const replayable =
          retry && pendingRef.current !== null && pendingRef.current.actorId === actorAtSubmit
            ? (pendingRef.current.request.body as Record<string, unknown>)
            : null;
        const body: Record<string, unknown> & { idempotencyKey: string } =
          replayable !== null && typeof replayable["idempotencyKey"] === "string"
            ? { ...replayable, idempotencyKey: replayable["idempotencyKey"] as string }
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
          actorId: actorAtSubmit,
          characterId: null,
          kind: "create",
          request,
          createdAt: request.firstAttemptAt,
        };
        try {
          await store.saveOnlineAttempt(attempt, guard);
        } catch {
          if (alive()) {
            setPending(null);
            setError(t("character.create.storageError"));
          }
          return;
        }
        if (!alive()) return;
        if (!(await recheckDurable())) return;
        if (!alive()) return;
        setPending(attempt);
      }
      // Durable recheck immediately before the network send: no old-account
      // attempt may be sent using a new session.
      if (!alive()) return;
      if (!(await recheckDurable())) return;
      if (!alive()) return;
      // Reuse the durable attempt verbatim: the transport never mints a key.
      let response: Awaited<ReturnType<CharactersApi["send"]>>;
      try {
        response = await api.send(attempt.request);
      } catch (sendError) {
        await handleSendError(sendError, attempt, guard, alive);
        return;
      }
      if (!alive()) return;
      if (!(await recheckDurable())) return;
      if (!alive()) return;
      const characterId = extractCharacterId(response);
      if (characterId === null) {
        if (alive()) {
          setPending(attempt);
          setError(t("character.create.uncertain"));
        }
        return;
      }
      try {
        await store.retireOnlineAttempt(attempt.actorId, null, attempt.id, guard);
      } catch {
        if (!alive()) return;
        setPending(attempt);
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      setPending(null);
      if (!created.current) {
        created.current = true;
        onCreated(characterId);
      }
    } finally {
      if (opToken.current === token) {
        submitting.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  /**
   * Explicit unknown-outcome review for one retained expired creation
   * attempt, scoped to its account rather than a character ID. This is not
   * a retry and never mints a replacement mutation: after gating, it
   * refreshes the cached account state and retires exactly the identified
   * attempt. Offline, stale, other-account and unexpired reviews are
   * rejected without touching any attempt.
   */
  const acknowledgeExpired = async (input: ReviewExpiredAttemptInput): Promise<void> => {
    if (submitting.current) return;
    submitting.current = true;
    const token = ++opToken.current;
    const actorAtReview = identity.getActorId();
    const generationAtReview = identity.getGeneration?.() ?? 0;
    const alive = () =>
      mounted.current &&
      opToken.current === token &&
      identity.getActorId() === actorAtReview &&
      (identity.getGeneration?.() ?? 0) === generationAtReview;
    setBusy(true);
    try {
      const target = expiredRef.current;
      if (target === null || target.id !== input.attemptId) return;
      if (input.acknowledgeUnknownOutcome !== true) {
        if (alive()) setError(t("character.create.expired"));
        return;
      }
      if (actorAtReview === null) {
        if (alive()) setError(t("character.create.signIn"));
        return;
      }
      if (!identity.isOnline()) {
        if (alive()) setError(t("character.create.offline"));
        return;
      }
      if (target.actorId !== actorAtReview) return;
      let accountGeneration: number;
      try {
        accountGeneration = (await store.readIdentity()).generation;
      } catch {
        if (alive()) setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      if (!(await recheckDurable())) return;
      if (!alive()) return;
      const stored =
        (await store.readOnlineAttempts(actorAtReview).catch(() => null))?.find(
          candidate => candidate.id === target.id && candidate.kind === "create" && candidate.characterId === null,
        ) ?? null;
      if (!alive()) return;
      if (stored === null) {
        const remaining = await store.readOnlineAttempts(actorAtReview).catch(() => null);
        if (!alive() || remaining === null) return;
        const next = oldestCreate(remaining);
        setExpired(null);
        if (next !== null && !isReviewableExpired(next, now())) {
          setPending(next);
          restoreFromAttempt(next);
          setError(t("character.create.pending"));
        } else {
          setPending(null);
          setError(null);
        }
        return;
      }
      if (!isReviewableExpired(stored, now())) {
        if (alive()) {
          setExpired(null);
          setPending(stored);
          restoreFromAttempt(stored);
          setError(t("character.create.pending"));
        }
        return;
      }
      // Refresh the cached account state first: without a review base there
      // is nothing to accept, so a failed refresh never retires.
      const links = await store.listCharacters(actorAtReview).catch(() => null);
      if (!alive()) return;
      if (links === null) {
        setError(t("character.create.storageError"));
        return;
      }
      setRecoveryLinks(links);
      try {
        await store.retireOnlineAttempt(actorAtReview, null, stored.id, { generation: 0, accountGeneration });
      } catch {
        if (!alive()) return;
        setError(t("character.create.storageError"));
        return;
      }
      if (!alive()) return;
      const remaining = await store.readOnlineAttempts(actorAtReview).catch(() => null);
      if (!alive() || remaining === null) return;
      const next = oldestCreate(remaining);
      setExpired(null);
      if (next !== null && !isReviewableExpired(next, now())) {
        setPending(next);
        restoreFromAttempt(next);
        setError(t("character.create.pending"));
      } else if (next !== null) {
        await enterExpiredReview(next, alive);
      } else {
        setPending(null);
        setError(null);
      }
    } finally {
      if (opToken.current === token) {
        submitting.current = false;
        if (mounted.current) setBusy(false);
      }
    }
  };

  const entities: EntityOption[] = metadata?.entities ?? [];
  const canCreate =
    metadata !== null &&
    expired === null &&
    entityId !== "" &&
    entities.some(entity => entity.id === entityId) &&
    name.trim() !== "" &&
    !busy;
  const expiredAttempt = expired;

  return (
    <section aria-labelledby="create-character-title">
      <h1 id="create-character-title">{t("character.create.title")}</h1>
      {pending !== null && expiredAttempt === null ? <p role="status">{t("character.create.pending")}</p> : null}
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
      {pending !== null && expiredAttempt === null ? (
        <button type="button" disabled={busy} onClick={() => void submit(true)}>
          {t("character.create.retry")}
        </button>
      ) : null}
      {expiredAttempt !== null ? (
        <div>
          {recoveryLinks.length > 0 ? (
            <nav aria-label={t("character.detail.recoveryTitle")}>
              <h2>{t("character.detail.recoveryTitle")}</h2>
              <ul>
                {recoveryLinks.map(entry => (
                  <li key={entry.characterId}>
                    <a href={`/characters/${entry.characterId}`}>{entry.name}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void acknowledgeExpired({ attemptId: expiredAttempt.id, acknowledgeUnknownOutcome: true })}
          >
            {t("character.create.acknowledgeUnknown")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
