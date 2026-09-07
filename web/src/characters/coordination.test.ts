import { expect, it, vi } from "vitest";
import { createCoordination } from "./coordination.js";
import { createCharacterSession } from "./session.js";
import { createIdentityGate, type BrowserChannel } from "./identity.js";
import { createCharactersApi } from "./api.js";
import { createApiClient } from "../api/client.js";
import { openCharacterStore } from "./store.js";
import { createTestLocks, makeEntry, makeEnvelope, makeOpenEnvelope, makeRequest, makeView } from "./testing.js";

it("cancels takeover behind an initial acquisition without posting to a disposed channel", async () => {
  let closed = false;
  const tab = createCoordination({ actorId: "a", characterId: "c", locks: createTestLocks(), channel: {
    onmessage: null, close() { closed = true; }, postMessage() { if (closed) throw new Error("closed channel"); },
  } });
  const initial = tab.acquire();
  const takeover = tab.requestTakeover();
  tab.dispose();
  await initial;
  await expect(takeover).resolves.toBe(false);
});

it("queued takeover survives owner disappearance and cancels when the requester is disposed", async () => {
  const locks = createTestLocks();
  const tab = () => createCoordination({ actorId: "a", characterId: "c", locks, channel: null });
  const owner = tab(); const next = tab();
  await owner.acquire();
  const takeover = next.requestTakeover();
  owner.dispose();
  expect(await takeover).toBe(true);
  const cancelled = tab();
  const pending = cancelled.requestTakeover();
  cancelled.dispose();
  expect(await pending).toBe(false);
  next.dispose();
  await vi.waitFor(async () => {
    const last = tab();
    expect(await last.acquire()).toBe(true);
    last.dispose();
  });
});

function browser() {
  const peers = new Set<BrowserChannel>();
  return {
    locks: createTestLocks(),
    channel() {
      const channel: BrowserChannel = {
        onmessage: null,
        postMessage(data) { for (const peer of peers) if (peer !== channel) queueMicrotask(() => peer.onmessage?.({ data } as MessageEvent)); },
        close() { peers.delete(channel); },
      };
      peers.add(channel);
      return channel;
    },
  };
}

it("real sessions never send without a lock and takeover waits for the active receipt before reloading", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  const scheduler = browser();
  const view = makeView({ characterId: "c", revision: 1 });
  await store.confirmSnapshot("a", "c", view, 0);
  let online = false;
  await store.setLastAccount("a");
  const identity = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: "a" }) as never }, online: () => online, channel: null });
  await identity.refresh();
  let finish!: (response: Response) => void;
  const send = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const api = createCharactersApi(createApiClient({ baseUrl: "http://api", fetch: async (_url, init) =>
    init?.method === "POST" ? send() : new Response(JSON.stringify(makeOpenEnvelope(view))) }));
  const coordination = () => createCoordination({ actorId: "a", characterId: "c", locks: scheduler.locks, channel: scheduler.channel() });
  const first = coordination(); const second = coordination();
  const session = (coord: ReturnType<typeof coordination>) => createCharacterSession({ actorId: "a", characterId: "c", store, api, identity, coordination: coord, now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID() });
  const owner = session(first); const reader = session(second);
  await owner.open(); await reader.open();
  expect(reader.getSnapshot().editing.owned).toBe(false);
  await expect(reader.setField("name", "forbidden")).rejects.toThrow(/lock/i);
  await owner.setField("name", "Briar");
  await vi.waitFor(() => expect(reader.getSnapshot().entries).toHaveLength(1));
  expect(send).not.toHaveBeenCalled();
  online = true; await identity.refresh();
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const takeover = reader.requestEditing();
  await vi.waitFor(() => expect(owner.getSnapshot().editing.owned).toBe(false));
  expect(reader.getSnapshot().editing.owned).toBe(false);
  const frozen = (await store.read("a", "c")).entries[0]!.attempt;
  expect(frozen).not.toBeNull();
  finish(new Response(JSON.stringify(makeEnvelope(view))));
  await takeover;
  await vi.waitFor(() => expect(reader.getSnapshot().editing.owned).toBe(true));
  expect(reader.getSnapshot().entries).toEqual([]);
  expect(send).toHaveBeenCalledOnce();
  await store.purgeCharacter("a", "c");
  first.invalidate();
  await vi.waitFor(() => expect(reader.getSnapshot().confirmed).toBeNull());
  await expect(reader.setField("name", "purged")).rejects.toThrow();
  owner.dispose(); reader.dispose(); identity.dispose(); await store.close();
});

