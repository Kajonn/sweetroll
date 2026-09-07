import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type {
  ActivityResponse,
  CharacterExport,
  CharacterView,
  CreationOptions,
  FrozenRequest,
  MigrationPreviewBody,
  MigrationPreviewResponse,
  OpenCharacterResponse,
} from "./types.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import { makeEntry, makeView } from "./testing.js";
import { createCharacterSession } from "./session.js";
import type { CharacterSession, CoordinationEvent, CoordinationPort, IdentityPort } from "./session.js";

let counter = 0;
let dbName = "sweetroll-session-test";

beforeEach(() => {
  counter += 1;
  dbName = `sweetroll-session-test-${counter}`;
});

const ARM = "00000000-0000-4000-8000-000000000000";
const EVER = "2026-09-06T00:00:00.000Z";

it("rejects an already accepted edit whose enqueue arrives after another tab's logout", async () => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1)); await session.open();
  identity.online = false; identity.signal();
  let finish!: () => void;
  const enqueue = store.enqueue.bind(store);
  vi.spyOn(store, "enqueue").mockImplementation(async (...args) => {
    await new Promise<void>(resolve => { finish = resolve; });
    await enqueue(...args);
  });
  const edit = expect(session.setField("name", "private")).rejects.toThrow(/stale/);
  await vi.waitFor(() => expect(finish).toBeDefined());
  await store.clearAccount(ARM);
  finish(); await edit; await session.whenIdle();
  expect(await store.read(ARM, "char-1")).toMatchObject({ confirmed: null, entries: [] });
  expect(session.getSnapshot().confirmed).toBeNull();
  expect(api.sent).toEqual([]);
  session.dispose(); await store.close();
});

it("cannot recreate recovery intentions when another tab clears the account after retirement", async () => {
  const { session, api, store } = await makeHarness();
  await seedConfirmed(store, "char-1", viewFor("char-1", 1));
  await seedQueue(store, "char-1", [{ id: "pending", intent: { kind: "setField", fieldId: "name", value: "private" } }]);
  api.scriptOpenView(viewFor("char-1", 2)); await session.open();
  const retire = store.resolveEntries.bind(store);
  vi.spyOn(store, "resolveEntries").mockImplementation(async (...args) => {
    await retire(...args); await store.clearAccount(ARM);
  });
  await expect(session.resolveConflict({ mode: "reapply", selectedIds: ["pending"] })).rejects.toThrow(/stale/);
  expect(await store.read(ARM, "char-1")).toMatchObject({ confirmed: null, entries: [] });
  expect(api.sent).toEqual([]);
  session.dispose(); await store.close();
});

it("reports a failed initial store read without rejecting the observable session lifecycle", async () => {
  const { session, store } = await makeHarness();
  vi.spyOn(store, "read").mockRejectedValue(new Error("storage unavailable"));
  await expect(session.open()).resolves.toBeUndefined();
  expect(session.getSnapshot().phase).toBe("storage-error");
  session.dispose(); await store.close();
});

it("retries a denied initial acquisition so a releasing predecessor does not wedge the sheet read-only", async () => {
  // Regression for StrictMode double-mount (and any transient holder): the
  // first session's async Web Lock release can deny the remount's
  // ifAvailable acquisition. A bounded init retry recovers; a genuine
  // second tab still settles read-only once retries exhaust.
  const { api, coordination, session, store } = await makeHarness("char-1", false);
  let calls = 0;
  const realRequestEditing = coordination.requestEditing.bind(coordination);
  coordination.requestEditing = async () => {
    calls += 1;
    if (calls < 3) return false;
    return realRequestEditing();
  };
  api.scriptOpenView(viewFor("char-1", 1));
  await session.open();
  await vi.waitFor(() => expect(session.getSnapshot().editing.owned).toBe(true));
  expect(calls).toBeGreaterThanOrEqual(3);
  await vi.waitFor(() => expect(session.getSnapshot().confirmed?.revision).toBe(1));
  session.dispose(); await store.close();
});

it("keeps snapshots stable and hides cached data on account switch", async () => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1));
  await session.open();
  expect(session.getSnapshot()).toBe(session.getSnapshot());
  identity.actorId = "other";
  identity.generationCounter++;
  identity.signal();
  expect(session.getSnapshot().confirmed).toBeNull();
  await expect(session.setField("name", "leak")).rejects.toThrow();
  session.dispose(); await store.close();
});

it("hides private validation details when the account changes", async () => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1)); await session.open();
  api.scriptSend(async () => ({ error: new ApiError({ status: 422, code: "invalid_value", message: "private character detail", requestId: "r", latestRevision: null, diagnostics: [] }) }));
  await session.setField("name", "Briar"); await session.whenIdle();
  expect(session.getSnapshot().error?.message).toBe("private character detail");
  identity.actorId = "other"; identity.generationCounter++; identity.signal();
  expect(session.getSnapshot().error).toBeNull();
  session.dispose(); await store.close();
});

it("ignores late success after identity changes without modifying the frozen attempt", async () => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1));
  await session.open();
  const pending = deferredEnvelope();
  api.scriptSend(() => pending.promise);
  await session.setField("name", "Briar");
  await vi.waitFor(() => expect(api.sent).toHaveLength(1));
  const before = await store.read(ARM, "char-1");
  identity.actorId = "other"; identity.generationCounter++; identity.signal();
  pending.release(viewFor("char-1", 2));
  await session.whenIdle();
  expect(await store.read(ARM, "char-1")).toEqual(before);
  expect(session.getSnapshot().confirmed).toBeNull();
  session.dispose(); await store.close();
});

it("checks identity again after persisting a frozen attempt, before sending", async () => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1)); await session.open();
  const freeze = store.freeze.bind(store);
  vi.spyOn(store, "freeze").mockImplementation(async (...args) => {
    await freeze(...args);
    identity.actorId = "other"; identity.generationCounter++; identity.signal();
  });
  await session.setField("name", "Briar"); await session.whenIdle();
  expect(api.sent).toEqual([]);
  expect((await store.read(ARM, "char-1")).entries[0]?.attempt).not.toBeNull();
  expect(session.getSnapshot().confirmed).toBeNull();
  session.dispose(); await store.close();
});

it.each([401, 404, 409])("ignores late %s errors after account switch without purge or refresh", async status => {
  const { session, api, identity, store } = await makeHarness();
  api.scriptOpenView(viewFor("char-1", 1)); await session.open();
  let reject!: (error: Error) => void;
  api.scriptSend(() => new Promise((_resolve, fail) => { reject = fail; }));
  await session.setField("name", "Briar");
  await vi.waitFor(() => expect(api.sent).toHaveLength(1));
  const before = await store.read(ARM, "char-1");
  const open = vi.spyOn(api, "open");
  identity.actorId = "other"; identity.generationCounter++; identity.signal();
  reject(new ApiError({ status, code: "error", message: "private", cacheDisposition: "purge", requestId: "r", latestRevision: null, diagnostics: [] }));
  await session.whenIdle();
  expect(await store.read(ARM, "char-1")).toEqual(before);
  expect(open).not.toHaveBeenCalled();
  expect(session.getSnapshot().confirmed).toBeNull();
  session.dispose(); await store.close();
});

