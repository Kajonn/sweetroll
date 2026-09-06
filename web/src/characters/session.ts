import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import type { CharacterStore } from "./store.js";
import type {
  CharacterView,
  CommandResultResponse,
  EditIntent,
  FrozenRequest,
  QueueEntry,
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
};

export type CharacterSession = {
  open(): Promise<void>;
  getSnapshot(): CharacterSnapshot;
  subscribe(listener: (snapshot: CharacterSnapshot) => void): () => void;
  setField(fieldId: string, value: unknown): Promise<void>;
  bumpResource(resourceId: string, direction: "up" | "down"): Promise<void>;
  executeAction(actionId: string, inputs?: Record<string, unknown>): Promise<void>;
  resolveConflict(input: { mode: "discard" | "reapply"; selectedIds: string[] }): Promise<void>;
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

export function createCharacterSession(input: CreateCharacterSessionInput): CharacterSession {
  const { actorId, characterId, api, store, identity, coordination, now, newId } = input;

  let confirmed: CharacterView | null = null;
  let entries: QueueEntry[] = [];
  let generation = 0;
  let nextSequence = 0;
  let phase: SessionPhase = "loading";
  let error: BlockingError | null = null;
  let editing: { owned: boolean; owner: string | null } = { owned: coordination.isOwner(), owner: null };
  let disposed = false;

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
      await store.enqueue(entry);
      coordination.invalidate?.();
    } catch (storageErr) {
      rejectWrite(storageErr);
      entryWrites.delete(entry.id);
      entries = entries.filter(e => e.id !== entry.id);
      setBlocked("storage-error", "Could not save your edit because local storage is unavailable.");
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
      if (
        err.code === "command_in_progress" ||
        err.code === "temporarily_unavailable" ||
        err.status >= 500
      ) {
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

  async function resolveConflict(input: { mode: "discard" | "reapply"; selectedIds: string[] }): Promise<void> {
    if (disposed) return;
    if (!identityMatches() || !editing.owned || !coordination.isOwner()) throw new Error("Editing ownership required.");
    if (draining || conflictRefreshPending || !error || !["conflict", "invalid", "expired-attempt"].includes(error.kind)) {
      throw new Error("Resolve the blocking error and refresh current state before reviewing intentions.");
    }
    const selected = new Set(input.selectedIds);
    if (input.mode === "discard") {
      await store.retireEntries(actorId, characterId, input.selectedIds, generation);
      if (!identityMatches()) return;
      generation += 1;
      const remaining = entries.filter((e) => !selected.has(e.id));
      for (const entry of entries) {
        if (selected.has(entry.id)) {
          resolveFreezeWaiter(entry.id);
          entryWrites.delete(entry.id);
        }
      }
      entries = remaining;
    } else {
      await store.retireEntries(actorId, characterId, input.selectedIds, generation);
      if (!identityMatches()) return;
      generation += 1;
      const rebuilt: QueueEntry[] = [];
      for (const entry of entries) {
        if (!identityMatches()) return;
        if (selected.has(entry.id)) {
          const replica = newEntry(entry.intent);
          replica.baseRevision = confirmed!.reconciliation.revision;
          replica.sequence = entry.sequence;
          await store.enqueue(replica);
          if (!identityMatches()) return;
          rebuilt.push(replica);
          resolveFreezeWaiter(entry.id);
          entryWrites.delete(entry.id);
        } else {
          rebuilt.push(entry);
        }
      }
      entries = rebuilt.sort((a, b) => a.sequence - b.sequence);
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), nextSequence);
    }
    error = null;
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
    nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), 0);
    phase = "loading";
    emit();

    await requestEditing();
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
      nextSequence = entries.reduce((m, e) => Math.max(m, e.sequence + 1), 0);
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
    await Promise.allSettled([...entryWrites.values()]);
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
    coordination.letGo();
    coordination.dispose?.();
    for (const waiter of freezeWaiters.values()) waiter.reject(new Error("Session closed."));
    freezeWaiters.clear();
    if (!draining) resolveIdle();
    emit();
  }

  const unsubscribeIdentity = identity.subscribe(() => {
    if (disposed) return;
    if (!identityMatches()) {
      confirmed = null; entries = []; error = null; editing = { owned: false, owner: null };
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
      await persistEntry(newEntry({ kind: "setField", fieldId, value }));
    },
    async bumpResource(resourceId: string, direction: "up" | "down"): Promise<void> {
      assertMutationAllowed();
      await persistEntry(newEntry({ kind: "bumpResource", resourceId, direction }));
    },
    async executeAction(actionId: string, inputs?: Record<string, unknown>): Promise<void> {
      assertMutationAllowed();
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
    resolveConflict(input) {
      if (recovering) return Promise.reject(new Error("Conflict recovery is already in progress."));
      recovering = resolveConflict(input).finally(() => { recovering = null; });
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