it("an unsupported browser cannot drain a persisted attempt", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.confirmSnapshot("a", "c", makeView({ characterId: "c", revision: 1 }), 0);
  await store.enqueue(makeEntry({ actorId: "a", characterId: "c", attempt: makeRequest() }), await store.read("a", "c"));
  const send = vi.fn();
  const identity = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: "a" }) as never }, online: () => true, channel: null });
  await identity.refresh();
  const session = createCharacterSession({ actorId: "a", characterId: "c", store, api: { send } as never, identity,
    coordination: createCoordination({ actorId: "a", characterId: "c", locks: null, channel: null }), now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID() });
  await session.open(); await session.whenIdle();
  expect(send).not.toHaveBeenCalled();
  expect(session.getSnapshot().editing.owned).toBe(false);
  expect((await store.read("a", "c")).entries[0]!.attempt).toEqual(makeRequest());
  session.dispose(); identity.dispose(); await store.close();
});

it.each(["switch", "logout"])("real identity %s hides cached data and blocks active response writeback", async mode => {
  const store = await openCharacterStore(crypto.randomUUID());
  const scheduler = browser();
  let actor = "a";
  const identity = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: actor }) as never }, online: () => true, channel: null });
  await identity.refresh();
  const view = makeView({ characterId: "c", revision: 1 });
  let finish!: (response: Response) => void;
  const send = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  const api = createCharactersApi(createApiClient({ baseUrl: "http://api", fetch: async (_url, init) =>
    init?.method === "POST" ? send() : new Response(JSON.stringify(makeOpenEnvelope(view))) }));
  const session = createCharacterSession({ actorId: "a", characterId: "c", store, api, identity,
    coordination: createCoordination({ actorId: "a", characterId: "c", locks: scheduler.locks, channel: null }),
    now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID() });
  await session.open(); await session.setField("name", "Briar");
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  const before = await store.read("a", "c");
  if (mode === "switch") { actor = "b"; await identity.refresh(); } else await identity.signOut();
  expect(session.getSnapshot()).toMatchObject({ confirmed: null, tentative: null, entries: [], editing: { owned: false } });
  await expect(session.bumpResource("hp", "up")).rejects.toThrow();
  finish(new Response(JSON.stringify(makeEnvelope(makeView({ characterId: "c", revision: 2 })))));
  await session.whenIdle();
  expect(send).toHaveBeenCalledOnce();
  if (mode === "switch") expect(await store.read("a", "c")).toEqual({ ...before, accountGeneration: before.accountGeneration + 1 });
  else expect(await store.read("a", "c")).toMatchObject({ confirmed: null, entries: [] });
  session.dispose(); identity.dispose(); await store.close();
});

it("checks durable account identity before send even when the other tab's broadcast is delayed", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  const scheduler = browser();
  const gate = (actor: string) => createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: actor }) as never }, online: () => true, channel: null });
  const identity = gate("a"); await identity.refresh();
  const other = gate("b");
  const view = makeView({ characterId: "c", revision: 1 });
  const send = vi.fn(async () => new Response(JSON.stringify(makeEnvelope(view))));
  const api = createCharactersApi(createApiClient({ baseUrl: "http://api", fetch: async (_url, init) =>
    init?.method === "POST" ? send() : new Response(JSON.stringify(makeOpenEnvelope(view))) }));
  const session = createCharacterSession({ actorId: "a", characterId: "c", store, api, identity,
    coordination: createCoordination({ actorId: "a", characterId: "c", locks: scheduler.locks, channel: null }),
    now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID() });
  await session.open();
  const freeze = store.freeze.bind(store);
  vi.spyOn(store, "freeze").mockImplementation(async (...args) => { await freeze(...args); await other.refresh(); });
  await session.setField("name", "Briar"); await session.whenIdle();
  expect(send).not.toHaveBeenCalled();
  expect(session.getSnapshot().confirmed).toBeNull();
  expect((await store.read("a", "c")).entries[0]?.attempt).not.toBeNull();
  session.dispose(); identity.dispose(); other.dispose(); await store.close();
});

