import type { CharacterView, FrozenRequest, QueueEntry } from "./types.js";

export type OnlineAttempt = {
  id: string;
  actorId: string;
  characterId: string | null;
  kind: "create" | "archive" | "recover" | "export" | "migration";
  request: FrozenRequest;
  createdAt: string;
};

export type CharacterStore = {
  read(
    actorId: string,
    characterId: string,
  ): Promise<{ confirmed: CharacterView | null; entries: QueueEntry[]; generation: number }>;
  enqueue(entry: QueueEntry): Promise<void>;
  freeze(actorId: string, characterId: string, entryId: string, request: FrozenRequest): Promise<void>;
  acknowledge(
    actorId: string,
    characterId: string,
    entryId: string,
    character: CharacterView,
    generation: number,
  ): Promise<void>;
  confirmSnapshot(
    actorId: string,
    characterId: string,
    character: CharacterView,
    generation: number,
  ): Promise<void>;
  retireEntries(actorId: string, characterId: string, entryIds: string[], generation: number): Promise<void>;
  purgeCharacter(actorId: string, characterId: string): Promise<void>;
  clearAccount(actorId: string): Promise<void>;
  close(): Promise<void>;

  saveOnlineAttempt(attempt: OnlineAttempt): Promise<void>;
  readOnlineAttempts(actorId: string): Promise<OnlineAttempt[]>;
  deleteOnlineAttempt(actorId: string, attemptId: string): Promise<void>;
  deleteOnlineAttemptsForCharacter(actorId: string, characterId: string): Promise<void>;

  setLastAccount(actorId: string, expectedAccount?: string | null): Promise<boolean>;
  readLastAccount(): Promise<string | null>;
  setPendingLogout(actorId: string): Promise<void>;
  readPendingLogout(): Promise<string | null>;
  clearPendingLogout(): Promise<void>;
};

const DB_VERSION = 1;

const CHAR = "characters";
const QUEUE = "queue";
const ATTEMPTS = "onlineAttempts";
const LAST_ACCOUNT = "lastAccount";
const PENDING_LOGOUT = "pendingLogout";

const MAX_STRING = "\uffff";

type CharacterRecord = {
  actorId: string;
  characterId: string;
  confirmed: CharacterView | null;
  generation: number;
};

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHAR)) {
        db.createObjectStore(CHAR, { keyPath: ["actorId", "characterId"] });
      }
      if (!db.objectStoreNames.contains(QUEUE)) {
        const store = db.createObjectStore(QUEUE, { keyPath: ["actorId", "characterId", "id"] });
        store.createIndex("by-seq", ["actorId", "characterId", "sequence"]);
      }
      if (!db.objectStoreNames.contains(ATTEMPTS)) {
        db.createObjectStore(ATTEMPTS, { keyPath: ["actorId", "id"] });
      }
      if (!db.objectStoreNames.contains(LAST_ACCOUNT)) {
        db.createObjectStore(LAST_ACCOUNT, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PENDING_LOGOUT)) {
        db.createObjectStore(PENDING_LOGOUT, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openTx<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  run: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const tx = db.transaction(stores, mode);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => () => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    tx.onabort = settle(() => reject(tx.error ?? new Error("IndexedDB transaction aborted")));
    tx.onerror = (event) => {
      event.preventDefault();
      settle(() => reject(tx.error ?? new Error("IndexedDB transaction failed")))();
    };
    const result = run(tx);
    result.then(
      () => undefined,
      (error: unknown) => settle(() => reject(error))(),
    );
    tx.oncomplete = settle(() => {
      result.then(
        (value) => resolve(value),
        () => undefined,
      );
    });
  });
}

function getRequest<T>(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve, reject) => {
    const request = tx.objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = (event) => {
      event.preventDefault();
      reject(request.error);
    };
  });
}

function putRequest(tx: IDBTransaction, store: string, record: unknown): Promise<IDBValidKey> {
  return new Promise<IDBValidKey>((resolve, reject) => {
    const request = tx.objectStore(store).put(record);
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      event.preventDefault();
      reject(request.error);
    };
  });
}