it("ignores a late initial GET after account switch", async () => {
  const { session, api, identity, store } = await makeHarness();
  let finish!: (value: OpenCharacterResponse) => void;
  api.setOpenFallback(() => new Promise(resolve => { finish = resolve; }));
  const opening = session.open();
  await vi.waitFor(() => expect(finish).toBeDefined());
  identity.actorId = "other"; identity.generationCounter++; identity.signal();
  finish({ character: viewFor("char-1", 1), requestId: "r" });
  await opening;
  expect((await store.read(ARM, "char-1")).confirmed).toBeNull();
  expect(session.getSnapshot().confirmed).toBeNull();
  session.dispose(); await store.close();
});

function viewFor(characterId: string, revision: number, overrides: Partial<CharacterView> = {}): CharacterView {
  return makeView({ characterId, revision, ...overrides });
}

type SendStep = { error?: unknown; envelope?: import("./types.js").CommandResultResponse };

class FakeApi implements CharactersApi {
  sent: FrozenRequest[] = [];
  private sendScript: Array<(req: FrozenRequest) => Promise<SendStep>> = [];
  private sendFallback: (req: FrozenRequest) => Promise<SendStep> = () =>
    Promise.reject(new Error("unhandled send"));
  private openScript: OpenCharacterResponse[] = [];
  private openFallback: () => Promise<OpenCharacterResponse> = () =>
    Promise.reject(new Error("unhandled open"));

  scriptOpen(response: OpenCharacterResponse) {
    this.openScript.push(response);
  }
  scriptOpenView(character: CharacterView) {
    this.openScript.push({ character, requestId: "req-open" } as OpenCharacterResponse);
  }
  scriptOpenError(error: Error) {
    this.openScript.push({ __error: error } as unknown as OpenCharacterResponse);
  }
  setOpenFallback(handler: () => Promise<OpenCharacterResponse>) {
    this.openFallback = handler;
  }
  scriptSend(handler: (req: FrozenRequest) => Promise<SendStep>) {
    this.sendScript.push(handler);
  }
  setSendFallback(handler: (req: FrozenRequest) => Promise<SendStep>) {
    this.sendFallback = handler;
  }

  async open(_characterId: string): Promise<OpenCharacterResponse> {
    const planned = this.openScript.length > 0 ? this.openScript.shift()! : null;
    if (planned !== null) {
      if ("__error" in (planned as object)) {
        throw (planned as unknown as { __error: Error }).__error;
      }
      return planned;
    }
    return this.openFallback();
  }

  async send(request: FrozenRequest) {
    this.sent.push(request);
    const handler = this.sendScript.length > 0 ? this.sendScript.shift()! : this.sendFallback;
    const step = await handler(request);
    if (step.error !== undefined) throw step.error;
    if (step.envelope === undefined) throw new Error("no envelope in send step");
    return step.envelope;
  }

  creationOptions(): Promise<CreationOptions> {
    throw new Error("unused");
  }
  activity(): Promise<ActivityResponse> {
    throw new Error("unused");
  }
  export(): Promise<CharacterExport> {
    throw new Error("unused");
  }
  previewMigration(_characterId: string, _b: MigrationPreviewBody): Promise<MigrationPreviewResponse> {
    throw new Error("unused");
  }
}

class FakeIdentity implements IdentityPort {
  actorId: string | null = null;
  online = true;
  generationCounter = 0;
  private listeners = new Set<() => void>();

  getActorId() {
    return this.actorId;
  }
  isOnline() {
    return this.online;
  }
  getGeneration() {
    return this.generationCounter;
  }
  async isCurrent() { return true; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  signal() {
    for (const l of [...this.listeners]) l();
  }
}

class FakeCoordination implements CoordinationPort {
  owner = true;
  private listeners = new Set<(event: CoordinationEvent) => void>();

  isOwner() {
    return this.owner;
  }
  async requestEditing() {
    this.owner = true;
    return true;
  }
  letGo() {
    this.owner = false;
  }
  subscribe(listener: (event: CoordinationEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  signalOwnership(owned: boolean, ownerId: string | null = null) {
    this.owner = owned;
    for (const l of [...this.listeners]) l({ type: "ownership-changed", owned, owner: ownerId });
  }
}

interface Harness {
  api: FakeApi;
  identity: FakeIdentity;
  coordination: FakeCoordination;
  store: CharacterStore;
  session: CharacterSession;
}

async function makeHarness(characterId = "char-1", initialOwner = true): Promise<Harness> {
  const api = new FakeApi();
  const identity = new FakeIdentity();
  const coordination = new FakeCoordination();
  coordination.owner = initialOwner;
  identity.actorId = ARM;
  let n = 0;
  const store = await openCharacterStore(dbName);
  const session = createCharacterSession({
    actorId: ARM,
    characterId,
    api,
    store,
    identity,
    coordination,
    now: () => EVER,
    newId: () => `id-${++n}`,
  });
  return { api, identity, coordination, store, session };
}

function successEnvelope(c: CharacterView): SendStep {
  return { envelope: { result: { character: c, roll: null }, requestId: "req-1" } };
}

function deferredEnvelope() {
  let release!: (step: SendStep) => void;
  const promise = new Promise<SendStep>((resolve) => {
    release = resolve;
  });
  return { promise, release: (c: CharacterView) => release(successEnvelope(c)) };
}

function conflictError() {
  return new ApiError({
    code: "expected_revision_mismatch",
    message: "The character has a newer revision.",
    status: 409,
    requestId: "req-1",
    latestRevision: 7,
    diagnostics: [],
  });
}

async function seedConfirmed(store: CharacterStore, characterId: string, confirmed: CharacterView) {
  await store.enqueue(
    makeEntry({
      id: "seed-confirmed",
      actorId: ARM,
      characterId,
      sequence: 0,
      baseRevision: confirmed.reconciliation.revision,
      packageChecksum: confirmed.projection.packageChecksum,
      intent: { kind: "setField", fieldId: "name", value: confirmed.state.values.name ?? null },
    }),
    await store.read(ARM, characterId),
  );
  const frozen: FrozenRequest = {
    method: "POST",
    path: `/characters/${characterId}/fields/name/set`,
    body: {
      value: confirmed.state.values.name ?? null,
      expectedRevision: confirmed.reconciliation.revision,
      idempotencyKey: "seed-key",
    },
    firstAttemptAt: EVER,
  };
  await store.freeze(ARM, characterId, "seed-confirmed", frozen);
  const { generation } = await store.read(ARM, characterId);
  await store.acknowledge(ARM, characterId, "seed-confirmed", confirmed, generation);
}

async function seedQueue(
  store: CharacterStore,
  characterId: string,
  entries: { id: string; intent: import("./types.js").EditIntent; request?: FrozenRequest }[],
) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const entry = makeEntry({
      id: e.id,
      actorId: ARM,
      characterId,
      sequence: i + 1,
      baseRevision: 1,
      packageChecksum: "abc",
      createdAt: EVER,
      intent: e.intent,
      attempt: e.request ?? null,
    });
    await store.enqueue(entry, await store.read(ARM, characterId));
    if (e.request) {
      await store.freeze(ARM, characterId, entry.id, e.request);
    }
  }
}

describe("CharacterSession", () => {
  it("retries the exact frozen request after crash-after-send-before-ack across reopen", async () => {
    const { api, store, session } = await makeHarness();
    const frozen: FrozenRequest = {
      method: "POST",
      path: "/characters/char-1/fields/name/set",
      body: { value: "Briar", expectedRevision: 1, idempotencyKey: "frozen-key" },
      firstAttemptAt: EVER,
    };
    // The prior tab already sent this exact request and crashed before acking.
    api.sent.push(frozen);
    await seedQueue(store, "char-1", [
      { id: "e1", intent: { kind: "setField", fieldId: "name", value: "Briar" }, request: frozen },
    ]);

    api.scriptSend(async () => ({ error: new TypeError("network down") }));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 2), requestId: "req-open" }));

