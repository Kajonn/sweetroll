import { beforeEach, describe, expect, it, vi } from "vitest";
import { openCharacterStore } from "./store.js";
import type { CharacterView, FrozenRequest, QueueEntry } from "./types.js";
import type { OnlineAttempt } from "./store.js";

let counter = 0;
let dbName = "sweetroll-test-store";

beforeEach(() => {
  counter += 1;
  dbName = `sweetroll-test-store-${counter}`;
});

function makeView(characterId: string, revision: number): CharacterView {
  return {
    characterId,
    ownerId: "00000000-0000-4000-8000-000000000000",
    name: "Aria",
    systemVersionId: "11111111-1111-4000-8000-000000000000",
    entityDefinitionId: "hero",
    revision,
    lifecycle: "active",
    archivedAt: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    state: { schemaVersion: "1.0", values: { name: "Aria" } },
    derivedValues: {},
    validations: [],
    projection: {
      projectionVersion: "1.0",
      systemId: "22222222-2222-4000-8000-000000000000",
      versionId: "11111111-1111-4000-8000-000000000000",
      packageChecksum: "abc",
      entityId: "hero",
      entityLabel: "Hero",
      sheets: [],
      derivedValues: {},
      validations: [],
    },
    reconciliation: {
      characterId,
      baseRevision: null,
      revision,
      packageChecksum: "abc",
      projectionVersion: "1.0",
      commandExecutionId: "",
      replayExpiresAt: "2026-09-06T00:00:00.000Z",
      replayed: false,
      changedDefinitionIds: [],
      activityCursor: null,
      cacheDisposition: "retain",
    },
  };
}

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "entry-1",
    actorId: "actor-A",
    characterId: "char-1",
    sequence: 0,
    baseRevision: 1,
    packageChecksum: "abc",
    createdAt: "2026-09-06T00:00:00.000Z",
    intent: { kind: "setField", fieldId: "name", value: "Briar" },
    attempt: null,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<FrozenRequest> = {}): FrozenRequest {
  return {
    method: "POST",
    path: "/characters/char-1/fields/name/set",
    body: { value: "Briar", expectedRevision: 1, idempotencyKey: "key-1" },
    firstAttemptAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

async function openFresh() {
  return openCharacterStore(dbName);
}

describe("CharacterStore", () => {
  it("persists a frozen request verbatim across reopen", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const request = makeRequest();
    await store.freeze("actor-A", "char-1", entry.id, request);
    await store.close();

    const reopened = await openCharacterStore(dbName);
    const { entries } = await reopened.read("actor-A", "char-1");
    expect(entries[0]?.attempt).toEqual(request);
    await reopened.close();
  });

  it("returns entries in sequence order", async () => {
    const store = await openFresh();
    await store.enqueue(makeEntry({ id: "a", sequence: 2 }));
    await store.enqueue(makeEntry({ id: "b", sequence: 0 }));
    await store.enqueue(makeEntry({ id: "c", sequence: 1 }));
    const { entries } = await store.read("actor-A", "char-1");
    expect(entries.map((e) => e.id)).toEqual(["b", "c", "a"]);
    await store.close();
  });

  it("rolls back a multi-store write transaction that aborts, leaving snapshot and queue unchanged", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const request = makeRequest();
    await store.freeze("actor-A", "char-1", entry.id, request);
    const stable = await store.read("actor-A", "char-1");
    expect(stable.entries[0]?.attempt).toEqual(request);
    expect(stable.confirmed).toBeNull();

    // Acknowledge deletes the queue entry and then writes the confirmed
    // snapshot in one transaction. Inject an abort at the snapshot write so
    // the whole transaction rolls back: the queue entry must survive and the
    // snapshot must remain untouched.
    const realPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "characters") {
        this.transaction.abort();
        throw new DOMException("induced abort", "AbortError");
      }
      return realPut.apply(this, [value, key as IDBValidKey]);
    });
    await expect(
      store.acknowledge("actor-A", "char-1", entry.id, makeView("char-1", 2), 0),
    ).rejects.toThrow();
    spy.mockRestore();

    const after = await store.read("actor-A", "char-1");
    expect(after.entries[0]?.attempt).toEqual(request);
    expect(after.confirmed).toBeNull();
    expect(after.generation).toBe(0);
    await store.close();
  });

  it("rejects changing an already-frozen request body", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const request = makeRequest();
    await store.freeze("actor-A", "char-1", entry.id, request);
    await expect(
      store.freeze("actor-A", "char-1", entry.id, makeRequest({ firstAttemptAt: "2026-09-06T02:00:00.000Z" })),
    ).rejects.toThrow();
    await expect(
      store.freeze("actor-A", "char-1", entry.id, makeRequest({ body: { ...request.body, value: "Different" } })),
    ).rejects.toThrow();
    const { entries } = await store.read("actor-A", "char-1");
    expect(entries[0]?.attempt).toEqual(request);
    await store.close();
  });

  it("acknowledge clears the entry, updates the snapshot and bumps the generation atomically", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const before = await store.read("actor-A", "char-1");
    const view = makeView("char-1", 2);
    await store.acknowledge("actor-A", "char-1", entry.id, view, before.generation);

    const { confirmed, entries, generation } = await store.read("actor-A", "char-1");
    expect(confirmed).toEqual(view);
    expect(entries).toEqual([]);
    expect(generation).toBe(before.generation + 1);
    await store.close();
  });

  it("rejects a late acknowledge after clearAccount bumps the generation", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const before = await store.read("actor-A", "char-1");
    await store.acknowledge("actor-A", "char-1", entry.id, makeView("char-1", 2), before.generation);

    const after = await store.read("actor-A", "char-1");
    await store.clearAccount("actor-A");
    await expect(
      store.acknowledge("actor-A", "char-1", "entry-1", makeView("char-1", 3), after.generation),
    ).rejects.toThrow();
    await store.close();
  });

  it("purgeCharacter deletes snapshot, queue and attempts, and increments the generation", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    const attempt: OnlineAttempt = {
      id: "oa-1",
      actorId: "actor-A",
      characterId: "char-1",
      kind: "archive",
      request: makeRequest(),
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    await store.saveOnlineAttempt(attempt);
    const before = await store.read("actor-A", "char-1");
    await store.purgeCharacter("actor-A", "char-1");

    const { confirmed, entries, generation } = await store.read("actor-A", "char-1");
    expect(confirmed).toBeNull();
    expect(entries).toEqual([]);
    expect(generation).toBe(before.generation + 1);
    expect(await store.readOnlineAttempts("actor-A")).toEqual([]);
    await store.close();
  });

  it("rejects a late acknowledge after purgeCharacter bumps the generation", async () => {
    const store = await openFresh();
    const entry = makeEntry();
    await store.enqueue(entry);
    await store.acknowledge("actor-A", "char-1", entry.id, makeView("char-1", 2), 0);
    const before = await store.read("actor-A", "char-1");
    await store.purgeCharacter("actor-A", "char-1");
    await expect(
      store.acknowledge("actor-A", "char-1", entry.id, makeView("char-1", 2), before.generation),
    ).rejects.toThrow();
    await store.close();
  });

  it("surfaces storage failure as an error rather than silently marking saved", async () => {
    const store = await openFresh();
    // fake-indexeddb does not enforce a storage quota, so inject a throwing
    // store that rejects the queue write with a QuotaExceededError. The
    // write must surface as a storage failure and must not be marked saved.
    const realPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "queue") {
        this.transaction.abort();
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return realPut.apply(this, [value, key as IDBValidKey]);
    });
    await expect(store.enqueue(makeEntry())).rejects.toThrow();
    spy.mockRestore();
    const { entries } = await store.read("actor-A", "char-1");
    expect(entries).toEqual([]);
    await store.close();
  });

  it("isolates account data across actors and clearAccount preserves the other account", async () => {
    const store = await openFresh();
    await store.enqueue(makeEntry({ actorId: "actor-A", characterId: "char-1" }));
    await store.freeze("actor-A", "char-1", "entry-1", makeRequest());
    const before = await store.read("actor-A", "char-1");
    await store.acknowledge("actor-A", "char-1", "entry-1", makeView("char-1", 2), before.generation);

    const bRead = await store.read("actor-B", "char-1");
    expect(bRead.confirmed).toBeNull();
    expect(bRead.entries).toEqual([]);

    await store.clearAccount("actor-B");
    const aAfter = await store.read("actor-A", "char-1");
    expect(aAfter.confirmed).not.toBeNull();
    await store.close();
  });

  it("scopes creation attempts to an account", async () => {
    const store = await openFresh();
    const attemptA: OnlineAttempt = {
      id: "create-1",
      actorId: "actor-A",
      characterId: null,
      kind: "create",
      request: makeRequest({ path: "/characters", body: { name: "Aria", systemVersionId: "v-1", idempotencyKey: "k" } }),
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    await store.saveOnlineAttempt(attemptA);

    const attemptsA = await store.readOnlineAttempts("actor-A");
    expect(attemptsA.map((a) => a.id)).toEqual(["create-1"]);
    const attemptsB = await store.readOnlineAttempts("actor-B");
    expect(attemptsB).toEqual([]);

    await store.deleteOnlineAttempt("actor-A", "create-1");
    expect(await store.readOnlineAttempts("actor-A")).toEqual([]);
    await store.close();
  });

  it("isolation: clearAccount(A) leaves B online attempts intact", async () => {
    const store = await openFresh();
    const attemptB: OnlineAttempt = {
      id: "create-b",
      actorId: "actor-B",
      characterId: null,
      kind: "create",
      request: makeRequest({ path: "/characters", body: { name: "Bo", systemVersionId: "v-1", idempotencyKey: "k" } }),
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    await store.saveOnlineAttempt(attemptB);
    await store.clearAccount("actor-A");
    const attemptsB = await store.readOnlineAttempts("actor-B");
    expect(attemptsB.map((a) => a.id)).toEqual(["create-b"]);
    await store.close();
  });

  it("sets and reads the last-account marker and clearAccount clears it only when it matches", async () => {
    const store = await openFresh();
    expect(await store.readLastAccount()).toBeNull();

    await store.setLastAccount("actor-A");
    expect(await store.readLastAccount()).toBe("actor-A");

    await store.clearAccount("actor-B");
    expect(await store.readLastAccount()).toBe("actor-A");

    await store.clearAccount("actor-A");
    expect(await store.readLastAccount()).toBeNull();
    await store.close();
  });

  it("sets, reads and clears the pending-logout barrier scoped by actor", async () => {
    const store = await openFresh();
    expect(await store.readPendingLogout()).toBeNull();
    await store.setPendingLogout("actor-A");
    expect(await store.readPendingLogout()).toBe("actor-A");
    await store.clearAccount("actor-C");
    expect(await store.readPendingLogout()).toBe("actor-A");
    await store.clearPendingLogout();
    expect(await store.readPendingLogout()).toBeNull();
    await store.close();
  });

  it("saves and reloads online attempts across reopen", async () => {
    const store = await openFresh();
    const attempt: OnlineAttempt = {
      id: "create-1",
      actorId: "actor-A",
      characterId: null,
      kind: "create",
      request: makeRequest({ path: "/characters", body: { name: "Aria", systemVersionId: "v-1", idempotencyKey: "k" } }),
      createdAt: "2026-09-06T00:00:00.000Z",
    };
    await store.saveOnlineAttempt(attempt);
    await store.close();

    const reopened = await openCharacterStore(dbName);
    const attempts = await reopened.readOnlineAttempts("actor-A");
    expect(attempts).toEqual([attempt]);
    await reopened.close();
  });
});
