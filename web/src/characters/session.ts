import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import type { CharacterStore, OnlineAttempt } from "./store.js";
import type {
  CharacterView,
  CommandResultResponse,
  EditIntent,
  FrozenRequest,
  LastMigrationResult,
  QueueEntry,
  ResolveConflictInput,
  ReviewExpiredAttemptInput,
  SessionPhase,
} from "./types.js";

export type BlockingErrorKind =
  | "conflict"
  | "invalid"
  | "reauthenticate"
  | "storage-error"
  | "purged"
  | "expired-attempt"
  | "protocol"
  | "not-found"
  | "network-unavailable";

export type BlockingError = {
  kind: BlockingErrorKind;
  message: string;
  details?: unknown;
};

/**
 * Identity port. The browser adapter plugs into real auth state.
 * The session only ever sends commands while the current authenticated
 * actor matches this session's actor and the identity generation is
 * unchanged (identity switches tombstone every in-flight send).
 */
export type IdentityPort = {
  /** Verified actor, last confirmed offline actor, or null without a cache identity. */
  getActorId(): string | null;
  /** True when a live authenticated session is available. */
  isOnline(): boolean;
  /** Identity generation; any change invalidates all in-flight sends. */
  getGeneration(): number;
  /** Recheck the durable account/barrier even if a cross-tab invalidation is delayed. */
  isCurrent(): Promise<boolean>;
  /** Auth-state change notification. */
  subscribe(listener: () => void): () => void;
};

export type CoordinationEvent =
  | { type: "ownership-changed"; owned: boolean; owner: string | null }
  | { type: "invalidate"; characterId: string };

/**
 * Coordination port. The browser adapter (Task 6) backs this with Web Locks
 * (editing ownership for the whole sync period) and BroadcastChannel
 * (takeover/invalidation broadcasts). The store stays authoritative.
 */
export type CoordinationPort = {
  /** True when this session currently owns editing for the character. */
  isOwner(): boolean;
  /** Try to acquire editing ownership. Resolves with the grant result. */
  requestEditing(): Promise<boolean>;
  /** Release editing ownership (e.g. on dispose or explicit let-go). */
  letGo(): void;
  /** Broadcast ownership changes / invalidation events. */
  subscribe(listener: (event: CoordinationEvent) => void): () => void;
  /** Browser ownership release must await this callback before ending its Web Lock. */
  setQuiesce?(callback: () => Promise<void>): void;
  invalidate?(): void;
  dispose?(): void;
  requestTakeover?(): Promise<boolean>;
};

export type CharacterSnapshot = {
  phase: SessionPhase;
  confirmed: CharacterView | null;
  tentative: Record<string, unknown> | null;
  entries: QueueEntry[];
  editing: { owned: boolean; owner?: string | null };
  error: BlockingError | null;
  /** The latest authoritative roll result received during this open session. */
  lastRoll: CommandResultResponse["result"]["roll"];
  /** The latest successful migration commit/rollback, kept for later UI use. */
  lastMigration: LastMigrationResult | null;
  /**
   * Unresolved per-character online attempts (archive/recover/migration).
   * They replay verbatim before any newer command; only explicit
   * unknown-outcome review retires an expired one.
   */
  pendingOnlineAttempts: OnlineAttempt[];
};

export type CharacterSession = {
  open(): Promise<void>;
  getSnapshot(): CharacterSnapshot;
  subscribe(listener: (snapshot: CharacterSnapshot) => void): () => void;
  setField(fieldId: string, value: unknown): Promise<void>;
  bumpResource(resourceId: string, direction: "up" | "down"): Promise<void>;
  executeAction(actionId: string, inputs?: Record<string, unknown>): Promise<void>;
  resolveConflict(input: ResolveConflictInput): Promise<void>;
  archive(): Promise<void>;
  recover(): Promise<void>;
  commitMigration(previewId: string): Promise<void>;
  rollbackMigration(migrationId: string): Promise<void>;
  /**
   * Explicit unknown-outcome review for one retained expired online attempt.
   * Never retries the stored request and never mints a replacement: it
   * retires exactly the identified attempt after fetching current authorized
   * state, and only when the caller explicitly accepts the unknown outcome.
   */
  reviewExpiredAttempt(input: ReviewExpiredAttemptInput): Promise<void>;
  requestEditing(): Promise<boolean>;
  /** Test/support helper: resolves when the serialized drain is idle. */
  whenIdle(): Promise<void>;
  dispose(): void;
};