    await session.open();

    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe("ready"));
    expect(api.sent[0]?.body).toEqual(frozen.body);
    expect(api.sent[1]?.body).toEqual(frozen.body);
    expect(api.sent[1]?.body.idempotencyKey).toBe("frozen-key");
    const snap = session.getSnapshot();
    expect(snap.confirmed?.revision).toBe(2);
    expect(snap.entries).toEqual([]);
    expect(snap.phase).toBe("ready");
    const stored = await store.read(ARM, "char-1");
    expect(stored.entries).toEqual([]);
    await store.close();
  });

  it("advances confirmed revision from returned revisions and chains expectedRevision", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 3)));
    await session.open();

    await session.setField("health", 13);
    await session.whenIdle();
    await session.setField("gold", 10);
    await session.whenIdle();

    expect(api.sent[0]?.body.expectedRevision).toBe(1);
    expect(api.sent[1]?.body.expectedRevision).toBe(2);
    expect(session.getSnapshot().confirmed?.revision).toBe(3);
    expect(session.getSnapshot().entries).toEqual([]);
    await store.close();
  });

  it("adopts an externally drifted server view on a character this tab did not edit", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 5));
    await session.open();

    expect(session.getSnapshot().confirmed?.revision).toBe(5);
    expect(session.getSnapshot().phase).toBe("ready");
    expect(session.getSnapshot().entries).toEqual([]);
    const stored = await store.read(ARM, "char-1");
    expect(stored.confirmed?.revision).toBe(5);
    await store.close();
  });

  it("keeps confirmed revision on a pure roll while clearing the entry", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 1)));
    await session.open();

    await session.executeAction("ironclad", { difficulty: 10 });
    await session.whenIdle();

    expect(session.getSnapshot().confirmed?.revision).toBe(1);
    expect(session.getSnapshot().entries).toEqual([]);
    const stored = await store.read(ARM, "char-1");
    expect(stored.entries).toEqual([]);
    await store.close();
  });

  it("retries an already-frozen action attempt through the same immutable-attempt path", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    const frozen: FrozenRequest = {
      method: "POST",
      path: "/characters/char-1/actions/ironclad",
      body: { inputs: { difficulty: 10 }, expectedRevision: 1, idempotencyKey: "action-key" },
      firstAttemptAt: EVER,
    };
    await seedQueue(store, "char-1", [
      { id: "e-action", intent: { kind: "executeAction", actionId: "ironclad", inputs: { difficulty: 10 } }, request: frozen },
    ]);
    api.scriptOpenView(viewFor("char-1", 1));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 1)));
    await session.open();

    expect(api.sent[0]?.body.idempotencyKey).toBe("action-key");
    expect(api.sent[0]?.path).toBe("/characters/char-1/actions/ironclad");
    expect(session.getSnapshot().entries).toEqual([]);
    await store.close();
  });

  it("pauses on a definitive invalid value without advancing dependent commands", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const invalid = new ApiError({
      code: "invalid_value",
      message: "Value is out of range.",
      status: 422,
      requestId: "req-1",
      latestRevision: 1,
      diagnostics: [],
    });
    api.scriptSend(async () => ({ error: invalid }));

    const first = session.setField("health", 99).catch(() => {});
    const dependent = session.setField("gold", 10).catch(() => {});
    await session.whenIdle();

    const snap = session.getSnapshot();
    expect(snap.phase).toBe("invalid");
    expect(snap.error?.kind).toBe("invalid");
    expect(api.sent).toHaveLength(1);

    api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    await session.resolveConflict({ mode: "discard", selectedIds: [snap.entries[0]!.id] });
    await first;
    await session.whenIdle();
    expect(api.sent).toHaveLength(2);
    expect(session.getSnapshot().phase).toBe("ready");
    await dependent;
    await store.close();
  });

  it("reapplies selected conflict entries with new keys in preserved order", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 7));

    const first = session.setField("health", 11).catch(() => {});
    const second = session.setField("gold", 20).catch(() => {});
    const third = session.setField("name", "Ivy").catch(() => {});
    await session.whenIdle();

    expect(session.getSnapshot().phase).toBe("conflict");
    // Recovery is selection-safe: only an ordered prefix of the unresolved
    // entries may be reviewed at once, so reapply the full set here. Partial
    // selection keeps the remainder paused (see selection-safe tests below).
    const selected = session.getSnapshot().entries.map((e) => e.id);
    expect(selected).toHaveLength(3);
    expect(session.getSnapshot().confirmed?.revision).toBe(7);
    expect((await store.read(ARM, "char-1")).confirmed?.revision).toBe(7);
    expect(session.getSnapshot().tentative).toEqual({ health: 11, gold: 20, name: "Ivy" });

    api.scriptSend(async () => successEnvelope(viewFor("char-1", 8)));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 9)));
    api.scriptSend(async () => successEnvelope(viewFor("char-1", 10)));

    await session.resolveConflict({ mode: "reapply", selectedIds: selected });
    await session.whenIdle();
    await first;
    await second;
    await third;

    const sent = api.sent;
    expect(sent).toHaveLength(4);
    expect(sent[0]?.body.idempotencyKey).not.toBe(sent[1]?.body.idempotencyKey);
    expect(sent[1]?.body.expectedRevision).toBe(7);
    expect(sent[2]?.body.expectedRevision).toBe(8);
    expect(sent[3]?.body.expectedRevision).toBe(9);
    expect(sent[1]?.path).toContain("/fields/health/set");
    expect(sent[2]?.path).toContain("/fields/gold/set");
    expect(sent[3]?.path).toContain("/fields/name/set");
    expect(session.getSnapshot().entries).toEqual([]);
    await store.close();
  });

  it("pauses on 401, retains the attempt, and resumes with the same frozen request after same-account reauth", async () => {
    const { api, identity, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const unauthorized = new ApiError({
      code: "unauthorized",
      message: "Session expired.",
      status: 401,
      requestId: "req-1",
      latestRevision: null,
      diagnostics: [],
    });
    api.scriptSend(async () => ({ error: unauthorized }));
    await session.setField("health", 13);
    await session.whenIdle();

    expect(session.getSnapshot().phase).toBe("reauthenticate");
    expect(api.sent).toHaveLength(1);
    const retained = await store.read(ARM, "char-1");
    expect(retained.entries[0]?.attempt).toEqual(api.sent[0]);

    api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    // Same account re-authenticates: the identity port signals and the drain resumes.
    identity.signal();
    await session.whenIdle();

    expect(api.sent[1]?.body).toEqual(api.sent[0]?.body);
    expect(session.getSnapshot().phase).toBe("ready");
    await store.close();
  });

  it("purges the character on a 404 with cacheDisposition purge and exposes a generic error", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const purge = new ApiError({
      code: "not_found",
      message: "entity_not_found: characters/char-1 with private payload details",
      status: 404,
      requestId: "req-1",
      latestRevision: null,
      diagnostics: [],
      cacheDisposition: "purge",
    });
    api.scriptSend(async () => ({ error: purge }));
    await session.setField("health", 13).catch(() => {});
    await session.whenIdle();

    const snap = session.getSnapshot();
    expect(snap.phase).toBe("purged");
    expect(snap.error?.kind).toBe("purged");
    expect(String(snap.error?.message)).not.toContain("private payload");
    expect(String(snap.error?.message)).not.toContain("health");
    const stored = await store.read(ARM, "char-1");
    expect(stored.confirmed).toBeNull();
    expect(stored.entries).toEqual([]);
    await expect(session.setField("health", 14)).rejects.toThrow();
    await store.close();
  });

  it("pauses with manual review and no new key for an attempt older than the 30-day replay window", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    const staleRequest: FrozenRequest = {
      method: "POST",
      path: "/characters/char-1/fields/health/set",
      body: { value: 13, expectedRevision: 1, idempotencyKey: "old-key" },
      firstAttemptAt: "2026-07-01T00:00:00.000Z",
    };
    await seedQueue(store, "char-1", [
      { id: "e-old", intent: { kind: "setField", fieldId: "health", value: 13 }, request: staleRequest },
    ]);
    api.scriptOpenView(viewFor("char-1", 1));

    await session.open();

    expect(api.sent).toHaveLength(0);
    expect(session.getSnapshot().phase).toBe("conflict");
    expect(session.getSnapshot().error?.kind).toBe("expired-attempt");
    const stored = await store.read(ARM, "char-1");
    expect(stored.entries[0]?.attempt).toEqual(staleRequest);
    await expect(session.setField("name", "Ivy")).rejects.toThrow();
    await store.close();
  });

  it("enters storage-error and blocks further mutations when enqueue persistence fails", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const realPut = IDBObjectStore.prototype.put;
    let failQueue = true;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "queue" && failQueue) {
        this.transaction.abort();
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return realPut.apply(this, [value, key as IDBValidKey]);
    });
    await expect(session.setField("health", 13)).rejects.toThrow();
    failQueue = false;
    spy.mockRestore();

    const snap = session.getSnapshot();
    expect(snap.phase).toBe("storage-error");
    expect(snap.error?.kind).toBe("storage-error");
    expect(snap.entries).toEqual([]);
    await expect(session.setField("gold", 10)).rejects.toThrow();
    await store.close();
  });

  it("enters storage-error when freezing fails and preserves the durable intention", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    await seedQueue(store, "char-1", [
      { id: "e-pending", intent: { kind: "setField", fieldId: "health", value: 13 } },
    ]);
    api.scriptOpenView(viewFor("char-1", 1));

    const realPut = IDBObjectStore.prototype.put;
    let failQueue = true;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "queue" && failQueue) {
        this.transaction.abort();
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return realPut.apply(this, [value, key as IDBValidKey]);
    });
    await session.open();
    failQueue = false;
    spy.mockRestore();

    expect(session.getSnapshot().phase).toBe("storage-error");
    expect(session.getSnapshot().error?.kind).toBe("storage-error");
    expect(session.getSnapshot().entries).toHaveLength(1);
    expect(session.getSnapshot().entries[0]?.attempt).toBeNull();
    const stored = await store.read(ARM, "char-1");
    expect(stored.entries.length).toBeGreaterThanOrEqual(1);
    await store.close();
  });

  it("ignores a late response whose acknowledgment is rejected by the generation guard", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const d = deferredEnvelope();
    api.scriptSend(async () => d.promise);
    const pending = session.setField("health", 13).catch(() => {});
    // Await the send to be in flight before purging beneath it.
    await new Promise((r) => setTimeout(r, 5));

    await store.purgeCharacter(ARM, "char-1");
    d.release(viewFor("char-1", 2));
    await session.whenIdle();
    await pending;

    const snap = session.getSnapshot();
    expect(snap.phase).toBe("purged");
    expect(snap.entries).toEqual([]);
    expect(snap.confirmed).toBeNull();
    const stored = await store.read(ARM, "char-1");
    expect(stored.entries).toEqual([]);
    expect(stored.confirmed).toBeNull();
    await store.close();
  });

  it("rejects new action initiations while offline but still queues edits offline", async () => {
    const { api, identity, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    identity.online = false;
    identity.signal();

    await expect(session.executeAction("ironclad", {})).rejects.toThrow();
    await session.setField("health", 13);
    await session.whenIdle();
    expect(session.getSnapshot().entries).toHaveLength(1);
    expect(session.getSnapshot().phase).toBe("offline");
    await store.close();
  });

  it("adopts a same-revision legacy projection refresh without losing pending edits", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));

    const refreshed = viewFor("char-1", 1, {
      projection: {
        ...viewFor("char-1", 1).projection,
        completionFields: [
          {
            kind: "field" as const,
            id: "cf-1",
            fieldId: "origin",
            label: "Origin",
            fieldKind: "text" as const,
            value: null,
            editable: true,
            constraints: {},
            validations: [],
          },
        ],
      } as CharacterView["projection"],
    });
    api.scriptOpenView(refreshed);
    await seedQueue(store, "char-1", [
      { id: "legacy-pending", intent: { kind: "setField", fieldId: "origin", value: "Feywild" } },
    ]);
    const pendingBefore = (await store.read(ARM, "char-1")).entries;
    api.scriptSend(async () => {
      const stored = await store.read(ARM, "char-1");
      expect(stored.confirmed?.projection.completionFields).toEqual(refreshed.projection.completionFields);
      expect(stored.entries[0]?.intent).toEqual(pendingBefore[0]?.intent);
      return { error: new ApiError({ code: "invalid_value", status: 422, message: "Invalid", requestId: "r", latestRevision: null, diagnostics: [] }) };
    });
    await session.open();

    const snap = session.getSnapshot();
    expect(snap.confirmed?.projection.completionFields).toBeDefined();
    expect(snap.phase).toBe("invalid");
    expect(snap.tentative).toEqual({ origin: "Feywild" });
    expect((await store.read(ARM, "char-1")).entries[0]?.id).toBe("legacy-pending");
    await store.close();
  });

  it("reports editing ownership via snapshot and pauses mutations on takeover", async () => {
    const { api, coordination, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    expect(session.getSnapshot().editing.owned).toBe(true);
    coordination.signalOwnership(false, "other-tab");
    expect(session.getSnapshot().editing.owned).toBe(false);
    await expect(session.setField("health", 13)).rejects.toThrow();

    await session.requestEditing();
    expect(session.getSnapshot().editing.owned).toBe(true);
    await store.close();
  });
});