function deleteRequest(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(store).delete(key);
    request.onsuccess = () => resolve();
    request.onerror = (event) => {
      event.preventDefault();
      reject(request.error);
    };
  });
}

function collectByKey<T>(tx: IDBTransaction, store: string, keyRange: IDBKeyRange): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const cursor = tx.objectStore(store).openCursor(keyRange);
    const all: T[] = [];
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        all.push(c.value as T);
        c.continue();
      } else {
        resolve(all);
      }
    };
    cursor.onerror = (event) => {
      event.preventDefault();
      reject(cursor.error);
    };
  });
}

function collectByIndex<T>(
  tx: IDBTransaction,
  store: string,
  indexName: string,
  keyRange: IDBKeyRange,
): Promise<T[]> {
  return new Promise<T[]>((resolve, reject) => {
    const cursor = tx.objectStore(store).index(indexName).openCursor(keyRange);
    const all: T[] = [];
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        all.push(c.value as T);
        c.continue();
      } else {
        resolve(all);
      }
    };
    cursor.onerror = (event) => {
      event.preventDefault();
      reject(cursor.error);
    };
  });
}

function deleteByPrefix(tx: IDBTransaction, store: string, prefix: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cursor = tx
      .objectStore(store)
      .openCursor(IDBKeyRange.bound([...prefix, ""], [...prefix, MAX_STRING]));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (c) {
        c.delete();
        c.continue();
      } else {
        resolve();
      }
    };
    cursor.onerror = (event) => {
      event.preventDefault();
      reject(cursor.error);
    };
  });
}

