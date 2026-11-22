import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
import type { CoordinationEvent, CoordinationPort, IdentityPort } from "./session.js";
import { makeOpenEnvelope, makeView } from "./testing.js";
import { CharacterDetail } from "./CharacterRoute.js";

// S4: the read-only status names the reason, and "unavailable" is kept for a
// character that is not found or whose access was revoked.
const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000c3";

const STORAGE = "Can't save this character in this browser, so it is read-only.";
const LOCKS = "Read-only in this browser.";
const OTHER_TAB = "Read-only in this tab. Another tab is editing this character.";
const UNAVAILABLE = "This character is unavailable.";

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

function makeApi(): CharactersApi & { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  return {
    open: vi.fn(async () => makeOpenEnvelope(view())),
    creationOptions: vi.fn(),
    listCreationVersions: vi.fn(async () => ({ data: { versions: [], nextCursor: null }, requestId: "r" })),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
  } as unknown as CharactersApi & { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

function purged() {
  return new ApiError({ status: 404, code: "not_found", message: "Not found",
    cacheDisposition: "purge", requestId: "r", latestRevision: null, diagnostics: [] });
}

type Case = {
  name: string;
  lock: "held" | "other-tab" | "no-lock-api";
  storage: "available" | "unavailable";
  seeded: boolean;
  message: string;
};

const cases: Case[] = [
  { name: "a snapshot write failure with the lock held", lock: "held", storage: "unavailable", seeded: false, message: STORAGE },
  { name: "a failed store read in a tab without the lock", lock: "other-tab", storage: "unavailable", seeded: true, message: STORAGE },
  { name: "a failed store read without a Lock API", lock: "no-lock-api", storage: "unavailable", seeded: true, message: STORAGE },
  { name: "no Lock API", lock: "no-lock-api", storage: "available", seeded: false, message: LOCKS },
  { name: "another tab holding the lock", lock: "other-tab", storage: "available", seeded: true, message: OTHER_TAB },
];

describe("CharacterRoute read-only messages", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(cases)("names the reason after $name", async ({ lock, storage, seeded, message }) => {
    const store: CharacterStore = await openCharacterStore(`route-messages-${crypto.randomUUID()}`);
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
        vi.spyOn(store, "read").mockRejectedValue(new DOMException("Read failed", "UnknownError"));
        act(() => { broadcast({ type: "invalidate", characterId: CHARACTER_ID }); });
      }
      expect(await screen.findByText(message, {}, { timeout: 3000 })).toBeVisible();
      for (const other of [STORAGE, LOCKS, OTHER_TAB, UNAVAILABLE].filter(text => text !== message)) {
        expect(screen.queryByText(other)).not.toBeInTheDocument();
      }
      expect(screen.queryByText("Editing in this tab.")).not.toBeInTheDocument();
    } finally { ui.unmount(); await store.close(); }
  });

  it("offers to try saving again after a storage failure and edits once saving works", async () => {
    const store: CharacterStore = await openCharacterStore(`route-messages-${crypto.randomUUID()}`);
    const write = vi.spyOn(store, "confirmSnapshot").mockRejectedValue(new DOMException("Write failed", "QuotaExceededError"));
    const { coordination } = makeCoordination(true);
    const ui = render(<CharacterDetail characterId={CHARACTER_ID} api={makeApi()} store={store}
      identity={makeIdentity()} coordination={coordination} locksSupported />);
    try {
      expect(await screen.findByText(STORAGE, {}, { timeout: 3000 })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Request editing access" })).not.toBeInTheDocument();
      write.mockRestore();
      await userEvent.click(screen.getByRole("button", { name: "Try saving again" }));
      expect(await screen.findByText("Editing in this tab.", {}, { timeout: 3000 })).toBeVisible();
      expect(screen.queryByText(STORAGE)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Try saving again" })).not.toBeInTheDocument();
      await waitFor(async () => expect((await store.read(ACTOR, CHARACTER_ID)).confirmed?.name).toBe("Briar"));
    } finally { ui.unmount(); await store.close(); }
  });

  it("offers no retry when storage fails in a browser without a Lock API", async () => {
    const store: CharacterStore = await openCharacterStore(`route-messages-${crypto.randomUUID()}`);
    await store.confirmSnapshot(ACTOR, CHARACTER_ID, view(), 0);
    const { coordination, broadcast } = makeCoordination(false);
    const ui = render(<CharacterDetail characterId={CHARACTER_ID} api={makeApi()} store={store}
      identity={makeIdentity()} coordination={coordination} locksSupported={false} />);
    try {
      expect(await screen.findByRole("heading", { name: "Briar" }, { timeout: 3000 })).toBeVisible();
      vi.spyOn(store, "read").mockRejectedValue(new DOMException("Read failed", "UnknownError"));
      act(() => { broadcast({ type: "invalidate", characterId: CHARACTER_ID }); });
      expect(await screen.findByText(STORAGE, {}, { timeout: 3000 })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Try saving again" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Request editing access" })).not.toBeInTheDocument();
    } finally { ui.unmount(); await store.close(); }
  });

  it("shows unavailable, not a storage message, for a character that is not found or revoked", async () => {
    const store: CharacterStore = await openCharacterStore(`route-messages-${crypto.randomUUID()}`);
    vi.spyOn(store, "confirmSnapshot").mockRejectedValue(new DOMException("Write failed", "QuotaExceededError"));
    const api = makeApi();
    api.open.mockRejectedValue(purged());
    const { coordination } = makeCoordination(true);
    const ui = render(<CharacterDetail characterId={CHARACTER_ID} api={api} store={store}
      identity={makeIdentity()} coordination={coordination} locksSupported />);
    try {
      expect(await screen.findByText(UNAVAILABLE, {}, { timeout: 3000 })).toBeVisible();
      for (const other of [STORAGE, LOCKS, OTHER_TAB]) expect(screen.queryByText(other)).not.toBeInTheDocument();
    } finally { ui.unmount(); await store.close(); }
  });

  it.each([
    { name: "a storage failure", lock: "held" as const },
    { name: "no Lock API", lock: "no-lock-api" as const },
  ])("shows unavailable when access to an open online sheet is revoked after $name", async ({ lock }) => {
    const store: CharacterStore = await openCharacterStore(`route-messages-${crypto.randomUUID()}`);
    if (lock === "held") vi.spyOn(store, "confirmSnapshot").mockRejectedValue(new DOMException("Write failed", "QuotaExceededError"));
    const api = makeApi();
    const { coordination } = makeCoordination(lock === "held");
    const ui = render(<CharacterDetail characterId={CHARACTER_ID} api={api} store={store}
      identity={makeIdentity()} coordination={coordination} locksSupported={lock === "held"} />);
    try {
      expect(await screen.findByText(lock === "held" ? STORAGE : LOCKS, {}, { timeout: 3000 })).toBeVisible();
      api.open.mockRejectedValue(purged());
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(await screen.findByText(UNAVAILABLE, {}, { timeout: 3000 })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Briar" })).not.toBeInTheDocument();
      for (const other of [STORAGE, LOCKS, OTHER_TAB]) expect(screen.queryByText(other)).not.toBeInTheDocument();
      expect(api.send).not.toHaveBeenCalled();
    } finally { ui.unmount(); await store.close(); }
  });
});