describe("CharacterSession store integrity", () => {
  it("send calls always find the same stored attempt before and after a send failure", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    api.scriptSend(async () => ({ error: new TypeError("network down") }));
    const pending = session.setField("health", 13).catch(() => {});
    await pending;
    const duringFail = await store.read(ARM, "char-1");
    expect(duringFail.entries[0]?.attempt).toEqual(api.sent[0]);

    session.dispose();
    await store.close();
  });
});

describe("CharacterSession serialization", () => {
  it.each(["revision", "package"] as const)("retains unresolved %s drift across sessions until explicit reapply", async (drift) => {
    const first = await makeHarness();
    await seedConfirmed(first.store, "char-1", viewFor("char-1", 1));
    first.identity.online = false;
    await first.session.open();
    await first.session.setField("name", "Briar");
    await first.session.whenIdle();
    const latest = viewFor("char-1", drift === "revision" ? 7 : 1);
    if (drift === "package") {
      latest.projection.packageChecksum = "new-package";
      latest.reconciliation.packageChecksum = "new-package";
    }
    first.api.scriptOpenView(latest);
    first.identity.online = true;
    first.identity.signal();
    await first.session.whenIdle();
    expect(first.session.getSnapshot().phase).toBe("conflict");
    const retained = await first.store.read(ARM, "char-1");
    expect(retained.confirmed).toEqual(latest);
    expect(retained.entries[0]).toMatchObject({ baseRevision: 1, packageChecksum: "abc", attempt: null });
    first.session.dispose();
    await first.store.close();

    const second = await makeHarness();
    second.api.scriptOpenView(latest);
    second.api.setSendFallback(async () => successEnvelope(viewFor("char-1", latest.revision + 1)));
    try {
      await second.session.open();
      expect(second.api.sent).toEqual([]);
      expect(second.session.getSnapshot().phase).toBe("conflict");
      expect((await second.store.read(ARM, "char-1")).entries).toEqual(retained.entries);
      await second.session.resolveConflict({ mode: "reapply", selectedIds: retained.entries.map(e => e.id) });
      await second.session.whenIdle();
      expect(second.api.sent).toHaveLength(1);
      expect(second.api.sent[0]?.body).toMatchObject({ expectedRevision: latest.revision, value: "Briar" });
      expect(second.session.getSnapshot().phase).toBe("ready");
      expect((await second.store.read(ARM, "char-1")).entries).toEqual([]);
    } finally { second.session.dispose(); await second.store.close(); }
  });

  it("durably advances its own unsent bases before closing after acknowledgment", async () => {
    const first = await makeHarness();
    await seedConfirmed(first.store, "char-1", viewFor("char-1", 1));
    await seedQueue(first.store, "char-1", [
      { id: "first", intent: { kind: "setField", fieldId: "name", value: "Briar" } },
      { id: "next", intent: { kind: "setField", fieldId: "gold", value: 10 } },
    ]);
    first.api.scriptOpenView(viewFor("char-1", 1));
    first.api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    first.session.subscribe(snapshot => {
      if (snapshot.confirmed?.revision === 2 && snapshot.entries.length === 1) first.session.dispose();
    });
    await first.session.open();
    expect(first.api.sent).toHaveLength(1);
    const retained = await first.store.read(ARM, "char-1");
    expect(retained.entries[0]).toMatchObject({ id: "next", baseRevision: 2, attempt: null });
    await first.store.close();

    const second = await makeHarness();
    second.api.scriptOpenView(viewFor("char-1", 2));
    second.api.scriptSend(async () => successEnvelope(viewFor("char-1", 3)));
    await second.session.open();
    expect(second.api.sent).toHaveLength(1);
    expect(second.api.sent[0]?.body.expectedRevision).toBe(2);
    expect(second.session.getSnapshot().phase).toBe("ready");
    second.session.dispose();
    await second.store.close();
  });

  it("does not treat a GET behind the conflict's latestRevision as a refreshed review base", async () => {
    const { api, store, session, identity } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.setField("name", "Briar");
    await session.whenIdle();
    expect(session.getSnapshot().error?.kind).toBe("network-unavailable");
    const selectedIds = session.getSnapshot().entries.map(e => e.id);
    await expect(session.resolveConflict({ mode: "reapply", selectedIds })).rejects.toThrow();
    api.scriptOpenView(viewFor("char-1", 7));
    identity.signal();
    await session.whenIdle();
    expect(session.getSnapshot().phase).toBe("conflict");
    expect((await store.read(ARM, "char-1")).confirmed?.revision).toBe(7);
    expect(api.sent).toHaveLength(1);
    session.dispose();
    await store.close();
  });

  it("does not offer conflict reapply when persisting the latest GET fails", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 7));
    const confirm = vi.spyOn(store, "confirmSnapshot").mockRejectedValue(new Error("quota"));
    await session.setField("name", "Briar");
    await session.whenIdle();
    expect(session.getSnapshot().error?.kind).toBe("storage-error");
    expect((await store.read(ARM, "char-1")).confirmed?.revision).toBe(1);
    await expect(session.resolveConflict({ mode: "reapply", selectedIds: session.getSnapshot().entries.map(e => e.id) })).rejects.toThrow();
    confirm.mockRestore();
    session.dispose();
    await store.close();
  });

  it("leaves offline intentions unsent until reconnect drift has been checked", async () => {
    const { api, store, session, identity } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    identity.online = false;
    await session.open();
    await session.setField("name", "Briar");
    await session.whenIdle();
    expect((await store.read(ARM, "char-1")).entries[0]?.attempt).toBeNull();
    api.scriptOpenView(viewFor("char-1", 7));
    identity.online = true;
    identity.signal();
    await session.whenIdle();
    expect(api.sent).toEqual([]);
    expect(session.getSnapshot().phase).toBe("conflict");
    expect(session.getSnapshot().tentative).toEqual({ name: "Briar" });
    session.dispose();
    await store.close();
  });

  it("rejects stale session reapply after purge without recreating intentions", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 7));
    await session.setField("name", "Briar");
    await session.whenIdle();
    const selectedIds = session.getSnapshot().entries.map(e => e.id);
    await store.purgeCharacter(ARM, "char-1");
    const purged = await store.read(ARM, "char-1");
    await expect(session.resolveConflict({ mode: "reapply", selectedIds })).rejects.toThrow("stale");
    expect(await store.read(ARM, "char-1")).toEqual(purged);
    expect(api.sent).toHaveLength(1);
    session.dispose();
    await store.close();
  });

  it("settles a failed startup GET with cached data and does not send unsent work", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    await seedQueue(store, "char-1", [{ id: "pending", intent: { kind: "setField", fieldId: "name", value: "Briar" } }]);
    api.scriptOpenError(new TypeError("offline"));
    await session.open();
    expect(session.getSnapshot().phase).toBe("offline");
    expect(session.getSnapshot().confirmed?.revision).toBe(1);
    expect(api.sent).toEqual([]);
    expect((await store.read(ARM, "char-1")).entries[0]?.attempt).toBeNull();
    session.dispose();
    await store.close();
  });

  it("settles open on transport failure with cache and exactly one frozen send", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    const request: FrozenRequest = {
      method: "POST", path: "/characters/char-1/fields/name/set",
      body: { value: "Briar", expectedRevision: 1, idempotencyKey: "old" }, firstAttemptAt: EVER,
    };
    await seedQueue(store, "char-1", [{ id: "pending", intent: { kind: "setField", fieldId: "name", value: "Briar" }, request }]);
    const get = vi.spyOn(api, "open");
    api.setSendFallback(async () => ({ error: new TypeError("offline despite hint") }));
    try {
      await session.open();
      expect(api.sent).toEqual([request]);
      expect(get).not.toHaveBeenCalled();
      expect(session.getSnapshot().confirmed?.revision).toBe(1);
      expect(session.getSnapshot().phase).toBe("uncertain");
      expect((await store.read(ARM, "char-1")).entries[0]?.attempt).toEqual(request);
    } finally { session.dispose(); await store.close(); }
  });

  it("checks drift before freezing unsent work on open", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    await seedQueue(store, "char-1", [{ id: "pending", intent: { kind: "setField", fieldId: "name", value: "Briar" } }]);
    api.scriptOpenView(viewFor("char-1", 7));
    try {
      await session.open();
      expect(api.sent).toEqual([]);
      expect(session.getSnapshot().phase).toBe("conflict");
      const stored = await store.read(ARM, "char-1");
      expect(stored.confirmed?.revision).toBe(7);
      expect(stored.entries[0]?.attempt).toBeNull();
    } finally { session.dispose(); await store.close(); }
  });

  it("serializes requestEditing with the frozen replay during open, then checks GET before unsent work", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    const request: FrozenRequest = { method: "POST", path: "/characters/char-1/fields/name/set", body: { value: "Briar", expectedRevision: 1, idempotencyKey: "old" }, firstAttemptAt: EVER };
    await seedQueue(store, "char-1", [
      { id: "frozen", intent: { kind: "setField", fieldId: "name", value: "Briar" }, request },
      { id: "unsent", intent: { kind: "setField", fieldId: "gold", value: 10 } },
    ]);
    const d = deferredEnvelope();
    api.setSendFallback(async () => d.promise);
    const get = vi.spyOn(api, "open");
    api.scriptOpenView(viewFor("char-1", 7));
    const opening = session.open();
    await vi.waitFor(() => expect(api.sent.length).toBeGreaterThan(0));
    await session.requestEditing();
    expect(api.sent).toEqual([request]);
    expect(get).not.toHaveBeenCalled();
    d.release(viewFor("char-1", 2));
    await opening;
    expect(api.sent).toHaveLength(1);
    expect(session.getSnapshot().confirmed?.revision).toBe(7);
    expect(session.getSnapshot().phase).toBe("conflict");
    session.dispose();
    await store.close();
  });

  it.each([
    [401, "unauthorized", undefined, "reauthenticate"],
    [404, "not_found", "purge", "purged"],
    [0, "network", undefined, "network-unavailable"],
  ] as const)("preserves conflict GET failure %s rather than claiming a refreshed base", async (status, code, cacheDisposition, kind) => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenError(status === 0 ? new TypeError("offline") : new ApiError({ status, code, cacheDisposition: cacheDisposition ?? null, message: "Failed", requestId: "r", latestRevision: null, diagnostics: [] }));
    await session.setField("name", "Briar");
    await session.whenIdle();
    expect(session.getSnapshot().error?.kind).toBe(kind);
    expect(session.getSnapshot().confirmed?.revision).toBe(kind === "purged" ? undefined : 1);
    await expect(session.resolveConflict({ mode: "reapply", selectedIds: session.getSnapshot().entries.map(e => e.id) })).rejects.toThrow();
    expect(api.sent).toHaveLength(1);
    if (kind === "purged") expect((await store.read(ARM, "char-1")).entries).toEqual([]);
    session.dispose();
    await store.close();
  });

  it("stops idempotency_mismatch as protocol before generic 409 recovery", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    const get = vi.spyOn(api, "open");
    api.scriptSend(async () => ({ error: new ApiError({ status: 409, code: "idempotency_mismatch", message: "Mismatch", requestId: "r", latestRevision: null, diagnostics: [] }) }));
    await session.setField("name", "Briar");
    await session.whenIdle();
    expect(session.getSnapshot().error?.kind).toBe("protocol");
    expect(get).not.toHaveBeenCalled();
    await expect(session.resolveConflict({ mode: "reapply", selectedIds: session.getSnapshot().entries.map(e => e.id) })).rejects.toThrow();
    expect(api.sent).toHaveLength(1);
    session.dispose();
    await store.close();
  });

  it("never starts a second send while one is in flight", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();

    const d = deferredEnvelope();
    api.setSendFallback(async () => d.promise);
    const first = session.setField("health", 13).catch(() => {});
    const second = session.setField("gold", 10).catch(() => {});
    await new Promise((r) => setTimeout(r, 5));

    expect(api.sent).toHaveLength(1);
    d.release(viewFor("char-1", 2));
    await session.whenIdle();
    expect(api.sent.length).toBeGreaterThanOrEqual(2);
    await first;
    await second;
    await store.close();
  });
});