export async function openCharacterStore(name: string): Promise<CharacterStore> {
  const db = await openDatabase(name);

  // Account tombstones also protect GETs begun before any character row existed.
  const accountGeneration = async (tx: IDBTransaction, actorId: string) =>
    (await getRequest<{ generation: number }>(tx, LAST_ACCOUNT, `generation:${actorId}`))?.generation ?? 0;

  async function deleteOnlineAttemptsForCharacter(tx: IDBTransaction, actorId: string, characterId: string): Promise<void> {
    const attempts = await collectByKey<OnlineAttempt>(
      tx,
      ATTEMPTS,
      IDBKeyRange.bound([actorId], [actorId, MAX_STRING]),
    );
    for (const attempt of attempts) {
      if (attempt.characterId === characterId) {
        await deleteRequest(tx, ATTEMPTS, [actorId, attempt.id]);
      }
    }
  }

  return {
    async read(actorId, characterId) {
      return openTx(db, [CHAR, QUEUE, LAST_ACCOUNT], "readonly", async tx => {
        const record = await getRequest<CharacterRecord>(tx, CHAR, [actorId, characterId]);
        const keyRange = IDBKeyRange.bound(
          [actorId, characterId, Number.MIN_SAFE_INTEGER],
          [actorId, characterId, Number.MAX_SAFE_INTEGER],
        );
        const entries = await collectByIndex<QueueEntry>(tx, QUEUE, "by-seq", keyRange);
        return {
          confirmed: record?.confirmed ?? null,
          entries,
          generation: record?.generation ?? await accountGeneration(tx, actorId),
        };
      });
    },

    async enqueue(entry) {
      await openTx(db, [CHAR, QUEUE, LAST_ACCOUNT], "readwrite", async (tx) => {
        const key: IDBValidKey = [entry.actorId, entry.characterId];
        const existing = await getRequest<CharacterRecord>(tx, CHAR, key);
        if (!existing) {
          await putRequest(tx, CHAR, {
            actorId: entry.actorId,
            characterId: entry.characterId,
            confirmed: null,
            generation: await accountGeneration(tx, entry.actorId),
          } satisfies CharacterRecord);
        }
        await putRequest(tx, QUEUE, entry);
      });
    },

    async freeze(actorId, characterId, entryId, request) {
      await openTx(db, [QUEUE], "readwrite", async (tx) => {
        const key: IDBValidKey = [actorId, characterId, entryId];
        const existing = await getRequest<QueueEntry>(tx, QUEUE, key);
        if (!existing) {
          throw new Error("queue entry not found");
        }
        if (existing.attempt !== null && JSON.stringify(existing.attempt) !== JSON.stringify(request)) {
          throw new Error("cannot change an already-frozen request");
        }
        await putRequest(tx, QUEUE, { ...existing, attempt: request });
      });
    },

    async acknowledge(actorId, characterId, entryId, character, generation) {
      await openTx(db, [CHAR, QUEUE, LAST_ACCOUNT], "readwrite", async (tx) => {
        const account = await getRequest<{ actorId: string }>(tx, LAST_ACCOUNT, "last");
        if (account && account.actorId !== actorId) throw new Error("stale acknowledgment: account changed");
        const record = await getRequest<CharacterRecord>(tx, CHAR, [actorId, characterId]);
        if (!record || record.generation !== generation) {
          throw new Error("stale acknowledgment: generation changed");
        }
        const acknowledged = await getRequest<QueueEntry>(tx, QUEUE, [actorId, characterId, entryId]);
        await deleteRequest(tx, QUEUE, [actorId, characterId, entryId]);
        // Persist own-queue progression with the receipt, never with an external GET.
        if (acknowledged) {
          const pending = await collectByKey<QueueEntry>(tx, QUEUE, IDBKeyRange.bound(
            [actorId, characterId, ""], [actorId, characterId, MAX_STRING],
          ));
          for (const entry of pending) {
            if (entry.attempt === null && entry.sequence > acknowledged.sequence &&
                entry.baseRevision === acknowledged.baseRevision && entry.packageChecksum === acknowledged.packageChecksum) {
              await putRequest(tx, QUEUE, {
                ...entry, baseRevision: character.reconciliation.revision, packageChecksum: character.projection.packageChecksum,
              });
            }
          }
        }
        record.confirmed = character;
        record.generation += 1;
        await putRequest(tx, CHAR, record);
      });
    },

    async confirmSnapshot(actorId, characterId, character, generation) {
      await openTx(db, [CHAR, LAST_ACCOUNT], "readwrite", async (tx) => {
        const account = await getRequest<{ actorId: string }>(tx, LAST_ACCOUNT, "last");
        if (account && account.actorId !== actorId) throw new Error("stale snapshot confirm: account changed");
        const record = await getRequest<CharacterRecord>(tx, CHAR, [actorId, characterId]);
        if ((record?.generation ?? await accountGeneration(tx, actorId)) !== generation) {
          throw new Error("stale snapshot confirm: generation changed");
        }
        const fresh = record ?? {
          actorId,
          characterId,
          generation,
          confirmed: null as CharacterView | null,
        };
        fresh.confirmed = character;
        fresh.generation += 1;
        await putRequest(tx, CHAR, fresh);
      });
    },

    async retireEntries(actorId, characterId, entryIds, generation) {
      await openTx(db, [CHAR, QUEUE], "readwrite", async (tx) => {
        const record = await getRequest<CharacterRecord>(tx, CHAR, [actorId, characterId]);
        if (!record || record.generation !== generation) {
          throw new Error("stale retirement: generation changed");
        }
        record.generation += 1;
        await putRequest(tx, CHAR, record);
        for (const entryId of entryIds) {
          await deleteRequest(tx, QUEUE, [actorId, characterId, entryId]);
        }
      });
    },

    async purgeCharacter(actorId, characterId) {
      await openTx(db, [CHAR, QUEUE, ATTEMPTS, LAST_ACCOUNT], "readwrite", async (tx) => {
        const record = await getRequest<CharacterRecord>(tx, CHAR, [actorId, characterId]) ?? {
          actorId, characterId, confirmed: null, generation: await accountGeneration(tx, actorId),
        };
        record.confirmed = null;
        record.generation += 1;
        await putRequest(tx, CHAR, record);
        await deleteByPrefix(tx, QUEUE, [actorId, characterId]);
        await deleteOnlineAttemptsForCharacter(tx, actorId, characterId);
      });
    },

    async clearAccount(actorId) {
      await openTx(db, [CHAR, QUEUE, ATTEMPTS, LAST_ACCOUNT], "readwrite", async (tx) => {
        await putRequest(tx, LAST_ACCOUNT, {
          key: `generation:${actorId}`, generation: await accountGeneration(tx, actorId) + 1,
        });
        const characters = await collectByKey<CharacterRecord>(
          tx,
          CHAR,
          IDBKeyRange.bound([actorId], [actorId, MAX_STRING]),
        );
        for (const record of characters) {
          record.confirmed = null;
          record.generation += 1;
          await putRequest(tx, CHAR, record);
        }
        await deleteByPrefix(tx, QUEUE, [actorId]);
        const attempts = await collectByKey<OnlineAttempt>(
          tx,
          ATTEMPTS,
          IDBKeyRange.bound([actorId], [actorId, MAX_STRING]),
        );
        for (const attempt of attempts) {
          await deleteRequest(tx, ATTEMPTS, [actorId, attempt.id]);
        }

        const marker = await getRequest<{ actorId: string }>(tx, LAST_ACCOUNT, "last");
        if (marker && marker.actorId === actorId) {
          await deleteRequest(tx, LAST_ACCOUNT, "last");
        }
      });
    },

    async close() {
      db.close();
    },

    async saveOnlineAttempt(attempt) {
      await openTx(db, [ATTEMPTS], "readwrite", (tx) => putRequest(tx, ATTEMPTS, attempt));
    },

    async readOnlineAttempts(actorId) {
      return openTx(db, [ATTEMPTS], "readonly", (tx) =>
        collectByKey<OnlineAttempt>(tx, ATTEMPTS, IDBKeyRange.bound([actorId], [actorId, MAX_STRING])),
      );
    },

    async deleteOnlineAttempt(actorId, attemptId) {
      await openTx(db, [ATTEMPTS], "readwrite", (tx) =>
        deleteRequest(tx, ATTEMPTS, [actorId, attemptId]),
      );
    },

    async deleteOnlineAttemptsForCharacter(actorId, characterId) {
      await openTx(db, [ATTEMPTS], "readwrite", (tx) =>
        deleteOnlineAttemptsForCharacter(tx, actorId, characterId),
      );
    },

    async setLastAccount(actorId, expectedAccount) {
      return openTx(db, [LAST_ACCOUNT], "readwrite", async tx => {
        const current = (await getRequest<{ actorId: string }>(tx, LAST_ACCOUNT, "last"))?.actorId ?? null;
        if (expectedAccount !== undefined && current !== expectedAccount && current !== actorId) {
          throw new Error("stale account confirmation");
        }
        await putRequest(tx, LAST_ACCOUNT, { key: "last", actorId });
        return current !== actorId;
      });
    },

    async readLastAccount() {
      const marker = await openTx(db, [LAST_ACCOUNT], "readonly", (tx) =>
        getRequest<{ actorId: string }>(tx, LAST_ACCOUNT, "last"),
      );
      return marker?.actorId ?? null;
    },

    async setPendingLogout(actorId) {
      await openTx(db, [PENDING_LOGOUT], "readwrite", (tx) =>
        putRequest(tx, PENDING_LOGOUT, { key: "pending", actorId }),
      );
    },

    async readPendingLogout() {
      const record = await openTx(db, [PENDING_LOGOUT], "readonly", (tx) =>
        getRequest<{ actorId: string }>(tx, PENDING_LOGOUT, "pending"),
      );
      return record?.actorId ?? null;
    },

    async clearPendingLogout() {
      await openTx(db, [PENDING_LOGOUT], "readwrite", (tx) =>
        deleteRequest(tx, PENDING_LOGOUT, "pending"),
      );
    },
  };
}
