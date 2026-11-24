import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerLocale, resetLocale } from "../i18n/index.js";
import { SessionBoard } from "../campaigns/SessionBoard.js";
import type { CharactersApi } from "./api.js";
import type { CharacterSession, CharacterSnapshot, CoordinationPort, IdentityPort } from "./session.js";
import type { CharacterStore } from "./store.js";
import { makeView } from "./testing.js";
import { CharacterDetail } from "./CharacterRoute.js";

// V3 guard: the session reports error codes, and every surface renders them
// through i18n keys. Each case carries a session sentence in both the old
// `message` slot and the non-rendered `diagnostic`; it must never appear.
// The test locale replaces every expected key with a marker, so a visible
// marker proves the text came from that key.

const fake = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock("./session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.js")>();
  return {
    ...actual,
    createCharacterSession: () => fakeSession(() => fake.snapshot as CharacterSnapshot),
  };
});

function fakeSession(read: () => CharacterSnapshot): CharacterSession {
  const base: Record<string, unknown> = {
    open: async () => {},
    dispose: () => {},
    subscribe: () => () => {},
    getSnapshot: read,
    whenIdle: async () => {},
    refresh: async () => {},
    requestEditing: async () => false,
    fetchActivityPage: async () => ({ events: [], nextCursor: null }),
  };
  return new Proxy(base, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn(async () => {})),
  }) as unknown as CharacterSession;
}

const ACTOR = "00000000-0000-4000-8000-0000000000a1";
const CHARACTER_ID = "00000000-0000-4000-8000-0000000000c3";
const SENTENCE = "SESSION SENTENCE THAT MUST NOT RENDER";

type Surface = "alert" | "review" | "none";
type Case = {
  name: string;
  kind: string;
  reason?: string;
  key: string;
  route: Surface;
};

const cases: Case[] = [
  { name: "conflict", kind: "conflict", key: "character.error.conflict", route: "review" },
  { name: "conflict (request in flight)", kind: "conflict", reason: "request-in-flight", key: "character.error.conflictInFlight", route: "review" },
  { name: "conflict (newer version)", kind: "conflict", reason: "newer-version", key: "character.error.conflictNewerVersion", route: "review" },
  { name: "invalid", kind: "invalid", key: "character.error.invalid", route: "review" },
  { name: "invalid (roll preparation)", kind: "invalid", reason: "roll-preparation", key: "character.error.rollPreparation", route: "review" },
  { name: "expired-attempt", kind: "expired-attempt", key: "character.error.expiredAttempt", route: "review" },
  { name: "expired-attempt (unknown outcome)", kind: "expired-attempt", reason: "unknown-outcome", key: "character.error.expiredAttemptUnknownOutcome", route: "review" },
  { name: "reauthenticate", kind: "reauthenticate", key: "character.error.reauthenticate", route: "alert" },
  { name: "network-unavailable", kind: "network-unavailable", key: "character.error.refreshFailed", route: "alert" },
  { name: "network-unavailable (review base)", kind: "network-unavailable", reason: "review-base-unavailable", key: "character.error.reviewBaseUnavailable", route: "alert" },
  { name: "protocol", kind: "protocol", key: "character.error.protocol", route: "alert" },
  { name: "not-found with the sheet still shown", kind: "not-found", key: "character.error.notFound", route: "alert" },
];

const marker = (key: string) => `[[${key}]]`;
const KEYS = [...new Set([...cases.map((c) => c.key), "character.sync.purged", "character.detail.storageUnavailable", "character.detail.unavailable"])];

function snapshotFor(error: Record<string, unknown> | null, overrides: Partial<CharacterSnapshot> = {}): CharacterSnapshot {
  return {
    phase: "conflict",
    view: { source: "stored", character: makeView({ characterId: CHARACTER_ID, revision: 1, name: "Briar" }) },
    storage: "available",
    tentative: null,
    entries: [],
    editing: { owned: false, blockedBy: "other-tab" },
    error: error as CharacterSnapshot["error"],
    connected: true,
    lastRoll: null,
    lastNominal: null,
    pendingOnlineAttempts: [],
    ...overrides,
  };
}

function errorFor(c: { kind: string; reason?: string }): Record<string, unknown> {
  return { kind: c.kind, ...(c.reason && { reason: c.reason }), message: SENTENCE, diagnostic: SENTENCE };
}