describe("CharacterSession online operations", () => {
  it("archives through PATCH with the confirmed revision and a fresh key", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    api.setSendFallback(async (req) => successEnvelope(viewFor("char-1", 4, { lifecycle: "archived" })));
    await session.archive();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.method).toBe("PATCH");
    expect(api.sent[0]?.path).toBe("/characters/char-1");
    expect(api.sent[0]?.body).toMatchObject({ command: "archive", expectedRevision: 3 });
    expect(typeof api.sent[0]?.body.idempotencyKey).toBe("string");
    expect(session.getSnapshot().confirmed?.lifecycle).toBe("archived");
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(0);
    session.dispose();
    await store.close();
  });

  it("recovers an archived character through PATCH", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 4, { lifecycle: "archived" }));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 4, { lifecycle: "archived" }), requestId: "req-open" }));
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 5, { lifecycle: "active" })));
    await session.recover();
    expect(api.sent[0]?.body).toMatchObject({ command: "recover", expectedRevision: 4 });
    expect(session.getSnapshot().confirmed?.lifecycle).toBe("active");
    session.dispose();
    await store.close();
  });

  it("replays the identical frozen archive body after an ambiguous outcome", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    api.scriptSend(async () => ({ error: new TypeError("network down") }));
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 4, { lifecycle: "archived" })));
    await expect(session.archive()).rejects.toThrow();
    const first = api.sent[0];
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(1);
    await session.archive();
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]?.body).toEqual(first?.body);
    expect(api.sent[1]?.path).toBe(first?.path);
    session.dispose();
    await store.close();
  });

  it("refuses online-only lifecycle work while edits are pending or offline", async () => {
    const { api, store, session, identity } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    await seedQueue(store, "char-1", [{ id: "pending", intent: { kind: "setField", fieldId: "name", value: "Briar" } }]);
    api.scriptOpenView(viewFor("char-1", 1));
    api.setSendFallback(async () => ({ error: new TypeError("offline") }));
    await session.open();
    const managementBefore = api.sent.filter((r) => r.method === "PATCH").length;
    await expect(session.archive()).rejects.toThrow();
    expect(api.sent.filter((r) => r.method === "PATCH")).toHaveLength(managementBefore);
    identity.online = false;
    identity.signal();
    await expect(session.recover()).rejects.toThrow();
    expect(api.sent.filter((r) => r.method === "PATCH")).toHaveLength(managementBefore);
    session.dispose();
    await store.close();
  });

  it("commits a migration through the preview commit command and clears the attempt", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    api.setSendFallback(async (req) => {
      expect(req.path).toBe("/characters/char-1/migrations/p-1/commit");
      return successEnvelope(viewFor("char-1", 4));
    });
    await session.commitMigration("p-1");
    expect(api.sent[0]?.body).toMatchObject({ expectedRevision: 3 });
    expect(typeof api.sent[0]?.body.idempotencyKey).toBe("string");
    expect(session.getSnapshot().confirmed?.revision).toBe(4);
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(0);
    session.dispose();
    await store.close();
  });

  it("replays an ambiguous migration commit verbatim", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    api.scriptSend(async () => ({ error: new TypeError("network down") }));
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 4)));
    await expect(session.commitMigration("p-1")).rejects.toThrow();
    await session.commitMigration("p-1");
    expect(api.sent).toHaveLength(2);
    expect(api.sent[1]?.body).toEqual(api.sent[0]?.body);
    session.dispose();
    await store.close();
  });

  it("surfaces rollback limits without retrying a fresh key", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 5));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 5), requestId: "req-open" }));
    api.scriptSend(async () => ({
      error: new ApiError({ status: 409, code: "conflict", message: "Rollback window expired.", requestId: "r", latestRevision: 5, diagnostics: [] }),
    }));
    await expect(session.rollbackMigration("m-1")).rejects.toThrow(/Rollback|expired|conflict/i);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.path).toBe("/characters/char-1/migrations/m-1/rollback");
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(0);
    session.dispose();
    await store.close();
  });

  it("reapplies selected intentions against the latest revision with fresh keys", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 7));
    await session.setField("name", "Briar");
    await session.whenIdle();
    const conflictedKey = (session.getSnapshot().entries[0]?.attempt?.body.idempotencyKey ?? api.sent[0]?.body.idempotencyKey) as string;
    const selectedIds = session.getSnapshot().entries.map((e) => e.id);
    await session.resolveConflict({ mode: "reapply", selectedIds });
    await session.whenIdle();
    expect(api.sent.length).toBeGreaterThanOrEqual(2);
    const reapplyRequest = api.sent[api.sent.length - 1]!;
    expect(reapplyRequest.body.expectedRevision).toBe(7);
    expect(reapplyRequest.body.idempotencyKey).not.toBe(conflictedKey);
    session.dispose();
    await store.close();
  });

  it("deletes an expired online attempt and mints a fresh key on the next attempt", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    await store.saveOnlineAttempt({
      id: "old-attempt",
      actorId: ARM,
      characterId: "char-1",
      kind: "archive",
      request: {
        method: "PATCH",
        path: "/characters/char-1",
        body: { command: "archive", expectedRevision: 3, idempotencyKey: "old-key" },
        firstAttemptAt: "2020-01-01T00:00:00.000Z",
      },
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    await expect(session.archive()).rejects.toThrow(/replay window/);
    expect(session.getSnapshot().error?.kind).toBe("expired-attempt");
    expect(api.sent).toHaveLength(0);
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(0);
    await session.resolveConflict({ mode: "discard", selectedIds: [] });
    await session.whenIdle();
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 4, { lifecycle: "archived" })));
    await session.archive();
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.body.idempotencyKey).not.toBe("old-key");
    expect(typeof api.sent[0]?.body.idempotencyKey).toBe("string");
    session.dispose();
    await store.close();
  });

  it("cleans superseded migration preview attempts when committing a newer preview", async () => {
    const { api, store, session } = await makeHarness();
    api.scriptOpenView(viewFor("char-1", 3));
    await session.open();
    api.setOpenFallback(async () => ({ character: viewFor("char-1", 3), requestId: "req-open" }));
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 4)));
    await store.saveOnlineAttempt({
      id: "stale-preview",
      actorId: ARM,
      characterId: "char-1",
      kind: "migration",
      request: {
        method: "POST",
        path: "/characters/char-1/migrations/p-1/commit",
        body: { expectedRevision: 3, idempotencyKey: "preview-old-key" },
        firstAttemptAt: EVER,
      },
      createdAt: EVER,
    });
    await session.commitMigration("p-2");
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]?.path).toBe("/characters/char-1/migrations/p-2/commit");
    expect(await store.readOnlineAttempts(ARM)).toHaveLength(0);
    session.dispose();
    await store.close();
  });
});