export type CreateCharacterSessionInput = {
  actorId: string;
  characterId: string;
  api: CharactersApi;
  store: CharacterStore;
  identity: IdentityPort;
  coordination: CoordinationPort;
  now: () => string;
  newId: () => string;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Backend-declared idempotency replay-window expiry for one exact key. */
const REPLAY_EXPIRED_RE = /replay window/i;

const KIND_TO_PHASE: Record<BlockingErrorKind, SessionPhase> = {
  conflict: "conflict",
  invalid: "invalid",
  reauthenticate: "reauthenticate",
  "storage-error": "storage-error",
  purged: "purged",
  "expired-attempt": "conflict",
  protocol: "conflict",
  "not-found": "conflict",
  "network-unavailable": "offline",
};

type SendOutcome = "acked" | "retry" | "blocked";

function structuredError(message: string, kind: BlockingErrorKind, details?: unknown): Error & { kind?: BlockingErrorKind } {
  const err = new Error(message) as Error & { kind?: BlockingErrorKind };
  err.kind = kind;
  if (details !== undefined) {
    (err as Error & { details?: unknown }).details = details;
  }
  return err;
}

function isStaleAck(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("stale ");
}

function projectionsEqual(a: CharacterView["projection"], b: CharacterView["projection"]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * An entry is authorized to send only against the confirmed base it was
 * reviewed for. Anything else must pause for explicit review instead of
 * silently inheriting an unrelated external revision.
 */
function entryMatchesBase(entry: QueueEntry, base: CharacterView): boolean {
  if (entry.baseRevision !== base.reconciliation.revision ||
      entry.packageChecksum !== base.projection.packageChecksum) {
    return false;
  }
  if (entry.attempt !== null) {
    const expected = (entry.attempt.body as { expectedRevision?: unknown }).expectedRevision;
    if (typeof expected === "number" && expected !== base.reconciliation.revision) {
      return false;
    }
  }
  return true;
}

export function createCharacterSession(input: CreateCharacterSessionInput): CharacterSession {
  const { actorId, characterId, api, store, identity, coordination, now, newId } = input;

  let confirmed: CharacterView | null = null;
  let entries: QueueEntry[] = [];
  let pendingOnline: OnlineAttempt[] = [];
  let generation = 0;
  let accountGeneration = 0;
  let nextSequence = 0;
  let phase: SessionPhase = "loading";
  let error: BlockingError | null = null;
  let lastRoll: CommandResultResponse["result"]["roll"] = null;
  let lastMigration: LastMigrationResult | null = null;
  let editing: { owned: boolean; owner: string | null } = { owned: coordination.isOwner(), owner: null };
  let disposed = false;
  /** In-flight online sends/reviews, awaited by the ownership quiesce hook. */
  const activeOnline = new Set<Promise<unknown>>();

  const identityGeneration = identity.getGeneration();
  const listeners = new Set<(snapshot: CharacterSnapshot) => void>();
  const freezeWaiters = new Map<string, { resolve: () => void; reject: (err: unknown) => void }>();
  const entryWrites = new Map<string, Promise<void>>();

  let draining = false;
  let initialized = false;
  let opening: Promise<void> | null = null;
  let recovering: Promise<void> | null = null;
  let needsFresh = true;
  let conflictRefreshPending = false;
  let conflictMinimumRevision = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let transientFailures = 0;
  const idleWaiters: (() => void)[] = [];

  const resolveIdle = () => {
    const waiters = idleWaiters.splice(0);
    for (const w of waiters) w();
  };

  const emit = () => {
    cachedSnapshot = null;
    const snapshot = getSnapshot();
    for (const listener of [...listeners]) listener(snapshot);
  };

  let cachedSnapshot: CharacterSnapshot | null = null;
  function identityMatches(): boolean {
    return !disposed && identity.getActorId() === actorId && identity.getGeneration() === identityGeneration;
  }
  async function identityIsCurrent(): Promise<boolean> {
    return identityMatches() && await identity.isCurrent() && identityMatches();
  }
  function getSnapshot(): CharacterSnapshot {
    const visible = identityMatches();
    return cachedSnapshot ??= {
      phase,
      confirmed: visible ? confirmed : null,
      tentative: visible ? computeTentative() : null,
      entries: visible ? entries.filter((e) => !entryWrites.has(e.id)).map((e) => ({ ...e })) : [],
      editing: { ...editing, owned: visible && editing.owned },
      error: visible && error ? { ...error } : null,
      lastRoll: visible ? lastRoll : null,
      lastMigration: visible ? lastMigration : null,
      pendingOnlineAttempts: visible ? pendingOnline.map((a) => ({ ...a, request: { ...a.request, body: { ...a.request.body } } })) : [],
    };
  }

  function computeTentative(): Record<string, unknown> | null {
    if (!confirmed) return null;
    const values: Record<string, unknown> = {};
    for (const entry of entries) {
      if (entry.intent.kind === "setField") {
        values[entry.intent.fieldId] = entry.intent.value;
      } else if (entry.intent.kind === "bumpResource") {
        const current = (values[entry.intent.resourceId] as { up: number; down: number } | undefined) ?? {
          up: 0,
          down: 0,
        };
        if (entry.intent.direction === "up") current.up += 1;
        else current.down += 1;
        values[entry.intent.resourceId] = current;
      }
    }
    return Object.keys(values).length > 0 ? values : null;
  }

  function isConnected(): boolean {
    return identity.getActorId() === actorId && identity.isOnline() && identity.getGeneration() === identityGeneration;
  }

  function isBlocked(): boolean {
    return error !== null;
  }

  function setBlocked(kind: BlockingErrorKind, message: string, details?: unknown) {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    error = { kind, message };
    if (details !== undefined) error.details = details;
    phase = KIND_TO_PHASE[kind];
  }

  function assertMutationAllowed() {
    if (disposed) throw new Error("Session closed.");
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (error) throw structuredError(error.message, error.kind, error.details);
    if (!editing.owned || !coordination.isOwner()) throw structuredError("Editing requires ownership of a supported browser Web Lock.", "conflict");
    if (!confirmed) throw new Error("Cannot edit until the character is loaded.");
  }

  function baseForNewEntry(): number {
    const last = entries[entries.length - 1];
    if (last) return last.baseRevision;
    return confirmed?.reconciliation.revision ?? 1;
  }

  function newEntry(intent: EditIntent): QueueEntry {
    return {
      id: newId(),
      actorId,
      characterId,
      sequence: nextSequence++,
      baseRevision: baseForNewEntry(),
      packageChecksum: confirmed?.projection.packageChecksum ?? "unknown",
      createdAt: now(),
      intent,
      attempt: null,
    };
  }

  async function persistEntry(entry: QueueEntry): Promise<void> {
    const waiter = new Promise<void>((resolve, reject) => {
      freezeWaiters.set(entry.id, { resolve, reject });
    });
    let resolveWrite!: () => void;
    let rejectWrite!: (err: unknown) => void;
    const writeDone = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    entryWrites.set(entry.id, writeDone);
    entries = [...entries, entry].sort((a, b) => a.sequence - b.sequence);
    scheduleDrain();
    try {
      await store.enqueue(entry, { generation, accountGeneration });
      coordination.invalidate?.();
    } catch (storageErr) {
      rejectWrite(storageErr);
      entryWrites.delete(entry.id);
      entries = entries.filter(e => e.id !== entry.id);
      if (isStaleAck(storageErr)) {
        if (await identityIsCurrent()) await handleAckError(storageErr);
      } else setBlocked("storage-error", "Could not save your edit because local storage is unavailable.");
      freezeWaiters.delete(entry.id);
      emit();
      throw storageErr instanceof Error ? storageErr : new Error("storage failure");
    }
    resolveWrite();
    entryWrites.delete(entry.id);
    resolveFreezeWaiter(entry.id);
    await waiter;
    emit();
  }

  function resolveFreezeWaiter(entryId: string) {
    const waiter = freezeWaiters.get(entryId);
    if (waiter) {
      freezeWaiters.delete(entryId);
      waiter.resolve();
    }
  }

  function buildFrozenRequest(entry: QueueEntry): FrozenRequest {
    const expectedRevision = confirmed?.reconciliation.revision ?? entry.baseRevision;
    const method = "POST" as const;
    const firstAttemptAt = now();
    const key = newId();
    if (entry.intent.kind === "setField") {
      return {
        method,
        path: `/characters/${characterId}/fields/${entry.intent.fieldId}/set`,
        body: { value: entry.intent.value, expectedRevision, idempotencyKey: key },
        firstAttemptAt,
      };
    }
    if (entry.intent.kind === "bumpResource") {
      return {
        method,
        path: `/characters/${characterId}/resources/${entry.intent.resourceId}/bump`,
        body: { direction: entry.intent.direction, expectedRevision, idempotencyKey: key },
        firstAttemptAt,
      };
    }
    return {
      method,
      path: `/characters/${characterId}/actions/${entry.intent.actionId}`,
      body: {
        inputs: entry.intent.inputs ?? {},
        expectedRevision,
        idempotencyKey: key,
      },
      firstAttemptAt,
    };
  }

  function isExpired(entry: QueueEntry): boolean {
    const timestamp = entry.attempt?.firstAttemptAt ?? entry.createdAt;
    return Date.parse(timestamp) < Date.parse(now()) - THIRTY_DAYS_MS;
  }

  async function handleNotFound(err: ApiError): Promise<SendOutcome> {
    if (err.cacheDisposition === "purge") {
      try {
        await store.purgeCharacter(actorId, characterId);
        coordination.invalidate?.();
      } catch {
        // never surface private character contents
      }
      confirmed = null;
      entries = [];
      setBlocked("purged", "This character is no longer available.");
      return "blocked";
    }
    setBlocked("not-found", "This character could not be loaded.");
    return "blocked";
  }

  async function handleAckError(err: unknown): Promise<SendOutcome> {
    if (isStaleAck(err)) {
      const fresh = await store.read(actorId, characterId);
      confirmed = fresh.confirmed;
      entries = fresh.entries;
      generation = fresh.generation;
      if (confirmed === null) {
        setBlocked("purged", "This character is no longer available.");
      } else {
        setBlocked("conflict", "State changed while a request was in flight. Review before continuing.");
      }
      return "blocked";
    }
    // A purge or account clear beneath an in-flight request deletes attempts
    // and nulls the snapshot: a "not found" write failure afterwards reports
    // that terminal state rather than a storage error. A session that never
    // confirmed anything keeps the storage-error diagnosis.
    if (confirmed !== null) {
      const fresh = await store.read(actorId, characterId).catch(() => null);
      if (fresh !== null && identityMatches() && fresh.confirmed === null) {
        confirmed = null;
        entries = fresh.entries;
        generation = fresh.generation;
        accountGeneration = fresh.accountGeneration;
        await refreshPendingOnline();
        setBlocked("purged", "This character is no longer available.");
        return "blocked";
      }
    }
    setBlocked("storage-error", "Could not persist the confirmed state. Storage is unavailable.");
    return "blocked";
  }

  async function fetchLatestForConflict(latestRevision: number | null = null): Promise<void> {
    if (!await identityIsCurrent() || !isConnected() || !coordination.isOwner()) return;
    conflictRefreshPending = true;
    conflictMinimumRevision = Math.max(conflictMinimumRevision, latestRevision ?? 0);
    try {
      const envelope = await api.open(characterId);
      if (!await identityIsCurrent()) return;
      const server = envelope.character;
      const local = confirmed;
      if (server.reconciliation.revision < Math.max(local?.reconciliation.revision ?? 0, conflictMinimumRevision)) {
        // A lagging GET is not a review base for the revision the conflict reported.
        setBlocked("network-unavailable", "The latest character state is not available yet. Retry before reviewing.");
        return;
      }
      await reconcile(server);
      if (error === null || error.kind === "conflict") conflictRefreshPending = false;
    } catch (err) {
      if (!await identityIsCurrent()) return;
      await handleOpenError(err);
      return;
    }
    if (error === null) {
      setBlocked("conflict", "The character changed on the server. Review before re-sending.");
    }
  }

  async function handleSendError(err: unknown): Promise<SendOutcome> {
    if (err instanceof ApiError) {
      if (err.code === "idempotency_mismatch") {
        setBlocked("protocol", "The server rejected this request's idempotency key. Manual review is required.");
        return "blocked";
      }
      // command_in_progress arrives with a 409 status: it must back off with
      // the same request, so check codes before the status switch.
      if (err.code === "command_in_progress" || err.code === "temporarily_unavailable") {
        phase = "uncertain";
        transientFailures += 1;
        return "retry";
      }
      switch (err.status) {
        case 401:
          setBlocked("reauthenticate", "Your session expired. Sign in again to continue.");
          return "blocked";
        case 409:
          await fetchLatestForConflict(err.latestRevision);
          return "blocked";
        case 422:
          setBlocked("invalid", err.message, { diagnostics: err.diagnostics });
          return "blocked";
      }
      if (err.code === "expected_revision_mismatch") {
        await fetchLatestForConflict(err.latestRevision);
        return "blocked";
      }
      if (err.code === "invalid_value" || err.code === "bad_request") {
        setBlocked("invalid", err.message, { diagnostics: err.diagnostics });
        return "blocked";
      }
      // command_in_progress/temporarily_unavailable are handled above; any
      // other 5xx is an uncertain outcome retried with the same request.
      if (err.status >= 500) {
        phase = "uncertain";
        transientFailures += 1;
        return "retry";
      }
    }
    phase = "uncertain";
    transientFailures += 1;
    return "retry";
  }

  async function processEntry(entry: QueueEntry): Promise<SendOutcome> {
    const pendingWrite = entryWrites.get(entry.id);
    if (pendingWrite) {
      try {
        await pendingWrite;
      } catch {
        setBlocked("storage-error", "Could not save this edit because local storage is unavailable.");
        return "blocked";
      }
    }
    let current = entry;
    if (!isConnected() || !editing.owned || !coordination.isOwner() || disposed) {
      refreshPhase();
      return "blocked";
    }
    if (confirmed !== null && !entryMatchesBase(current, confirmed)) {
      setBlocked("conflict", "The character changed on the server. Review before re-sending.", {
        retainedIds: [current.id],
      });
      return "blocked";
    }
    if (current.attempt === null) {
      if (isExpired(current)) {
        setBlocked("expired-attempt", "This change is older than the server's replay window. Review it manually before continuing.");
        return "blocked";
      }
      const frozen = buildFrozenRequest(current);
      try {
        await store.freeze(actorId, characterId, current.id, frozen);
      } catch {
        setBlocked("storage-error", "Could not persist this edit as an attempt. Storage is unavailable.");
        return "blocked";
      }
      current = { ...current, attempt: frozen };
      entries = entries.map((e) => (e.id === current.id ? current : e));
      resolveFreezeWaiter(current.id);
      phase = "sending";
      emit();
    }

    if (isExpired(current)) {
      setBlocked("expired-attempt", "This change is older than the server's replay window. Review it manually before continuing.");
      return "blocked";
    }
    if (!await identityIsCurrent() || !isConnected() || !editing.owned || !coordination.isOwner() || disposed) {
      refreshPhase();
      emit();
      return "blocked";
    }

    const generationAtSend = generation;
    const attempt = current.attempt;
    if (attempt === null) return "blocked";
    let response: CommandResultResponse;
    try {
      response = await api.send(attempt);
    } catch (err) {
      if (!await identityIsCurrent()) return "blocked";
      if (err instanceof ApiError && err.status === 404) {
        await handleNotFound(err);
        return "blocked";
      }
      return await handleSendError(err);
    }
    if (!await identityIsCurrent()) return "blocked";
    const character = response?.result?.character;
    if (!character) {
      phase = "uncertain";
      transientFailures += 1;
      return "retry";
    }

    try {
      await store.acknowledge(actorId, characterId, current.id, character, generationAtSend);
    } catch (err) {
      if (!await identityIsCurrent()) return "blocked";
      return handleAckError(err);
    }
    if (!identityMatches()) return "blocked";
    coordination.invalidate?.();
    confirmed = character;
    if (current.intent.kind === "executeAction") lastRoll = response.result.roll;
    generation += 1;
    transientFailures = 0;
    entries = entries.filter((e) => e.id !== current.id).map((e) =>
      e.attempt === null && e.sequence > current.sequence &&
      e.baseRevision === current.baseRevision && e.packageChecksum === current.packageChecksum
        ? { ...e, baseRevision: character.reconciliation.revision, packageChecksum: character.projection.packageChecksum }
        : e,
    );
    phase = "sending";
    emit();
    return "acked";
  }

  function backoffDelay(): number {
    const attempts = Math.min(transientFailures, 6);
    return Math.min(1000, 10 * 2 ** attempts + Math.floor(Math.random() * 9));
  }

  function scheduleRetry() {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!disposed) scheduleDrain();
    }, backoffDelay());
  }

  async function runDrainPass(): Promise<"idle" | "retry" | "blocked"> {
    while (!disposed) {
      if (isBlocked()) {
        emit();
        return "blocked";
      }
      if (!editing.owned) return "blocked";
      if (conflictRefreshPending && isConnected()) {
        await fetchLatestForConflict();
        return "blocked";
      }
      // One ordering boundary across edit/action/lifecycle/migration
      // attempts: an unresolved online attempt replays verbatim before any
      // fresh-state decision can reinterpret it or any newer command sends.
      await refreshPendingOnline();
      const uncertain = pendingOnline[0] ?? null;
      if (uncertain !== null && isConnected() && coordination.isOwner() && !disposed) {
        if (isReviewableExpired(uncertain)) {
          await enterExpiredAttempt(uncertain);
          await refreshPendingOnline();
          emit();
          return "blocked";
        }
        const onlineOutcome = await attemptOnlineSend(uncertain);
        await refreshPendingOnline();
        if (onlineOutcome === "acked") {
          needsFresh = false;
          continue;
        }
        if (onlineOutcome === "retry") {
          scheduleRetry();
          return "retry";
        }
        emit();
        return "blocked";
      }
      const front = entries[0];
      // Replay uncertain attempts first; check drift before freezing any unsent work.
      if (needsFresh && isConnected() && !front?.attempt) {
        await reconcileFresh();
        if (isBlocked()) return "blocked";
        needsFresh = false;
        continue;
      }
      if (!front) return "idle";
      const outcome = await processEntry(front);
      if (outcome === "acked") continue;
      if (outcome === "retry") {
        scheduleRetry();
        return "retry";
      }
      emit();
      return "blocked";
    }
    return "idle";
  }

  function scheduleDrain() {
    if (disposed || draining || !initialized) return;
    draining = true;
    runDrainPass()
      .catch(() => {
        setBlocked("storage-error", "An unexpected local error interrupted synchronization.");
        return "blocked" as const;
      })
      .then((outcome: "idle" | "retry" | "blocked") => {
        draining = false;
        if (outcome !== "retry") refreshPhase();
        resolveIdle();
        emit();
      });
  }

  async function reconcileFresh() {
    if (!await identityIsCurrent() || !isConnected() || isBlocked() || disposed || !coordination.isOwner()) return;
    let server: CharacterView;
    try {
      const envelope = await api.open(characterId);
      if (!await identityIsCurrent()) return;
      server = envelope.character;
    } catch (err) {
      if (!await identityIsCurrent()) return;
      await handleOpenError(err);
      return;
    }
    await reconcile(server);
  }

  /**
   * Manual review states (conflict/invalid/expired/not-found) and terminal
   * states must not be auto-cleared. Temporary pauses (reauthenticate,
   * network-unavailable) clear when identity becomes healthy again.
   */
  async function handleOpenError(err: unknown) {
    if (err instanceof ApiError && err.status === 404) {
      await handleNotFound(err);
    } else if (err instanceof ApiError && err.status === 401) {
      setBlocked("reauthenticate", "Your session expired. Sign in again to continue.");
    } else {
      setBlocked("network-unavailable", "Could not refresh the character. Cached data is unchanged; retry when connected.");
    }
  }

  async function reconcile(server: CharacterView) {
    if (!identityMatches()) return;
    // The GET that produced `server` may have raced a purge, account clear
    // or cross-tab write: never confirm a server view over a store
    // generation we did not read it against. Adopt the winner instead. A
    // nulled snapshot is terminal once this session confirmed something or
    // recorded the purge: adopting the purged generation must not authorize
    // a stale in-flight GET to confirm over it afterwards.
    const fresh = await store.read(actorId, characterId).catch(() => null);
    if (!identityMatches() || fresh === null) return;
    if (fresh.confirmed === null && (confirmed !== null || error?.kind === "purged")) {
      confirmed = null;
      entries = fresh.entries;
      generation = fresh.generation;
      accountGeneration = fresh.accountGeneration;
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
      await refreshPendingOnline();
      setBlocked("purged", "This character is no longer available.");
      emit();
      return;
    }
    if (fresh.generation !== generation || fresh.accountGeneration !== accountGeneration) {
      confirmed = fresh.confirmed;
      entries = fresh.entries;
      generation = fresh.generation;
      accountGeneration = fresh.accountGeneration;
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
      await refreshPendingOnline();
      if (confirmed === null) {
        setBlocked("purged", "This character is no longer available.");
      }
      emit();
      return;
    }
    const local = confirmed;
    if (local && server.reconciliation.revision < local.reconciliation.revision) {
      setBlocked("network-unavailable", "The latest character state is not available yet. Retry before reviewing.");
      return;
    }
    const drifted = local
      ? server.reconciliation.revision !== local.reconciliation.revision || server.projection.packageChecksum !== local.projection.packageChecksum
      : entries.some(e => e.baseRevision !== server.reconciliation.revision || e.packageChecksum !== server.projection.packageChecksum);
    if (!local || drifted || !projectionsEqual(server.projection, local.projection)) {
      try {
        await store.confirmSnapshot(actorId, characterId, server, generation);
        if (!identityMatches()) return;
        coordination.invalidate?.();
        confirmed = server;
        generation += 1;
      } catch (err) {
        if (!await identityIsCurrent()) return;
        await handleAckError(err);
        return;
      }
    }
    const unresolved = entries.some(e => e.attempt === null &&
      (e.baseRevision !== server.reconciliation.revision || e.packageChecksum !== server.projection.packageChecksum));
    if ((drifted || unresolved) && entries.length > 0) {
      setBlocked("conflict", "A newer revision or package of this character exists. Review before continuing.");
    }
  }

  function refreshPhase() {
    if (error) {
      phase = KIND_TO_PHASE[error.kind];
      return;
    }
    if (identity.getActorId() !== actorId || identity.getGeneration() !== identityGeneration) {
      phase = "reauthenticate";
      return;
    }
    if (!identity.isOnline()) {
      phase = "offline";
      return;
    }
    phase = draining ? "sending" : "ready";
  }

  async function resolveConflict(input: ResolveConflictInput): Promise<void> {
    if (disposed) return;
    if (!identityMatches() || !editing.owned || !coordination.isOwner()) throw new Error("Editing ownership required.");
    // Ordinary conflict recovery never retires online attempts: an uncertain
    // online outcome blocks it until replay or explicit expired-outcome
    // review resolves the local decision.
    await refreshPendingOnline();
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (pendingOnline.length > 0) {
      throw new Error("Resolve the uncertain online outcome before reviewing intentions.");
    }
    if (draining || conflictRefreshPending || !error || !["conflict", "invalid", "expired-attempt"].includes(error.kind)) {
      throw new Error("Resolve the blocking error and refresh current state before reviewing intentions.");
    }
    if (!confirmed) {
      throw new Error("Resolve the blocking error and refresh current state before reviewing intentions.");
    }
    const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
    const selected = new Set(input.selectedIds);
    if (input.selectedIds.length !== selected.size) {
      throw new Error("Review each selected intention once before continuing.");
    }
    if (selected.size === 0 && ordered.length > 0) {
      throw new Error("Select at least one intention to discard or reapply.");
    }
    for (const id of selected) {
      if (!ordered.some((entry) => entry.id === id)) {
        throw new Error("Select only intentions that are still queued.");
      }
    }
    // Selection-safe recovery: a selected entry cannot jump ahead of an
    // earlier unresolved predecessor. While drifted entries remain, the
    // review set is the drifted entries in order; otherwise (invalid without
    // drift) every queued entry still needs its own ordered review.
    const reviewSet = (() => {
      const drifted = ordered.filter((entry) => !entryMatchesBase(entry, confirmed!));
      return drifted.length > 0 ? drifted : ordered;
    })();
    if (reviewSet.length > 0) {
      const flags = reviewSet.map((entry) => selected.has(entry.id));
      const firstUnselected = flags.indexOf(false);
      const lastSelected = flags.lastIndexOf(true);
      if (lastSelected === -1 || (firstUnselected !== -1 && firstUnselected < lastSelected)) {
        throw new Error("Review intentions in order: resolve the earliest pending intention first.");
      }
      for (const id of selected) {
        if (!reviewSet.some((entry) => entry.id === id)) {
          throw new Error("Review intentions in order: resolve the earliest pending intention first.");
        }
      }
    }
    const corrected = input.correctedIntents ?? {};
    if (input.mode === "discard" && Object.keys(corrected).length > 0) {
      throw new Error("Corrections require reapply mode.");
    }
    for (const [id, intent] of Object.entries(corrected)) {
      if (!selected.has(id)) {
        throw new Error("Correct only selected intentions.");
      }
      if (intent.kind !== "setField" && intent.kind !== "bumpResource") {
        throw new Error("Corrections support offline field sets and resource bumps only.");
      }
      if (intent.kind === "setField" && intent.value === undefined) {
        throw new Error("Correct the invalid value before reapplying.");
      }
    }
    // Build replacements before touching durable state so validation or
    // storage failure leaves the in-memory queue untouched as well.
    let replacements: QueueEntry[] = [];
    if (input.mode === "reapply") {
      const taken = new Set(ordered.map((entry) => entry.id));
      replacements = ordered
        .filter((entry) => selected.has(entry.id))
        .map((entry) => {
          // Replacement intentions always use new ids. An injected id source
          // may repeat across sessions sharing one store, so retry rather
          // than overwrite a retained intention.
          let id = newId();
          for (let attempt = 0; taken.has(id) && attempt < 10; attempt += 1) {
            id = newId();
          }
          if (taken.has(id)) {
            throw new Error("Review failed to mint fresh intention ids.");
          }
          taken.add(id);
          return {
            id,
            actorId,
            characterId,
            sequence: entry.sequence,
            baseRevision: confirmed!.reconciliation.revision,
            packageChecksum: confirmed!.projection.packageChecksum,
            createdAt: now(),
            intent: corrected[entry.id] ?? entry.intent,
            attempt: null,
          };
        });
    }
    // One guarded transaction retires the selected originals and inserts
    // the replacements. Unselected entries keep their bodies, attempts and
    // provenance. Publish the new snapshot only after the commit.
    await store.resolveEntries(
      actorId,
      characterId,
      { selectedIds: ordered.filter((entry) => selected.has(entry.id)).map((entry) => entry.id), replacements },
      { generation, accountGeneration },
    );
    if (!identityMatches()) return;
    const fresh = await store.read(actorId, characterId);
    if (!identityMatches()) return;
    if (fresh.accountGeneration !== accountGeneration) {
      // Another tab cleared or replaced the account mid-review: adopt the
      // cleared state and fail instead of recreating intentions.
      confirmed = fresh.confirmed;
      entries = fresh.entries;
      generation = fresh.generation;
      accountGeneration = fresh.accountGeneration;
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
      emit();
      throw new Error("stale recovery: account changed during review");
    }
    confirmed = fresh.confirmed;
    entries = fresh.entries;
    generation = fresh.generation;
    accountGeneration = fresh.accountGeneration;
    nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
    for (const entry of ordered) {
      if (selected.has(entry.id)) {
        resolveFreezeWaiter(entry.id);
        entryWrites.delete(entry.id);
      }
    }
    // Clearing the pause alone authorizes nothing: any unselected entry that
    // still mismatches the confirmed base stays paused at the send gate and
    // needs its own explicit review rather than inheriting the reviewed
    // revision. That gate is stateless, so the pause survives reopen.
    error = null;
    needsFresh = false;
    coordination.invalidate?.();
    emit();
    scheduleDrain();
  }

  type OnlineOperation =
    | { kind: "archive" | "recover"; operation: "archive" | "recover" }
    | { kind: "migration"; operation: "commit"; previewId: string }
    | { kind: "migration"; operation: "rollback"; migrationId: string };

  function onlineAttemptMatches(attempt: OnlineAttempt, op: OnlineOperation): boolean {
    if (attempt.characterId !== characterId) return false;
    if (op.operation === "commit") {
      return attempt.kind === "migration" && attempt.request.path === `/characters/${characterId}/migrations/${op.previewId}/commit`;
    }
    if (op.operation === "rollback") {
      return attempt.kind === "migration" && attempt.request.path === `/characters/${characterId}/migrations/${op.migrationId}/rollback`;
    }
    return attempt.kind === op.operation;
  }

  function isOnlineAttemptExpired(attempt: OnlineAttempt): boolean {
    const timestamp = attempt.createdAt || attempt.request.firstAttemptAt;
    return Date.parse(timestamp) < Date.parse(now()) - THIRTY_DAYS_MS;
  }

  /**
   * One ordering boundary across edit/action/lifecycle/migration attempts:
   * the session keeps every unresolved per-character online attempt in
   * memory (loaded at startup and ownership acquisition, refreshed before
   * every drain pass and online operation) and replays the oldest verbatim
   * before any fresh-state decision or newer command.
   */
  async function refreshPendingOnline(): Promise<void> {
    if (!identityMatches()) {
      pendingOnline = [];
      return;
    }
    const stored = await store.readOnlineAttempts(actorId);
    if (!identityMatches()) return;
    pendingOnline = stored
      .filter((attempt) => attempt.characterId === characterId)
      .sort((a, b) => {
        const time = Date.parse(a.createdAt || a.request.firstAttemptAt) - Date.parse(b.createdAt || b.request.firstAttemptAt);
        return time !== 0 ? time : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
  }

  /**
   * An attempt is reviewable only when replay can no longer resolve it:
   * locally aged past the 30-day replay window (which matches the backend
   * REPLAY_TTL_MS) or durably flagged after the backend declared this exact
   * key's replay window expired. Anything else still has a resolvable
   * outcome and must be replayed, not retired.
   */
  function isReviewableExpired(attempt: OnlineAttempt): boolean {
    return attempt.replayExpired === true || isOnlineAttemptExpired(attempt);
  }

  function isReplayExpiredConflict(err: unknown): boolean {
    return err instanceof ApiError && err.code === "conflict" && REPLAY_EXPIRED_RE.test(err.message);
  }

  /**
   * Retains an expired attempt, fetches current authorized state for the
   * eventual manual review, and blocks ordinary recovery and newer sends.
   * A failed refresh never fabricates a review base: the attempt stays
   * retained either way, and only purge/reauthenticate states win over the
   * expired block.
   */
  async function enterExpiredAttempt(attempt: OnlineAttempt): Promise<void> {
    if (await identityIsCurrent() && isConnected() && coordination.isOwner() && !disposed) {
      try {
        const envelope = await api.open(characterId);
        if (!await identityIsCurrent()) return;
        await reconcile(envelope.character);
        if (!identityMatches()) return;
      } catch (err) {
        if (!await identityIsCurrent()) return;
        await handleOpenError(err);
        if (!identityMatches()) return;
        if (error !== null && error.kind !== "conflict" && error.kind !== "network-unavailable") {
          return;
        }
      }
    }
    setBlocked(
      "expired-attempt",
      "This change is older than the server's replay window. Its outcome is unknown: review the current state and explicitly acknowledge the unknown outcome before continuing.",
      { attemptId: attempt.id },
    );
  }

  /** Ownership-lifetime tracking so takeover quiesces active online sends. */
  async function trackOnline<T>(run: Promise<T>): Promise<T> {
    activeOnline.add(run);
    try {
      return await run;
    } finally {
      activeOnline.delete(run);
    }
  }

  function migrationResultFor(attempt: OnlineAttempt, character: CharacterView): LastMigrationResult | null {
    const commit = new RegExp(`^/characters/${characterId}/migrations/(.+)/commit$`).exec(attempt.request.path);
    if (attempt.kind === "migration" && commit !== null) {
      return { operation: "commit", previewId: commit[1]!, revision: character.reconciliation.revision };
    }
    const rollback = new RegExp(`^/characters/${characterId}/migrations/(.+)/rollback$`).exec(attempt.request.path);
    if (attempt.kind === "migration" && rollback !== null) {
      return { operation: "rollback", migrationId: rollback[1]!, revision: character.reconciliation.revision };
    }
    return null;
  }

  function buildOnlineRequest(op: OnlineOperation, expectedRevision: number): FrozenRequest {
    const firstAttemptAt = now();
    const key = newId();
    if (op.operation === "archive" || op.operation === "recover") {
      return {
        method: "PATCH",
        path: `/characters/${characterId}`,
        body: { command: op.operation, expectedRevision, idempotencyKey: key },
        firstAttemptAt,
      };
    }
    if (op.operation === "commit") {
      return {
        method: "POST",
        path: `/characters/${characterId}/migrations/${op.previewId}/commit`,
        body: { expectedRevision, idempotencyKey: key },
        firstAttemptAt,
      };
    }
    if (op.operation === "rollback") {
      return {
        method: "POST",
        path: `/characters/${characterId}/migrations/${op.migrationId}/rollback`,
        body: { idempotencyKey: key },
        firstAttemptAt,
      };
    }
    throw new Error("Unknown online operation.");
  }

  function assertOnlineOperationAllowed() {
    if (disposed) throw new Error("Session closed.");
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (!editing.owned || !coordination.isOwner()) throw new Error("Editing ownership required.");
    if (!confirmed) throw new Error("Cannot manage until the character is loaded.");
    if (!isConnected()) {
      throw structuredError(
        "Lifecycle, migration and export operations require connectivity and cannot be initiated offline.",
        "network-unavailable",
      );
    }
  }

  async function sendOnlineAttempt(attempt: OnlineAttempt): Promise<void> {
    const run = sendOnlineAttemptInner(attempt);
    const tracked = trackOnline(run);
    try {
      await tracked;
    } catch (err) {
      // Uncertain outcomes back off with the same request: wake the drain so
      // the retained attempt replays verbatim, whether this send ran inline
      // from a direct command or from the drain itself.
      if (!disposed && initialized && !isBlocked() && phase === "uncertain") {
        scheduleRetry();
      }
      throw err;
    }
  }

  /**
   * Retires a definitively rejected attempt (the server answered: nothing is
   * uncertain) under guard. A failed retirement itself is handled as an
   * acknowledgment/storage failure, so a lost retirement never silently
   * drops the frozen request. Callers set the rejection block and rethrow
   * the original server error.
   */
  async function retireRejectedOnlineAttempt(attempt: OnlineAttempt): Promise<void> {
    try {
      await store.retireOnlineAttempt(actorId, characterId, attempt.id, { generation, accountGeneration });
    } catch (retireErr) {
      if (!await identityIsCurrent()) throw retireErr instanceof Error ? retireErr : new Error("Account changed.");
      await handleAckError(retireErr);
      await refreshPendingOnline();
      emit();
      throw retireErr instanceof Error ? retireErr : new Error("Could not retire the rejected request.");
    }
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    generation += 1;
    await refreshPendingOnline();
  }

  async function sendOnlineAttemptInner(attempt: OnlineAttempt): Promise<void> {
    const generationAtSend = generation;
    const guard = { generation: generationAtSend, accountGeneration };
    let response: CommandResultResponse;
    try {
      response = await api.send(attempt.request);
    } catch (err) {
      if (!await identityIsCurrent()) throw err instanceof Error ? err : new Error("Account changed.");
      if (err instanceof ApiError && err.status === 404) {
        if (err.cacheDisposition === "purge") {
          await handleNotFound(err);
          await refreshPendingOnline();
          emit();
          throw err;
        }
        await retireRejectedOnlineAttempt(attempt);
        setBlocked("not-found", "This character could not be loaded.");
        emit();
        throw err;
      }
      if (err instanceof ApiError && err.status === 401) {
        setBlocked("reauthenticate", "Your session expired. Sign in again with the same account to continue.");
        emit();
        throw err;
      }
      if (err instanceof ApiError) {
        if (err.code === "idempotency_mismatch") {
          await retireRejectedOnlineAttempt(attempt);
          setBlocked("protocol", "The server rejected this request's idempotency key. Manual review is required.");
          emit();
          throw err;
        }
        if (isReplayExpiredConflict(err)) {
          // Uncertain, not rejected: the server forgot this key's receipt,
          // which proves nothing about whether the effect applied. Retain
          // verbatim, flag for explicit review, fetch current state.
          try {
            await store.markOnlineAttemptReplayExpired(actorId, characterId, attempt.id, guard);
          } catch (markErr) {
            if (!await identityIsCurrent()) throw markErr instanceof Error ? markErr : new Error("Account changed.");
            await handleAckError(markErr);
            await refreshPendingOnline();
            emit();
            throw err;
          }
          if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
          await refreshPendingOnline();
          const flagged = pendingOnline.find((a) => a.id === attempt.id) ?? { ...attempt, replayExpired: true };
          await enterExpiredAttempt(flagged);
          await refreshPendingOnline();
          emit();
          throw structuredError(
            "The replay window for this idempotency key has expired. Its outcome is unknown: review the current state and explicitly acknowledge the unknown outcome before continuing.",
            "expired-attempt",
            { attemptId: attempt.id },
          );
        }
        if (err.code === "command_in_progress" || err.code === "temporarily_unavailable") {
          // Checked before the generic 409 branch: these codes can arrive
          // with a 409 status but must back off with the same request.
          phase = "uncertain";
          emit();
          throw err;
        }
        if (err.status === 409 || err.code === "expected_revision_mismatch") {
          await retireRejectedOnlineAttempt(attempt);
          await fetchLatestForConflict(err.latestRevision);
          emit();
          throw err;
        }
        if (err.status === 422 || err.code === "invalid_value" || err.code === "bad_request") {
          await retireRejectedOnlineAttempt(attempt);
          setBlocked("invalid", err.message, { diagnostics: err.diagnostics });
          emit();
          throw err;
        }
        if (err.status >= 500) {
          // Pause with retry guidance: the request is retained verbatim and
          // retried with the same key; no duplicate may be created.
          phase = "uncertain";
          emit();
          throw new ApiError({
            code: err.code,
            message: `The server returned an unexpected error (${err.message}). The request was kept and will be retried with the same key; do not send a duplicate.`,
            status: err.status,
            requestId: err.requestId,
            latestRevision: err.latestRevision,
            diagnostics: [...err.diagnostics],
            runtimeDiagnostics: [...err.runtimeDiagnostics],
            changedDefinitionIds: err.changedDefinitionIds === undefined ? null : [...err.changedDefinitionIds],
            activityCursor: err.activityCursor,
            cacheDisposition: err.cacheDisposition ?? null,
          });
        }
      }
      phase = "uncertain";
      emit();
      throw err;
    }
    if (!await identityIsCurrent() || !coordination.isOwner() || disposed) {
      throw new Error("Account changed. Reopen this character.");
    }
    const character = response?.result?.character;
    if (!character) {
      phase = "uncertain";
      emit();
      throw structuredError("The server returned an unexpected response.", "network-unavailable");
    }
    // Guarded atomic acknowledgment: confirmed-state persistence and exact
    // attempt retirement commit together. A storage failure aborts the whole
    // transaction, so the attempt survives for verbatim replay.
    try {
      await store.acknowledgeOnlineAttempt(actorId, characterId, attempt.id, character, guard);
    } catch (err) {
      if (!await identityIsCurrent()) throw err instanceof Error ? err : new Error("Account changed.");
      await handleAckError(err);
      await refreshPendingOnline();
      emit();
      throw err;
    }
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    coordination.invalidate?.();
    confirmed = character;
    // Authoritative action results survive later online acknowledgments: only
    // a non-null roll replaces the retained one (online ops return null).
    if (response.result.roll !== null && response.result.roll !== undefined) lastRoll = response.result.roll;
    const migration = migrationResultFor(attempt, character);
    if (migration !== null) lastMigration = migration;
    generation += 1;
    transientFailures = 0;
    needsFresh = false;
    await refreshPendingOnline();
    refreshPhase();
    emit();
  }

  /**
   * Drain-facing wrapper: converts sendOnlineAttempt's throw-shape into an
   * outcome. Blocked states stay blocked; uncertain states back off with the
   * same request via the drain's retry schedule.
   */
  async function attemptOnlineSend(attempt: OnlineAttempt): Promise<SendOutcome> {
    try {
      await sendOnlineAttempt(attempt);
      return "acked";
    } catch {
      if (!identityMatches() || disposed) return "blocked";
      if (isBlocked()) return "blocked";
      if (phase === "uncertain") return "retry";
      return "blocked";
    }
  }

  async function runOnlineOperation(op: OnlineOperation): Promise<void> {
    assertOnlineOperationAllowed();
    await refreshPendingOnline();
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    const existing = pendingOnline.find((attempt) => onlineAttemptMatches(attempt, op)) ?? null;
    if (existing !== null) {
      if (isReviewableExpired(existing)) {
        // Elapsed time proves nothing: retain the attempt, fetch current
        // state and require explicit unknown-outcome review. Never delete an
        // expired attempt automatically and never mint a replacement here.
        await enterExpiredAttempt(existing);
        await refreshPendingOnline();
        emit();
        throw structuredError(
          "This change is older than the server's replay window. Its outcome is unknown: review the current state and explicitly acknowledge the unknown outcome before continuing.",
          "expired-attempt",
          { attemptId: existing.id },
        );
      }
      await sendOnlineAttempt(existing);
      return;
    }
    const older = pendingOnline[0] ?? null;
    if (older !== null) {
      // One ordering boundary across command kinds: an unresolved attempt
      // replays verbatim before any newer command. A newer preview, lifecycle
      // change or migration never deletes or replaces it.
      if (isReviewableExpired(older)) {
        await enterExpiredAttempt(older);
        await refreshPendingOnline();
        emit();
      }
      throw new Error("An earlier online change has an uncertain outcome. Resolve it before starting a newer command.");
    }
    if (entries.length > 0 || phase !== "ready") {
      throw new Error("Resolve pending edits and wait for the character to be ready before managing it.");
    }
    await reconcileFresh();
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (isBlocked()) throw structuredError(error!.message, error!.kind, error!.details);
    if (entries.length > 0 || !confirmed) {
      throw new Error("Resolve pending edits and wait for the character to be ready before managing it.");
    }
    const request = buildOnlineRequest(op, confirmed.reconciliation.revision);
    const attempt: OnlineAttempt = {
      id: newId(),
      actorId,
      characterId,
      kind: op.kind,
      request,
      createdAt: request.firstAttemptAt,
    };
    try {
      await store.saveOnlineAttempt(attempt, { generation, accountGeneration });
    } catch (saveErr) {
      if (!await identityIsCurrent()) throw saveErr instanceof Error ? saveErr : new Error("Account changed.");
      setBlocked("storage-error", "Could not save this change because local storage is unavailable.");
      emit();
      throw saveErr instanceof Error ? saveErr : new Error("storage failure");
    }
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    await refreshPendingOnline();
    await sendOnlineAttempt(attempt);
  }

  /**
   * Explicit unknown-outcome review for one retained expired online attempt.
   * This is not a retry and never mints a replacement mutation: after
   * gating, it fetches current authorized state and retires exactly the
   * identified attempt under guard. Offline, stale, other-account, purged,
   * unacknowledged, refresh-failed and unexpired-resolvable reviews are all
   * rejected without touching any attempt; unrelated attempts are untouched.
   */
  async function reviewExpiredAttemptInner(input: ReviewExpiredAttemptInput): Promise<void> {
    if (disposed) throw new Error("Session closed.");
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (!editing.owned || !coordination.isOwner()) throw new Error("Editing ownership required.");
    if (!isConnected()) {
      throw structuredError(
        "Expired-outcome review requires connectivity and cannot run offline.",
        "network-unavailable",
      );
    }
    if (typeof input.attemptId !== "string" || input.attemptId.length === 0) {
      throw new Error("An attempt id is required for expired-outcome review.");
    }
    const stored = (await store.readOnlineAttempts(actorId)).find(
      (attempt) => attempt.id === input.attemptId && attempt.characterId === characterId,
    ) ?? null;
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (stored === null) {
      throw new Error("This online attempt is no longer pending review.");
    }
    if (!isReviewableExpired(stored)) {
      throw new Error("This attempt still has a resolvable outcome. Replay it instead of retiring it.");
    }
    if (input.acknowledgeUnknownOutcome !== true) {
      throw new Error("Acknowledge the unknown outcome before retiring this attempt.");
    }
    if (!await identityIsCurrent() || !isConnected() || !editing.owned || !coordination.isOwner() || disposed) {
      throw new Error("Account changed. Reopen this character.");
    }
    // Fetch current authorized state first. A failed refresh never retires:
    // without a fresh review base there is nothing to accept.
    let server: CharacterView;
    try {
      const envelope = await api.open(characterId);
      if (!await identityIsCurrent()) throw new Error("Account changed. Reopen this character.");
      server = envelope.character;
    } catch (err) {
      if (!await identityIsCurrent()) throw err instanceof Error ? err : new Error("Account changed.");
      await handleOpenError(err);
      emit();
      throw err instanceof Error ? err : new Error("Could not refresh the character before review.");
    }
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    // The fetch may have raced a purge or account clear: re-verify the exact
    // attempt is still pending before persisting anything over it.
    const stillPending = (await store.readOnlineAttempts(actorId)).find(
      (attempt) => attempt.id === stored.id && attempt.characterId === characterId,
    ) ?? null;
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    if (stillPending === null) {
      await refreshPendingOnline();
      emit();
      throw new Error("This online attempt is no longer pending review.");
    }
    try {
      await store.confirmSnapshot(actorId, characterId, server, generation);
    } catch (err) {
      if (!await identityIsCurrent()) throw err instanceof Error ? err : new Error("Account changed.");
      await handleAckError(err);
      emit();
      throw err instanceof Error ? err : new Error("Could not persist the review base.");
    }
    if (!identityMatches()) throw new Error("Account changed. Reopen this character.");
    generation += 1;
    try {
      await store.retireOnlineAttempt(actorId, characterId, stored.id, { generation, accountGeneration });
    } catch (err) {
      if (!await identityIsCurrent()) throw err instanceof Error ? err : new Error("Account changed.");
      await handleAckError(err);
      emit();
      throw err instanceof Error ? err : new Error("Could not retire the reviewed attempt.");
    }
    if (!identityMatches()) return;
    const fresh = await store.read(actorId, characterId);
    if (!identityMatches()) return;
    if (fresh.accountGeneration !== accountGeneration) {
      // Another tab cleared or replaced the account mid-review: adopt the
      // cleared state and fail instead of recreating anything.
      confirmed = fresh.confirmed;
      entries = fresh.entries;
      generation = fresh.generation;
      accountGeneration = fresh.accountGeneration;
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
      await refreshPendingOnline();
      emit();
      throw new Error("stale recovery: account changed during review");
    }
    confirmed = fresh.confirmed;
    entries = fresh.entries;
    generation = fresh.generation;
    accountGeneration = fresh.accountGeneration;
    nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
    await refreshPendingOnline();
    // Clearing the expired pause authorizes nothing by itself: any other
    // retained attempt still blocks newer sends at the ordering boundary,
    // and any deliberate new mutation needs its own fresh key.
    const blockedAttempt = (error?.details as { attemptId?: string } | undefined)?.attemptId;
    if (error?.kind === "expired-attempt" && blockedAttempt === stored.id) {
      error = null;
    }
    needsFresh = false;
    coordination.invalidate?.();
    emit();
    scheduleDrain();
  }

  function open(): Promise<void> {
    opening ??= initialize().catch(() => {
      if (!identityMatches()) return;
      setBlocked("storage-error", "Could not load local character state.");
      emit();
    });
    return opening;
  }

  async function initialize(): Promise<void> {
    const loaded = await store.read(actorId, characterId);
    if (!identityMatches()) return;
    confirmed = loaded.confirmed;
    entries = loaded.entries;
    generation = loaded.generation;
    accountGeneration = loaded.accountGeneration;
    nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), 0);
    // Load unresolved per-character online attempts before any drain pass so
    // an uncertain outcome replays verbatim before fresh-state decisions.
    await refreshPendingOnline();
    if (!identityMatches()) return;
    phase = "loading";
    emit();

    await requestEditing();
    if (!editing.owned) {
      // A same-page predecessor (StrictMode remount) or transient holder may
      // still be releasing the Web Lock; retry briefly with ifAvailable
      // semantics (never steal), then settle read-only like a genuine
      // second tab once retries exhaust.
      for (let attempt = 0; attempt < 10 && !disposed && identityMatches() && !editing.owned; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (disposed || !identityMatches()) break;
        await requestEditing();
      }
    }
    initialized = true;
    scheduleDrain();
    if (draining) await new Promise<void>(resolve => idleWaiters.push(resolve));
  }

  async function requestEditing(): Promise<boolean> {
    if (!identityMatches()) return false;
    if (editing.owned && coordination.isOwner()) return true;
    const granted = await (initialized && coordination.requestTakeover ? coordination.requestTakeover() : coordination.requestEditing());
    if (granted) await reloadOwned();
    emit();
    if (granted) scheduleDrain();
    return granted;
  }

  let reloading: Promise<void> | null = null;
  function reloadOwned(): Promise<void> {
    return reloading ??= (async () => {
      const loaded = await store.read(actorId, characterId);
      if (!identityMatches() || !coordination.isOwner()) return;
      confirmed = loaded.confirmed; entries = loaded.entries; generation = loaded.generation;
      accountGeneration = loaded.accountGeneration;
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), 0);
      // A new owner resolves any inherited uncertain outcome first.
      await refreshPendingOnline();
      if (!identityMatches() || !coordination.isOwner()) return;
      editing = { owned: true, owner: null }; needsFresh = true;
      emit(); scheduleDrain();
    })().catch(() => {
      if (!identityMatches()) return;
      editing = { owned: false, owner: null };
      setBlocked("storage-error", "Could not load local character state.");
      coordination.letGo(); emit();
    }).finally(() => { reloading = null; });
  }

  coordination.setQuiesce?.(async () => {
    if (draining) await new Promise<void>(resolve => idleWaiters.push(resolve));
    if (recovering) await Promise.allSettled([recovering]);
    await Promise.allSettled([...entryWrites.values(), ...activeOnline]);
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    unsubscribeIdentity?.();
    unsubscribeCoordination?.();
    // Release the lock but never dispose the coordination handle: its
    // lifetime belongs to the route, which outlives StrictMode session
    // turnover. Disposing here would poison the handle for the remount's
    // session and wedge fresh sheets read-only.
    coordination.letGo();
    for (const waiter of freezeWaiters.values()) waiter.reject(new Error("Session closed."));
    freezeWaiters.clear();
    if (!draining) resolveIdle();
    emit();
  }

  const unsubscribeIdentity = identity.subscribe(() => {
    if (disposed) return;
    if (!identityMatches()) {
      confirmed = null; entries = []; pendingOnline = []; error = null; editing = { owned: false, owner: null };
      coordination.letGo();
    }
    if (!isConnected()) needsFresh = true;
    if (isConnected() && (error?.kind === "reauthenticate" || error?.kind === "network-unavailable")) {
      error = null;
    }
    if (isConnected() && !isBlocked()) {
      scheduleDrain();
    } else {
      refreshPhase();
    }
    emit();
  });

  const unsubscribeCoordination = coordination.subscribe((event) => {
    if (disposed) return;
    if (event.type === "ownership-changed") {
      if (event.owned) { void reloadOwned(); return; }
      editing = { owned: false, owner: event.owner ?? null };
      if (!event.owned && retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      emit();
    }
    if (event.type === "invalidate" && event.characterId === characterId) {
      void store.read(actorId, characterId).then(loaded => {
        if (!identityMatches()) return;
        if (editing.owned && (loaded.confirmed !== null || loaded.generation <= generation)) return;
        confirmed = loaded.confirmed; entries = loaded.entries; generation = loaded.generation;
        if (confirmed === null) setBlocked("purged", "This character is no longer available.");
        emit();
      }).catch(() => {
        if (!identityMatches()) return;
        setBlocked("storage-error", "Could not reload local character state."); emit();
      });
    }
  });

  return {
    open,
    getSnapshot,
    subscribe(listener: (snapshot: CharacterSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async setField(fieldId: string, value: unknown): Promise<void> {
      assertMutationAllowed();
      if (confirmed?.lifecycle === "archived") throw new Error("This character is archived and read-only until recovered.");
      await persistEntry(newEntry({ kind: "setField", fieldId, value }));
    },
    async bumpResource(resourceId: string, direction: "up" | "down"): Promise<void> {
      assertMutationAllowed();
      if (confirmed?.lifecycle === "archived") throw new Error("This character is archived and read-only until recovered.");
      await persistEntry(newEntry({ kind: "bumpResource", resourceId, direction }));
    },
    async executeAction(actionId: string, inputs?: Record<string, unknown>): Promise<void> {
      assertMutationAllowed();
      if (confirmed?.lifecycle === "archived") throw new Error("This character is archived and read-only until recovered.");
      if (!isConnected()) {
        throw structuredError(
          "Actions require connectivity and cannot be initiated offline.",
          "network-unavailable",
        );
      }
      await persistEntry(
        newEntry({
          kind: "executeAction",
          actionId,
          ...(inputs !== undefined ? { inputs } : {}),
        }),
      );
    },
    async archive(): Promise<void> {
      await runOnlineOperation({ kind: "archive", operation: "archive" });
    },
    async recover(): Promise<void> {
      await runOnlineOperation({ kind: "recover", operation: "recover" });
    },
    async commitMigration(previewId: string): Promise<void> {
      if (typeof previewId !== "string" || previewId.length === 0) throw new Error("A migration preview is required.");
      await runOnlineOperation({ kind: "migration", operation: "commit", previewId });
    },
    async rollbackMigration(migrationId: string): Promise<void> {
      if (typeof migrationId !== "string" || migrationId.length === 0) throw new Error("A migration ID is required.");
      await runOnlineOperation({ kind: "migration", operation: "rollback", migrationId });
    },
    reviewExpiredAttempt(input) {
      return trackOnline(reviewExpiredAttemptInner(input));
    },
    resolveConflict(input) {
      if (recovering) return Promise.reject(new Error("Conflict recovery is already in progress."));
      recovering = resolveConflict(input).catch(async error => {
        if (isStaleAck(error)) {
          if (await identityIsCurrent()) await handleAckError(error);
          emit();
        }
        throw error;
      }).finally(() => { recovering = null; });
      return recovering;
    },
    requestEditing,
    whenIdle(): Promise<void> {
      if (!draining && retryTimer === null) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    dispose,
  };
}