function renderRoute() {
  const identity: IdentityPort = { getActorId: () => ACTOR, getGeneration: () => 0, isOnline: () => true, isCurrent: async () => true, subscribe: () => () => {} };
  const coordination = { isOwner: () => false, requestEditing: async () => false, letGo: () => {}, subscribe: () => () => {} } as CoordinationPort;
  const store = {
    read: async () => ({ confirmed: null, entries: [], generation: 0, accountGeneration: 0 }),
    listCharacters: async () => [],
    readEntryTemplates: async () => [],
  } as unknown as CharacterStore;
  const api = { open: vi.fn(), rules: vi.fn(async () => ({ rules: [] })) } as unknown as CharactersApi;
  return render(<CharacterDetail characterId={CHARACTER_ID} api={api} store={store} identity={identity}
    coordination={coordination} locksSupported />);
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const roll = {
  actionId: "a1", expression: "2d6", dice: [], bindings: [], total: 4, output: "GM saved pool", audience: "campaign",
  breakdown: { version: "1.0", rootId: "root", groups: [], terms: [] },
  push: { version: "1.0", rollId: "root", rootRollId: "root", parentRollId: null, attempt: 0, maxAttempts: 2, rerolledDiceIds: [], faceOutcomes: [] },
};

async function renderBoard(snapshot: CharacterSnapshot) {
  const factory = vi.fn(() => fakeSession(() => snapshot));
  const chars = {
    open: vi.fn().mockResolvedValue({ character: snapshot.view?.character }),
    executeCharacterAction: vi.fn(), bumpCharacterResource: vi.fn(),
    pushOptions: vi.fn().mockResolvedValue({ options: { canPush: true, reason: null, eligibleDiceIds: [], revision: 1, nextAttempt: 1, maxAttempts: 2 } }),
    readRoll: vi.fn(),
  };
  const campaigns = {
    listContent: vi.fn().mockResolvedValue({ content: [], nextCursor: null }),
    listActivity: vi.fn().mockResolvedValue({ events: [], nextCursor: null }),
    listCampaignCharacters: vi.fn().mockResolvedValue({ characters: [{ characterId: CHARACTER_ID, name: "Briar", controllers: [] }], nextCursor: null }),
  };
  const ui = render(<SessionBoard campaignsApi={campaigns as never} charactersApi={chars as never} createSession={factory as never}
    campaignId="c1" actorId={ACTOR} generation={0} online onOpenCharacter={() => {}} onAccessRevoked={() => {}} />, { wrapper: wrapper() });
  (await screen.findByRole("button", { name: /open briar/i })).click();
  await waitFor(() => expect(factory).toHaveBeenCalled());
  return ui;
}

beforeEach(() => {
  registerLocale(Object.fromEntries(KEYS.map((key) => [key, marker(key)])));
});
afterEach(() => {
  resetLocale();
  vi.restoreAllMocks();
});

describe("session error messages come from i18n keys (V3)", () => {
  it.each(cases)("renders $name on the character route through its key only", async (c) => {
    fake.snapshot = snapshotFor(errorFor(c));
    const ui = renderRoute();
    try {
      expect(await screen.findByRole("heading", { name: "Briar" })).toBeVisible();
      expect(screen.queryByText(SENTENCE, { exact: false })).not.toBeInTheDocument();
      const alerts = screen.queryAllByRole("alert").filter((node) => node.textContent?.includes(marker(c.key)));
      if (c.route === "alert") {
        expect(alerts).toHaveLength(1);
      } else {
        expect(alerts).toHaveLength(0);
        expect(screen.getByText(marker(c.key))).toBeVisible();
      }
    } finally { ui.unmount(); }
  });

  it("shows no session alert on the character route for a storage failure", async () => {
    fake.snapshot = snapshotFor(null, { phase: "storage-error", storage: "unavailable", editing: { owned: false, blockedBy: "storage" } });
    const ui = renderRoute();
    try {
      expect(await screen.findByRole("heading", { name: "Briar" })).toBeVisible();
      expect(screen.getAllByText(marker("character.detail.storageUnavailable"))).toHaveLength(1);
      expect(screen.queryAllByRole("alert")).toHaveLength(0);
    } finally { ui.unmount(); }
  });

  it("shows only the unavailable text on the character route for a purged character", async () => {
    fake.snapshot = snapshotFor(errorFor({ kind: "purged" }), { phase: "purged", view: null, editing: { owned: false } });
    const ui = renderRoute();
    try {
      expect(await screen.findByText(marker("character.detail.unavailable"))).toBeVisible();
      expect(screen.queryByText(SENTENCE, { exact: false })).not.toBeInTheDocument();
      expect(screen.getAllByRole("alert")).toHaveLength(1);
    } finally { ui.unmount(); }
  });

  it("shows the server's own message for a rejected value (server data, not session text)", async () => {
    fake.snapshot = snapshotFor({ kind: "invalid", serverMessage: "Health must be at most 5.", message: SENTENCE, diagnostic: SENTENCE });
    const ui = renderRoute();
    try {
      expect(await screen.findByText("Health must be at most 5.")).toBeVisible();
      expect(screen.queryByText(SENTENCE, { exact: false })).not.toBeInTheDocument();
    } finally { ui.unmount(); }
  });

  it.each([
    ...cases.map((c) => ({ name: c.name, error: errorFor(c) as Record<string, unknown> | null, storage: "available" as const, key: c.key })),
    { name: "purged", error: errorFor({ kind: "purged" }), storage: "available" as const, key: "character.sync.purged" },
    { name: "a storage failure", error: null, storage: "unavailable" as const, key: "character.detail.storageUnavailable" },
  ])("renders $name on the session board through its key only", async ({ error, storage, key }) => {
    const snapshot = snapshotFor(error, { lastRoll: roll as never, storage, phase: storage === "unavailable" ? "storage-error" : "conflict" });
    const ui = await renderBoard(snapshot);
    try {
      const alert = await screen.findByText(marker(key));
      expect(alert).toHaveAttribute("role", "alert");
      expect(screen.queryByText(SENTENCE, { exact: false })).not.toBeInTheDocument();
    } finally { ui.unmount(); }
  });
});
