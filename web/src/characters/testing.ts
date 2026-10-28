import { ApiError } from "../api/client.js";

export const PUSH_ROOT_ID = "30000000-0000-4000-8000-000000000001";
export function makePushRoll(): NonNullable<CommandResultResponse["result"]["roll"]> {
  return {
    actionId:"roll",expression:'group("base", "Base", 2d6)',dice:[{id:"base:0",groupId:"base",sides:6,value:2,kept:true},{id:"base:1",groupId:"base",sides:6,value:5,kept:true}],bindings:[],total:7,output:"Private pool",audience:"owner_only",
    breakdown:{version:"1.0",rootId:"root",groups:[{id:"base",label:"Base",count:2,sides:6,operation:"sum",diceIds:["base:0","base:1"],total:7}],terms:[{id:"root",operation:"dice",operandIds:[],value:7,groupId:"base"}]},
    push:{version:"1.0",rollId:"30000000-0000-4000-8000-000000000002",rootRollId:PUSH_ROOT_ID,parentRollId:PUSH_ROOT_ID,attempt:1,maxAttempts:2,rerolledDiceIds:["base:0","base:1"],faceOutcomes:[]},
  };
}

/** FIFO browser scheduling, including queued-lock cancellation, without lease stealing. */
export function createTestLocks(): LockManager {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  return { request(name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown) {
    return new Promise<unknown>((resolve, reject) => {
      const queue = queues.get(name) ?? [];
      queues.set(name, queue);
      const abort = () => {
        const index = queue.indexOf(run);
        if (index >= 0) queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const run = () => {
        options.signal?.removeEventListener("abort", abort);
        if (options.signal?.aborted) { abort(); return; }
        held.add(name);
        Promise.resolve().then(() => callback({ name })).then(resolve, reject).finally(() => {
          held.delete(name);
          queue.shift()?.();
        });
      };
      if (options.signal?.aborted) { abort(); return; }
      if (held.has(name)) {
        if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
        queue.push(run);
        options.signal?.addEventListener("abort", abort, { once: true });
      } else run();
    });
  } } as LockManager;
}
import type {
  CharacterView,
  CommandResultResponse,
  FrozenRequest,
  OpenCharacterResponse,
  QueueEntry,
} from "./types.js";

export function makeView(overrides: Partial<CharacterView> & { characterId: string; revision: number }): CharacterView {
  return {
    ownerId: "00000000-0000-4000-8000-000000000000",
    campaignId: null,
    controllers: [],
    placementGeneration: 1,
    returnOwnerId: null,
    name: "Aria",
    systemVersionId: "11111111-1111-4000-8000-000000000000",
    entityDefinitionId: "hero",
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
      sheets: [] as CharacterView["projection"]["sheets"],
      derivedValues: {},
      validations: [],
    },
    reconciliation: {
      characterId: overrides.characterId,
      baseRevision: null,
      revision: overrides.revision,
      packageChecksum: "abc",
      projectionVersion: "1.0",
      commandExecutionId: "",
      replayExpiresAt: "2026-09-06T00:00:00.000Z",
      replayed: false,
      changedDefinitionIds: [],
      activityCursor: null,
      cacheDisposition: "retain",
    },
    ...overrides,
  };
}

export function makeEnvelope(view: CharacterView): CommandResultResponse {
  return {
    result: {
      character: view,
      roll: null,
      nominal: null,
    },
    requestId: "req-1",
  };
}

export function makeOpenEnvelope(view: CharacterView): OpenCharacterResponse {
  return {
    character: view,
    requestId: "req-1",
  };
}

export function makeEntry(overrides: Partial<QueueEntry> & { characterId: string }): QueueEntry {
  return {
    id: "entry-1",
    actorId: "actor-A",
    sequence: 0,
    baseRevision: 1,
    packageChecksum: "abc",
    createdAt: "2026-09-06T00:00:00.000Z",
    intent: { kind: "setField", fieldId: "name", value: "Briar" },
    attempt: null,
    ...overrides,
  };
}

export function makeRequest(overrides: Partial<FrozenRequest> = {}): FrozenRequest {
  return {
    method: "POST",
    path: "/characters/char-1/fields/name/set",
    body: { value: "Briar", expectedRevision: 1, idempotencyKey: "key-1" },
    firstAttemptAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

export function apiError(overrides: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return new ApiError({
    code: "internal",
    message: "boom",
    status: 500,
    requestId: "req-1",
    latestRevision: null,
    diagnostics: [],
    ...overrides,
  });
}
