import { expect, it, vi } from "vitest";
import { createIdentityGate } from "./identity.js";
import { openCharacterStore } from "./store.js";
import { makeView } from "./testing.js";

it("confirms real IDs, uses only confirmed offline identity, and revokes before future me", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  let online = true;
  const calls: string[] = [];
  const client = { fetch: vi.fn(async (_method: string, path: string) => {
    calls.push(path);
    return { state: "authenticated", userId: "real-A" } as never;
  }) };
  const gate = createIdentityGate({ store, client, online: () => online, channel: null });
  expect(gate.getSnapshot().actorId).toBeNull();
  await gate.refresh();
  expect(gate.getSnapshot()).toMatchObject({ actorId: "real-A", verified: true });
  await store.confirmSnapshot("real-A", "c", makeView({ characterId: "c", revision: 1 }), 0);
  online = false;
  const offline = createIdentityGate({ store, client, online: () => online, channel: null });
  await offline.refresh();
  expect(offline.getSnapshot()).toMatchObject({ actorId: "real-A", verified: false });
  const signingOut = offline.signOut();
  expect(offline.getSnapshot()).toMatchObject({ actorId: null, pendingLogout: true });
  await signingOut;
  expect((await store.read("real-A", "c")).confirmed).toBeNull();
  expect(await store.readLastAccount()).toBeNull();
  online = true;
  await offline.refresh();
  expect(calls).toEqual(["/me", "/signout", "/me"]);
  gate.dispose(); offline.dispose(); await store.close();
});

it("does not reveal the last account after an online fetch failure", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.setLastAccount("private");
  const gate = createIdentityGate({ store, client: { fetch: async () => { throw Error("network"); } }, online: () => true, channel: null });
  await gate.refresh();
  expect(gate.getSnapshot()).toMatchObject({ actorId: null, verified: false });
  gate.dispose(); await store.close();
});

it("clears locally without waiting for an already hanging me and ignores its late identity", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.setLastAccount("a");
  await store.confirmSnapshot("a", "c", makeView({ characterId: "c", revision: 1 }), 0);
  let finish!: (value: never) => void;
  const client = { fetch: vi.fn((_method: string, path: string) => path === "/me"
    ? new Promise<never>(resolve => { finish = resolve; }) : Promise.resolve(undefined as never)) };
  const gate = createIdentityGate({ store, client, online: () => true, channel: null });
  const refreshing = gate.refresh();
  await vi.waitFor(() => expect(client.fetch).toHaveBeenCalledOnce());
  const logout = gate.signOut();
  await vi.waitFor(async () => expect((await store.read("a", "c")).confirmed).toBeNull());
  finish({ state: "authenticated", userId: "a" } as never);
  await refreshing; await logout;
  expect(gate.getSnapshot().actorId).toBeNull();
  expect(await store.readLastAccount()).toBeNull();
  gate.dispose(); await store.close();
});

it("broadcast invalidations do not echo indefinitely and signout hides other tabs", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  const peers: Array<import("./identity.js").BrowserChannel> = [];
  let broadcasts = 0;
  function channel() {
    const peer: import("./identity.js").BrowserChannel = {
      onmessage: null, close() {},
      postMessage(data) {
        if (++broadcasts > 10) return;
        for (const other of peers) if (other !== peer) queueMicrotask(() => other.onmessage?.({ data } as MessageEvent));
      },
    };
    peers.push(peer); return peer;
  }
  const client = { fetch: vi.fn(async () => ({ state: "authenticated", userId: "a" }) as never) };
  const first = createIdentityGate({ store, client, online: () => true, channel: channel() });
  const second = createIdentityGate({ store, client, online: () => true, channel: channel() });
  await first.refresh();
  await vi.waitFor(() => expect(second.getSnapshot().verified).toBe(true));
  await first.refresh(); await second.refresh();
  expect(broadcasts).toBeLessThan(5);
  await first.signOut();
  expect(second.getSnapshot()).toMatchObject({ actorId: null, verified: false });
  first.dispose(); second.dispose(); await store.close();
});

it("opening another tab for the same confirmed account does not invalidate its editor", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.setLastAccount("a");
  const postMessage = vi.fn();
  const gate = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: "a" }) as never }, online: () => true,
    channel: { onmessage: null, close() {}, postMessage } });
  await gate.refresh();
  expect(gate.getSnapshot().verified).toBe(true);
  expect(postMessage).not.toHaveBeenCalled();
  gate.dispose(); await store.close();
});

it("a late me cannot overwrite a newer account confirmation from another tab", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.setLastAccount("a");
  let finish!: (value: never) => void;
  const client = { fetch: vi.fn(() => new Promise<never>(resolve => { finish = resolve; })) };
  const first = createIdentityGate({ store, client, online: () => true, channel: null });
  const refreshing = first.refresh();
  await vi.waitFor(() => expect(client.fetch).toHaveBeenCalledOnce());
  const second = createIdentityGate({ store, client: { fetch: async () => ({ state: "authenticated", userId: "b" }) as never }, online: () => true, channel: null });
  await second.refresh();
  finish({ state: "authenticated", userId: "a" } as never);
  await refreshing;
  expect(await store.readLastAccount()).toBe("b");
  expect(first.getSnapshot()).toMatchObject({ actorId: null, verified: false });
  first.dispose(); second.dispose(); await store.close();
});

it("does not start me after signout invalidates an awaited marker read", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.setLastAccount("a");
  let finish!: (actor: string) => void;
  vi.spyOn(store, "readLastAccount").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const client = { fetch: vi.fn(async () => ({ state: "anonymous" }) as never) };
  const gate = createIdentityGate({ store, client, online: () => true, channel: null });
  const refresh = gate.refresh();
  await vi.waitFor(() => expect(finish).toBeDefined());
  const logout = gate.signOut();
  finish("a"); await refresh; await logout;
  expect(client.fetch.mock.calls).toEqual([["POST", "/signout"]]);
  gate.dispose(); await store.close();
});

it("reports local logout persistence failure without waiting for a hanging me", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  let finish!: (value: never) => void;
  const client = { fetch: vi.fn(() => new Promise<never>(resolve => { finish = resolve; })) };
  const gate = createIdentityGate({ store, client, online: () => true, channel: null });
  const refresh = gate.refresh();
  await vi.waitFor(() => expect(finish).toBeDefined());
  vi.spyOn(store, "setPendingLogout").mockRejectedValue(new Error("quota"));
  let error: unknown = null;
  const logout = gate.signOut().catch(failure => { error = failure; });
  await vi.waitFor(() => expect(error).toBeInstanceOf(Error));
  finish({ state: "anonymous" } as never); await refresh; await logout;
  expect(gate.getSnapshot().actorId).toBeNull();
  gate.dispose(); await store.close();
});