describe("CharacterSession selection-safe conflict recovery", () => {
  async function twoOfflineEditsInConflict() {
    const harness = await makeHarness();
    const { api, store, session } = harness;
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    api.scriptSend(async () => ({ error: conflictError() }));
    api.scriptOpenView(viewFor("char-1", 7));
    const pending1 = session.setField("name", "Briar").catch(() => {});
    const pending2 = session.setField("gold", 10).catch(() => {});
    await session.whenIdle();
    expect(session.getSnapshot().phase).toBe("conflict");
    const ids = session.getSnapshot().entries.map((e) => e.id);
    expect(ids).toHaveLength(2);
    return { ...harness, ids, pending1, pending2, sentBefore: api.sent.length };
  }

  it("partial discard keeps the unselected entry paused without rebasing it, across reopen", async () => {
    const first = await twoOfflineEditsInConflict();
    await first.session.resolveConflict({ mode: "discard", selectedIds: [first.ids[0]!] });
    await first.session.whenIdle();
    expect(first.api.sent).toHaveLength(first.sentBefore);
    expect(first.session.getSnapshot().phase).toBe("conflict");
    const remaining = first.session.getSnapshot().entries;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ baseRevision: 1, packageChecksum: "abc", attempt: null });
    const stored = await first.store.read(ARM, "char-1");
    expect(stored.confirmed?.revision).toBe(7);
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]).toMatchObject({ baseRevision: 1, packageChecksum: "abc", attempt: null });
    first.session.dispose();
    await first.store.close();
    await first.pending1;
    first.pending2.catch(() => {});

    const second = await makeHarness();
    second.api.scriptOpenView(viewFor("char-1", 7));
    second.api.setSendFallback(async () => successEnvelope(viewFor("char-1", 8)));
    await second.session.open();
    await second.session.whenIdle();
    expect(second.api.sent).toEqual([]);
    expect(second.session.getSnapshot().phase).toBe("conflict");
    expect(second.session.getSnapshot().entries).toHaveLength(1);
    expect(second.session.getSnapshot().entries[0]).toMatchObject({ baseRevision: 1, attempt: null });
    second.session.dispose();
    await second.store.close();
  });

  it("partial reapply sends only the selected entry with a new key and keeps the second paused for its own review", async () => {
    const first = await twoOfflineEditsInConflict();
    first.api.scriptSend(async () => successEnvelope(viewFor("char-1", 8)));
    first.api.scriptSend(async () => successEnvelope(viewFor("char-1", 9)));
    await first.session.resolveConflict({ mode: "reapply", selectedIds: [first.ids[0]!] });
    await first.session.whenIdle();
    expect(first.api.sent).toHaveLength(first.sentBefore + 1);
    expect(first.api.sent[first.sentBefore]?.body).toMatchObject({ expectedRevision: 7, value: "Briar" });
    expect(first.api.sent[first.sentBefore]?.body.idempotencyKey).not.toBe(
      first.api.sent[0]?.body.idempotencyKey,
    );
    expect(first.session.getSnapshot().phase).toBe("conflict");
    const remaining = first.session.getSnapshot().entries;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ baseRevision: 1, packageChecksum: "abc", attempt: null });

    await first.session.resolveConflict({ mode: "reapply", selectedIds: [remaining[0]!.id] });
    await first.session.whenIdle();
    expect(first.api.sent).toHaveLength(first.sentBefore + 2);
    expect(first.api.sent[first.sentBefore + 1]?.body.expectedRevision).toBe(8);
    expect(first.session.getSnapshot().phase).toBe("ready");
    expect(first.session.getSnapshot().entries).toEqual([]);
    first.session.dispose();
    await first.store.close();
    await first.pending1;
    first.pending2.catch(() => {});
  });

  it("rejects resolving a later entry while an earlier predecessor is unresolved", async () => {
    const h = await twoOfflineEditsInConflict();
    await expect(
      h.session.resolveConflict({ mode: "discard", selectedIds: [h.ids[1]!] }),
    ).rejects.toThrow();
    await expect(
      h.session.resolveConflict({ mode: "reapply", selectedIds: [h.ids[1]!] }),
    ).rejects.toThrow();
    expect(h.api.sent).toHaveLength(h.sentBefore);
    expect(h.session.getSnapshot().phase).toBe("conflict");
    expect(h.session.getSnapshot().entries).toHaveLength(2);
    h.session.dispose();
    await h.store.close();
    h.pending1.catch(() => {});
    h.pending2.catch(() => {});
  });

  it("rejects empty, duplicate and nonexistent selections without clearing the pause", async () => {
    const h = await twoOfflineEditsInConflict();
    await expect(h.session.resolveConflict({ mode: "discard", selectedIds: [] })).rejects.toThrow();
    await expect(
      h.session.resolveConflict({ mode: "discard", selectedIds: [h.ids[0]!, h.ids[0]!] }),
    ).rejects.toThrow();
    await expect(
      h.session.resolveConflict({ mode: "reapply", selectedIds: ["no-such-entry"] }),
    ).rejects.toThrow();
    expect(h.api.sent).toHaveLength(h.sentBefore);
    expect(h.session.getSnapshot().phase).toBe("conflict");
    expect(h.session.getSnapshot().entries).toHaveLength(2);
    expect((await h.store.read(ARM, "char-1")).entries).toHaveLength(2);
    h.session.dispose();
    await h.store.close();
    h.pending1.catch(() => {});
    h.pending2.catch(() => {});
  });

  it("corrects an invalid entry atomically with a new key while preserving the dependent", async () => {
    const { api, store, session } = await makeHarness();
    await seedConfirmed(store, "char-1", viewFor("char-1", 1));
    api.scriptOpenView(viewFor("char-1", 1));
    await session.open();
    const invalid = new ApiError({
      code: "invalid_value",
      message: "Value is out of range.",
      status: 422,
      requestId: "req-1",
      latestRevision: 1,
      diagnostics: [],
    });
    api.scriptSend(async () => ({ error: invalid }));
    const pending1 = session.setField("health", 99).catch(() => {});
    const pending2 = session.setField("gold", 10).catch(() => {});
    await session.whenIdle();
    expect(session.getSnapshot().phase).toBe("invalid");
    const ids = session.getSnapshot().entries.map((e) => e.id);
    expect(ids).toHaveLength(2);
    const conflictedKey = api.sent[0]?.body.idempotencyKey;

    api.scriptSend(async () => successEnvelope(viewFor("char-1", 2)));
    api.setSendFallback(async () => successEnvelope(viewFor("char-1", 3)));
    await session.resolveConflict({
      mode: "reapply",
      selectedIds: [ids[0]!],
      correctedIntents: { [ids[0]!]: { kind: "setField", fieldId: "health", value: 13 } },
    });
    await session.whenIdle();
    expect(api.sent[1]?.body).toMatchObject({ value: 13, expectedRevision: 1 });
    expect(api.sent[1]?.body.idempotencyKey).not.toBe(conflictedKey);
    expect(api.sent[2]?.body).toMatchObject({ value: 10, expectedRevision: 2 });
    expect(session.getSnapshot().phase).toBe("ready");
    expect(session.getSnapshot().entries).toEqual([]);
    expect((await store.read(ARM, "char-1")).entries).toEqual([]);
    session.dispose();
    await store.close();
    await pending1;
    await pending2;
  });

  it("rolls back the whole recovery when the atomic replacement write fails, with no new sends", async () => {
    const h = await twoOfflineEditsInConflict();
    const before = await h.store.read(ARM, "char-1");
    const realPut = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "queue") {
        this.transaction.abort();
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return realPut.apply(this, [value, key as IDBValidKey]);
    });
    await expect(
      h.session.resolveConflict({ mode: "reapply", selectedIds: [h.ids[0]!] }),
    ).rejects.toThrow();
    spy.mockRestore();
    expect(h.api.sent).toHaveLength(h.sentBefore);
    expect(h.session.getSnapshot().phase).toBe("conflict");
    expect(h.session.getSnapshot().entries.map((e) => e.id).sort()).toEqual(h.ids.slice().sort());
    h.session.dispose();
    await h.store.close();
    h.pending1.catch(() => {});
    h.pending2.catch(() => {});

    const reopened = await openCharacterStore(dbName);
    const after = await reopened.read(ARM, "char-1");
    expect(after.entries).toEqual(before.entries);
    expect(after.generation).toBe(before.generation);
    await reopened.close();
  });

  it("does not resurrect state when the account is cleared during review", async () => {
    const h = await twoOfflineEditsInConflict();
    await h.store.clearAccount(ARM);
    await expect(
      h.session.resolveConflict({ mode: "discard", selectedIds: [h.ids[0]!] }),
    ).rejects.toThrow(/stale/);
    expect((await h.store.read(ARM, "char-1")).entries).toEqual([]);
    expect(h.api.sent).toHaveLength(h.sentBefore);
    expect(h.session.getSnapshot().confirmed).toBeNull();
    h.session.dispose();
    await h.store.close();
    h.pending1.catch(() => {});
    h.pending2.catch(() => {});
  });
});
