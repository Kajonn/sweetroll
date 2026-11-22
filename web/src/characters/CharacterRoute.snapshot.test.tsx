import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import type { CharacterSession, CoordinationEvent, CoordinationPort, IdentityPort } from "./session.js";
import { makeOpenEnvelope, makeView } from "./testing.js";
import { CharacterDetail } from "./CharacterRoute.js";

// Records the sessions the route creates so the test can read their snapshots.
const created = vi.hoisted(() => ({ sessions: [] as CharacterSession[] }));
vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.js")>();
  return {
    ...actual,
    createCharacterSession: (input: Parameters<typeof actual.createCharacterSession>[0]) => {
      const session = actual.createCharacterSession(input);
      created.sessions.push(session);
      return session;
    },
  };
});

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000c3";

function view() {
  return makeView({ characterId: CHARACTER_ID, revision: 1, name: "Briar" });
}

function makeIdentity(): IdentityPort {
  return { getActorId: () => ACTOR, getGeneration: () => 0, isOnline: () => true, isCurrent: async () => true, subscribe: () => () => {} };
}

function makeCoordination(owned: boolean) {
  const listeners = new Set<(event: CoordinationEvent) => void>();
  const coordination: CoordinationPort = {
    isOwner: () => owned,
    requestEditing: async () => owned,
    letGo: () => {},
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setQuiesce: () => {},
    invalidate: () => {},
    dispose: () => {},
    requestTakeover: async () => owned,
  };
  return { coordination, broadcast: (event: CoordinationEvent) => { for (const l of [...listeners]) l(event); } };
}

function makeApi(): CharactersApi {
  return {
    open: vi.fn(async () => makeOpenEnvelope(view())),
    creationOptions: vi.fn(),
    listCreationVersions: vi.fn(async () => ({ data: { versions: [], nextCursor: null }, requestId: "r" })),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
  } as unknown as CharactersApi;
}

type Case = {
  name: string;
  lock: "held" | "other-tab" | "no-lock-api";
  storage: "available" | "unavailable";
  seeded: boolean;
  expected: { source: "stored" | "live"; storage: "available" | "unavailable"; owned: boolean; blockedBy: undefined | "storage" | "locks" | "other-tab" };
};

const cases: Case[] = [
  { name: "storage available, lock held", lock: "held", storage: "available", seeded: false,
    expected: { source: "stored", storage: "available", owned: true, blockedBy: undefined } },
  { name: "storage available, lock held by another tab", lock: "other-tab", storage: "available", seeded: true,
    expected: { source: "stored", storage: "available", owned: false, blockedBy: "other-tab" } },
  { name: "storage available, no Lock API", lock: "no-lock-api", storage: "available", seeded: false,
    expected: { source: "live", storage: "available", owned: false, blockedBy: "locks" } },
  { name: "storage unavailable, lock held", lock: "held", storage: "unavailable", seeded: false,
    expected: { source: "live", storage: "unavailable", owned: false, blockedBy: "storage" } },
  { name: "storage unavailable, lock held by another tab", lock: "other-tab", storage: "unavailable", seeded: true,
    expected: { source: "stored", storage: "unavailable", owned: false, blockedBy: "storage" } },
  { name: "storage unavailable, no Lock API", lock: "no-lock-api", storage: "unavailable", seeded: true,
    expected: { source: "stored", storage: "unavailable", owned: false, blockedBy: "storage" } },
];

describe("CharacterRoute session snapshot", () => {
  afterEach(() => {
    created.sessions.length = 0;
    vi.restoreAllMocks();
  });

  it.each(cases)("reports view, storage and editing for $name", async ({ lock, storage, seeded, expected }) => {
    const store: CharacterStore = await openCharacterStore(`route-snapshot-${crypto.randomUUID()}`);
    if (seeded) await store.confirmSnapshot(ACTOR, CHARACTER_ID, view(), 0);
    if (storage === "unavailable" && lock === "held") {
      vi.spyOn(store, "confirmSnapshot").mockRejectedValue(new DOMException("Write failed", "QuotaExceededError"));
    }
    const { coordination, broadcast } = makeCoordination(lock === "held");
    const ui = render(<CharacterDetail characterId={CHARACTER_ID} api={makeApi()} store={store}
      identity={makeIdentity()} coordination={coordination} locksSupported={lock !== "no-lock-api"} />);
    try {
      expect(await screen.findByRole("heading", { name: "Briar" }, { timeout: 3000 })).toBeVisible();
      if (storage === "unavailable" && lock !== "held") {
        // A tab without the lock learns that storage failed when it rereads the store.
        vi.spyOn(store, "read").mockRejectedValue(new DOMException("Read failed", "UnknownError"));
        act(() => { broadcast({ type: "invalidate", characterId: CHARACTER_ID }); });
      }
      const session = created.sessions.at(-1)!;
      await waitFor(() => {
        const snapshot = session.getSnapshot();
        expect(snapshot.view?.source).toBe(expected.source);
        expect(snapshot.view?.character.name).toBe("Briar");
        expect(snapshot.storage).toBe(expected.storage);
        expect(snapshot.editing.owned).toBe(expected.owned);
        expect(snapshot.editing.blockedBy).toBe(expected.blockedBy);
      }, { timeout: 3000 });
      expect(session.getSnapshot()).not.toHaveProperty("confirmed");
      expect(session.getSnapshot()).not.toHaveProperty("onlineOnly");
    } finally { ui.unmount(); await store.close(); }
  });
});
