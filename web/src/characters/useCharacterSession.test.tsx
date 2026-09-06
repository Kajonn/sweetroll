import { StrictMode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCharacterSession } from "./useCharacterSession.js";
import { createCharacterSession } from "./session.js";
import { openCharacterStore } from "./store.js";
import { createCoordination } from "./coordination.js";
import { makeView } from "./testing.js";
import type { CharactersApi } from "./api.js";

it("binds stable snapshots and disposes subscriptions/channels on navigation including StrictMode", async () => {
  const store = await openCharacterStore(crypto.randomUUID());
  await store.confirmSnapshot("a", "c", makeView({ characterId: "c", revision: 1 }), 0);
  const close = vi.fn();
  const listeners = new Set<() => void>();
  const factory = () => createCharacterSession({
    actorId: "a", characterId: "c", store, api: {} as CharactersApi,
    identity: { getActorId: () => "a", getGeneration: () => 0, isOnline: () => false, isCurrent: async () => true,
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    coordination: createCoordination({ actorId: "a", characterId: "c", locks: null,
      channel: { onmessage: null, postMessage() {}, close } }),
    now: () => "2026-09-06T00:00:00Z", newId: () => crypto.randomUUID(),
  });
  const { result, unmount } = renderHook(() => useCharacterSession(factory), { wrapper: StrictMode });
  await waitFor(() => expect(result.current.snapshot.confirmed?.name).toBe("Aria"));
  expect(result.current.snapshot.editing.owned).toBe(false);
  unmount();
  expect(listeners.size).toBe(0);
  expect(close).toHaveBeenCalledTimes(2);
  await store.close();
});