it("release cancels an acquisition whose browser callback has not run yet", async () => {
  let grant!: () => Promise<void>;
  const locks = { request: (_name: string, _options: LockOptions, callback: (lock: unknown) => Promise<void>) =>
    new Promise<void>(resolve => { grant = async () => { await callback({ name: "lock" }); resolve(); }; }) } as LockManager;
  const tab = createCoordination({ actorId: "a", characterId: "c", locks, channel: null });
  const acquiring = tab.acquire();
  const releasing = tab.release();
  void grant();
  expect(await acquiring).toBe(false);
  await releasing;
  expect(tab.isOwner()).toBe(false);
  tab.dispose();
});

it("takeover flushes an active conflict recovery before releasing the lock", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  const scheduler = browser();
  await store.confirmSnapshot("a", "c", makeView({ characterId: "c", revision: 1 }), 0);
  await store.enqueue(makeEntry({ actorId: "a", characterId: "c" }), await store.read("a", "c"));
  const identity = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: "a" }) as never }, online: () => true, channel: null });
  await identity.refresh();
  const owner = createCoordination({ actorId: "a", characterId: "c", locks: scheduler.locks, channel: null });
  const second = createCoordination({ actorId: "a", characterId: "c", locks: scheduler.locks, channel: null });
  const api = createCharactersApi(createApiClient({ baseUrl: "http://api", fetch: async () => new Response(JSON.stringify(makeOpenEnvelope(makeView({ characterId: "c", revision: 2 })))) }));
  const session = createCharacterSession({ actorId: "a", characterId: "c", store, api, identity, coordination: owner, now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID() });
  await session.open();
  expect(session.getSnapshot().phase).toBe("conflict");
  let finish!: () => void;
  // Recovery commits through the atomic resolveEntries transaction (Task 2);
  // hold that commit to prove takeover quiesces an in-flight recovery.
  const resolve = store.resolveEntries.bind(store);
  vi.spyOn(store, "resolveEntries").mockImplementation(async (...args) => {
    await resolve(...args);
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const recovery = session.resolveConflict({ mode: "reapply", selectedIds: ["entry-1"] });
  await vi.waitFor(() => expect(finish).toBeDefined());
  const release = owner.release();
  // Let the browser's release promise/microtasks settle, but not the held store operation.
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(await second.acquire()).toBe(false);
  finish(); await recovery; await release;
  expect(await second.acquire()).toBe(true);
  expect((await store.read("a", "c")).entries[0]?.baseRevision).toBe(2);
  session.dispose(); second.dispose(); identity.dispose(); await store.close();
});

it("holds the browser lock until quiescence, never steals, and closes its channel", async () => {
  let finish!: () => void;
  let held = false;
  const locks = { request: vi.fn(async (_name, _options, callback) => {
    if (held) return callback(null);
    held = true;
    await callback({ name: "lock" });
    held = false;
  }) } as unknown as LockManager;
  const channel = { onmessage: null, postMessage: vi.fn(), close: vi.fn() };
  const owner = createCoordination({ actorId: "a", characterId: "c", locks, channel });
  owner.setQuiesce(() => new Promise<void>(resolve => { finish = resolve; }));
  expect(await owner.acquire()).toBe(true);
  const second = createCoordination({ actorId: "a", characterId: "c", locks, channel: null });
  expect(await second.acquire()).toBe(false);
  const releasing = owner.release();
  expect(owner.isOwner()).toBe(false);
  expect(held).toBe(true);
  finish(); await releasing;
  await vi.waitFor(() => expect(held).toBe(false));
  expect(await second.acquire()).toBe(true);
  owner.dispose(); second.dispose();
  expect(channel.close).toHaveBeenCalledOnce();
});

it("stays read-only without Web Locks", async () => {
  const tab = createCoordination({ actorId: "a", characterId: "c", locks: null, channel: null });
  expect(await tab.requestEditing()).toBe(false);
  expect(tab.isOwner()).toBe(false);
  tab.dispose();
});
