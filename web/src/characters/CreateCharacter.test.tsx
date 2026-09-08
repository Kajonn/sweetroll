import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore, type OnlineAttempt } from "./store.js";
import { CreateCharacter } from "./CreateCharacter.js";

const VERSION_ID = "11111111-1111-4000-8000-000000000001";

function makeApi(): CharactersApi & {
  creationOptions: ReturnType<typeof vi.fn>;
  listCreationVersions: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    creationOptions: vi.fn(),
    listCreationVersions: vi.fn(async () => ({ data: { versions: [] }, requestId: "r" })),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
    previewMigration: vi.fn(),
  } as unknown as CharactersApi & {
    creationOptions: ReturnType<typeof vi.fn>;
    listCreationVersions: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
}

/** Every render gets a fresh query client with retries off, like the other suites. */
function renderCreate(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(node, { wrapper });
}

function makeIdentity(overrides: { actorId?: string | null; online?: boolean } = {}) {
  return {
    getActorId: () => overrides.actorId ?? "actor-1",
    isOnline: () => overrides.online ?? true,
  };
}

function metadata() {
  return {
    data: {
      versionId: VERSION_ID,
      packageChecksum: "checksum-1",
      entities: [
        { id: "hero", label: "Hero" },
        { id: "sage", label: "Sage" },
      ],
    },
    requestId: "req-meta",
  };
}

async function openStore(): Promise<CharacterStore> {
  return openCharacterStore(`create-test-${crypto.randomUUID()}`);
}

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("System version ID"), VERSION_ID);
  await user.click(screen.getByRole("button", { name: "Look up version" }));
  await screen.findByLabelText("Entity");
  await user.selectOptions(screen.getByLabelText("Entity"), "sage");
  await user.type(screen.getByLabelText("Character name"), "Briar");
  await user.click(screen.getByRole("button", { name: "Create character" }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Single stable identity object whose account can switch mid-flight, like the real gate. */
function makeMutableIdentity(actor: string | null) {
  let current = actor;
  let generation = 0;
  let durable = true;
  const isCurrent = vi.fn(async () => durable && current !== null);
  return {
    identity: {
      getActorId: () => current,
      isOnline: () => true,
      getGeneration: () => generation,
      isCurrent,
    },
    switchTo(next: string | null) { current = next; generation += 1; },
    revokeDurable() { durable = false; },
  };
}

function makeCreateAttempt(actorId: string, id = "create-1", firstAttemptAt = "2026-09-06T00:00:00.000Z"): OnlineAttempt {
  return {
    id,
    actorId,
    characterId: null,
    kind: "create",
    request: {
      method: "POST",
      path: "/characters",
      body: {
        systemVersionId: VERSION_ID,
        entityDefinitionId: "hero",
        name: "OldName",
        idempotencyKey: "old-key",
      },
      firstAttemptAt,
    },
    createdAt: firstAttemptAt,
  };
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("System version ID"), VERSION_ID);
  await user.click(screen.getByRole("button", { name: "Look up version" }));
  await screen.findByLabelText("Entity");
  await user.selectOptions(screen.getByLabelText("Entity"), "sage");
  await user.type(screen.getByLabelText("Character name"), "Briar");
}

describe("CreateCharacter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates with the selected version, entity and name, then reports the new character once", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    api.send.mockResolvedValueOnce({ character: { characterId: "char-1" }, requestId: "req-1" });
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await fillAndSubmit(user);
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      const request = api.send.mock.calls[0]![0] as { method: string; path: string; body: Record<string, unknown> };
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/characters");
      expect(request.body["systemVersionId"]).toBe(VERSION_ID);
      expect(request.body["entityDefinitionId"]).toBe("sage");
      expect(request.body["name"]).toBe("Briar");
      expect(typeof request.body["idempotencyKey"]).toBe("string");
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(onCreated).toHaveBeenCalledWith("char-1");
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
    } finally {
      await store.close();
    }
  });

  it("shows the same generic message for denied metadata without authorizing creation", async () => {
    const user = userEvent.setup();
    const forbidden = new ApiError({
      code: "forbidden", message: "No access.", status: 403,
      requestId: "req-1", latestRevision: null, diagnostics: [],
    });
    const missing = new ApiError({
      code: "not_found", message: "Missing.", status: 404,
      requestId: "req-2", latestRevision: null, diagnostics: [],
    });
    const first = makeApi();
    first.creationOptions.mockRejectedValueOnce(forbidden);
    const firstStore = await openStore();
    const { unmount } = renderCreate(
      <CreateCharacter api={first} store={firstStore} identity={makeIdentity()} onCreated={vi.fn()} />,
    );
    await user.type(screen.getByLabelText("System version ID"), VERSION_ID);
    await user.click(screen.getByRole("button", { name: "Look up version" }));
    const deniedMessage = await screen.findByText("This system version is unavailable for character creation.");
    expect(deniedMessage).toBeVisible();
    expect(screen.queryByLabelText("Entity")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create character" })).not.toBeInTheDocument();
    unmount();
    await firstStore.close();

    const second = makeApi();
    second.creationOptions.mockRejectedValueOnce(missing);
    const secondStore = await openStore();
    renderCreate(
      <CreateCharacter api={second} store={secondStore} identity={makeIdentity()} onCreated={vi.fn()} />,
    );
    await user.type(screen.getByLabelText("System version ID"), VERSION_ID);
    await user.click(screen.getByRole("button", { name: "Look up version" }));
    expect(await screen.findByText("This system version is unavailable for character creation.")).toBeVisible();
    expect(screen.queryByLabelText("Entity")).not.toBeInTheDocument();
    await secondStore.close();
  });

  it("blocks creation while offline and explains why", async () => {
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity({ online: false })} onCreated={vi.fn()} />,
      );
      expect(screen.getByText("Character creation requires an online connection.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Create character" })).not.toBeInTheDocument();
      expect(api.creationOptions).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("suppresses double-clicks to a single send and a single onCreated", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    let release!: (value: unknown) => void;
    api.send.mockReturnValueOnce(new Promise<unknown>(resolve => { release = resolve; }));
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await user.type(screen.getByLabelText("System version ID"), VERSION_ID);
      await user.click(screen.getByRole("button", { name: "Look up version" }));
      await screen.findByLabelText("Entity");
      await user.selectOptions(screen.getByLabelText("Entity"), "hero");
      await user.type(screen.getByLabelText("Character name"), "Aria");
      const create = screen.getByRole("button", { name: "Create character" });
      await user.click(create);
      await user.click(create);
      expect(api.send).toHaveBeenCalledTimes(1);
      release({ character: { characterId: "char-2" }, requestId: "req-2" });
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      expect(onCreated).toHaveBeenCalledWith("char-2");
    } finally {
      await store.close();
    }
  });

  it("reloads an uncertain create and retries with the identical body and key", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    api.send.mockRejectedValueOnce(new Error("network down"));
    api.send.mockResolvedValueOnce({ character: { characterId: "char-9" }, requestId: "req-9" });
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      const first = renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await fillAndSubmit(user);
      expect(await screen.findByRole("button", { name: "Retry creation" })).toBeVisible();
      expect(api.send).toHaveBeenCalledTimes(1);
      const firstCreate = api.send.mock.calls[0]![0] as { body: Record<string, unknown> };
      const attempts = await store.readOnlineAttempts("actor-1");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.request.body).toEqual(firstCreate.body);
      first.unmount();

      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      expect(await screen.findByRole("button", { name: "Retry creation" })).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Retry creation" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
      const retriedCreate = api.send.mock.calls[1]![0] as { body: Record<string, unknown> };
      expect(firstCreate.body).toEqual(retriedCreate.body);
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith("char-9");
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
    } finally {
      await store.close();
    }
  });

  it("accepts an initial version ID from the route search input", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter
          api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()}
          initialSystemVersionId={VERSION_ID}
        />,
      );
      expect(await screen.findByLabelText("Entity")).toBeInTheDocument();
      expect(api.creationOptions).toHaveBeenCalledWith(VERSION_ID);
      await user.selectOptions(screen.getByLabelText("Entity"), "hero");
      await user.type(screen.getByLabelText("Character name"), "Aria");
      expect(screen.getByRole("button", { name: "Create character" })).toBeEnabled();
    } finally {
      await store.close();
    }
  });

  it("C1 deletes the durable create attempt on first-submit 403 even though pending state is stale", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    api.send.mockRejectedValueOnce(
      new ApiError({
        code: "denied", message: "No.", status: 403,
        requestId: "req-x", latestRevision: null, diagnostics: [],
      }),
    );
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await fillAndSubmit(user);
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      await screen.findByRole("alert");
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
    } finally {
      await store.close();
    }
  });

  it("C2 never reuses a previous account's frozen body/key after an account switch", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    api.send.mockResolvedValue({ character: { characterId: "char-x" }, requestId: "req-x" });
    const store = await openStore();
    try {
      await store.saveOnlineAttempt({
        id: "attempt-old",
        actorId: "actor-1",
        characterId: null,
        kind: "create",
        request: {
          method: "POST",
          path: "/characters",
          body: {
            systemVersionId: VERSION_ID,
            entityDefinitionId: "hero",
            name: "OldName",
            idempotencyKey: "old-key",
          },
          firstAttemptAt: "2026-09-06T00:00:00.000Z",
        },
        createdAt: "2026-09-06T00:00:00.000Z",
      });
      const view = renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity({ actorId: "actor-1" })} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("button", { name: "Retry creation" })).toBeVisible();
      view.rerender(
        <CreateCharacter api={api} store={store} identity={makeIdentity({ actorId: "actor-2" })} onCreated={vi.fn()} />,
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Retry creation" })).not.toBeInTheDocument(),
      );
      expect(api.send).not.toHaveBeenCalled();
      const otherAttempts = await store.readOnlineAttempts("actor-1");
      expect(otherAttempts).toHaveLength(1);
      expect(otherAttempts[0]!.request.body).toMatchObject({ idempotencyKey: "old-key" });
    } finally {
      await store.close();
    }
  });

  it("T4a never sends after an account switch lands while attempts are being read", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    const gate = deferred<OnlineAttempt[]>();
    const read = vi.spyOn(store, "readOnlineAttempts");
    const mutable = makeMutableIdentity("actor-1");
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={mutable.identity} onCreated={onCreated} />,
      );
      // Let mount recovery consume the real read before arming the gate.
      await waitFor(() => expect(read).toHaveBeenCalled());
      read.mockReturnValueOnce(gate.promise);
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      mutable.switchTo("actor-2");
      gate.resolve([]);
      await waitFor(() => expect(store.readOnlineAttempts("actor-2")).resolves.toEqual([]));
      // Let any late continuation settle.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(api.send).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
      expect(await store.readOnlineAttempts("actor-1")).toEqual([]);
      expect(await store.readOnlineAttempts("actor-2")).toEqual([]);
    } finally {
      read.mockRestore();
      await store.close();
    }
  });

  it("T4b never sends after sign-out lands while the creation attempt is being persisted", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    api.send.mockResolvedValue({ character: { characterId: "char-1" }, requestId: "req-1" });
    const store = await openStore();
    const gate = deferred<void>();
    const save = vi.spyOn(store, "saveOnlineAttempt").mockReturnValueOnce(gate.promise);
    const mutable = makeMutableIdentity("actor-1");
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={mutable.identity} onCreated={onCreated} />,
      );
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(save).toHaveBeenCalled());
      mutable.switchTo(null);
      mutable.revokeDurable();
      gate.resolve();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(api.send).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
      await store.close();
    }
  });

  it("T4c rechecks durable currency immediately before the network send", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    api.send.mockResolvedValue({ character: { characterId: "char-1" }, requestId: "req-1" });
    const store = await openStore();
    const mutable = makeMutableIdentity("actor-1");
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={mutable.identity} onCreated={onCreated} />,
      );
      await fillForm(user);
      mutable.identity.isCurrent.mockClear();
      const sendGate = deferred<unknown>();
      api.send.mockReturnValueOnce(sendGate.promise);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      // The submit path must consult the durable gate after persisting and
      // before sending, not just during mount recovery.
      expect(mutable.identity.isCurrent).toHaveBeenCalled();
      mutable.switchTo("actor-2");
      mutable.revokeDurable();
      sendGate.resolve({ character: { characterId: "char-1" }, requestId: "req-1" });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(onCreated).not.toHaveBeenCalled();
      expect(await store.readOnlineAttempts("actor-1")).toHaveLength(1);
      expect(await store.readOnlineAttempts("actor-2")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("T4d performs no marker write or navigation when the account switches before success cleanup", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const sendGate = deferred<unknown>();
    api.send.mockReturnValueOnce(sendGate.promise);
    const store = await openStore();
    const mutable = makeMutableIdentity("actor-1");
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={mutable.identity} onCreated={onCreated} />,
      );
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      const sent = api.send.mock.calls[0]![0] as { body: Record<string, unknown> };
      mutable.switchTo("actor-2");
      mutable.revokeDurable();
      sendGate.resolve({ character: { characterId: "char-late" }, requestId: "req-late" });
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(1));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(onCreated).not.toHaveBeenCalled();
      // The stale success must neither navigate nor retire the old attempt,
      // and must not mint anything under the new account.
      expect(await store.readOnlineAttempts("actor-1")).toHaveLength(1);
      expect((await store.readOnlineAttempts("actor-1"))[0]!.request.body).toEqual(sent.body);
      expect(await store.readOnlineAttempts("actor-2")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("T4e reloads the exact persisted creation body/key without fresh metadata", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      await store.saveOnlineAttempt(makeCreateAttempt("actor-1"));
      api.send.mockResolvedValueOnce({ character: { characterId: "char-9" }, requestId: "req-9" });
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      expect(await screen.findByRole("button", { name: "Retry creation" })).toBeVisible();
      expect(api.creationOptions).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Retry creation" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      const retried = api.send.mock.calls[0]![0] as { body: Record<string, unknown> };
      expect(retried.body).toEqual({
        systemVersionId: VERSION_ID,
        entityDefinitionId: "hero",
        name: "OldName",
        idempotencyKey: "old-key",
      });
      expect(api.creationOptions).not.toHaveBeenCalled();
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith("char-9"));
    } finally {
      await store.close();
    }
  });

  it("T4f surfaces durable storage rejection without sending", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    const save = vi
      .spyOn(store, "saveOnlineAttempt")
      .mockRejectedValueOnce(new DOMException("Quota exceeded", "QuotaExceededError"));
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(await screen.findByRole("alert")).toHaveTextContent(/could not be saved|storage/i);
      expect(api.send).not.toHaveBeenCalled();
      expect(await store.readOnlineAttempts("actor-1")).toEqual([]);
      expect(screen.queryByRole("button", { name: "Retry creation" })).not.toBeInTheDocument();
    } finally {
      save.mockRestore();
      await store.close();
    }
  });

  it("T4g cleans up a first-submit definitive rejection under the captured account, not the new one", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const sendGate = deferred<unknown>();
    api.send.mockReturnValueOnce(sendGate.promise);
    const store = await openStore();
    const mutable = makeMutableIdentity("actor-1");
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
      );
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      mutable.switchTo("actor-2");
      mutable.revokeDurable();
      sendGate.reject(
        new ApiError({
          code: "denied", message: "No.", status: 403,
          requestId: "req-x", latestRevision: null, diagnostics: [],
        }),
      );
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(api.send).toHaveBeenCalledTimes(1);
      expect(await store.readOnlineAttempts("actor-1")).toEqual([]);
      expect(await store.readOnlineAttempts("actor-2")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("T4h never navigates or resolves after unmount during response handling", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const sendGate = deferred<unknown>();
    api.send.mockReturnValueOnce(sendGate.promise);
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      const view = renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await fillForm(user);
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      view.unmount();
      sendGate.resolve({ character: { characterId: "char-gone" }, requestId: "req-gone" });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(onCreated).not.toHaveBeenCalled();
      // The unresolved attempt stays durable so a reload can replay it by key.
      expect(await store.readOnlineAttempts("actor-1")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("T4i shows expiry-specific review for an aged creation attempt and never auto-sends", async () => {
    const api = makeApi();
    const store = await openStore();
    try {
      await store.saveOnlineAttempt(makeCreateAttempt("actor-1", "create-old", "2026-01-01T00:00:00.000Z"));
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("alert")).toHaveTextContent(/replay window|expired|outcome is unknown/i);
      expect(api.send).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Retry creation" })).not.toBeInTheDocument();
      expect(await store.readOnlineAttempts("actor-1")).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it("T4j explicit expired-create review retires the exact attempt without minting a replacement", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      await store.saveOnlineAttempt(makeCreateAttempt("actor-1", "create-old", "2026-01-01T00:00:00.000Z"));
      await store.saveOnlineAttempt(makeCreateAttempt("actor-1", "create-fresh"));
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await screen.findByRole("alert");
      await user.click(screen.getByRole("button", { name: /acknowledge.*unknown outcome/i }));
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(1));
      expect((await store.readOnlineAttempts("actor-1"))[0]!.id).toBe("create-fresh");
      expect(api.send).not.toHaveBeenCalled();
      expect(onCreated).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("T4k a replay-window-expired conflict is retained and flagged for explicit review, not retried", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await fillForm(user);
      api.send.mockRejectedValueOnce(
        new ApiError({
          code: "conflict",
          message: "The replay window for this idempotency key has expired. Retry with a new key.",
          status: 409,
          requestId: "req-exp",
          latestRevision: null,
          diagnostics: [],
        }),
      );
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole("alert")).toHaveTextContent(/replay window|expired|outcome is unknown/i);
      expect(screen.queryByRole("button", { name: "Retry creation" })).not.toBeInTheDocument();
      const attempts = await store.readOnlineAttempts("actor-1");
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.replayExpired).toBe(true);
      expect(attempts[0]!.request.body["idempotencyKey"]).toBe(
        (api.send.mock.calls[0]![0] as { body: Record<string, unknown> }).body["idempotencyKey"],
      );
    } finally {
      await store.close();
    }
  });

  it("P1 renders a button per available version when no version is prefilled", async () => {
    const api = makeApi();
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
            systemId: "system-d20",
            systemName: "D20",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            versionId: "bbbbbbbb-bbbb-4000-8000-000000000002",
            systemId: "system-cards",
            systemName: "Cards",
            semanticVersion: "0.9.0",
            createdAt: "2025-12-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "req-versions",
    });
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("heading", { name: "Choose a system version" })).toBeVisible();
      expect(await screen.findByRole("button", { name: "D20 1.0.0" })).toBeVisible();
      expect(await screen.findByRole("button", { name: "Cards 0.9.0" })).toBeVisible();
    } finally {
      await store.close();
    }
  });

  it("P2 selecting a version fills the version box and loads its metadata", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const picked = "aaaaaaaa-aaaa-4000-8000-000000000001";
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: picked,
            systemId: "system-d20",
            systemName: "D20",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "req-versions",
    });
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await user.click(await screen.findByRole("button", { name: "D20 1.0.0" }));
      expect(screen.getByLabelText("System version ID")).toHaveValue(picked);
      await waitFor(() => expect(api.creationOptions).toHaveBeenCalledWith(picked));
      expect(await screen.findByLabelText("Entity")).toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("P3 hides the picker when a version is prefilled from the route", async () => {
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter
          api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()}
          initialSystemVersionId={VERSION_ID}
        />,
      );
      expect(await screen.findByLabelText("Entity")).toBeInTheDocument();
      expect(api.listCreationVersions).not.toHaveBeenCalled();
      expect(screen.queryByRole("heading", { name: "Choose a system version" })).not.toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("P4 shows the picker error without breaking the manual version box", async () => {
    const api = makeApi();
    api.listCreationVersions.mockRejectedValueOnce(new Error("boom"));
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "Available versions could not be loaded. Enter a system version ID manually.",
      );
      expect(screen.getByLabelText("System version ID")).toBeVisible();
      expect(screen.getByRole("button", { name: "Look up version" })).toBeVisible();
    } finally {
      await store.close();
    }
  });

  it("T4l an idempotency mismatch stops with protocol review: attempt retired, no retry, no replacement key", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={onCreated} />,
      );
      await fillForm(user);
      api.send.mockRejectedValueOnce(
        new ApiError({
          code: "idempotency_mismatch",
          message: "This idempotency key was already used with different input.",
          status: 409,
          requestId: "req-mm",
          latestRevision: null,
          diagnostics: [],
        }),
      );
      await user.click(screen.getByRole("button", { name: "Create character" }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      expect(await screen.findByRole("alert")).toHaveTextContent(/idempotency key|manual review/i);
      expect(screen.queryByRole("button", { name: "Retry creation" })).not.toBeInTheDocument();
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
      expect(onCreated).not.toHaveBeenCalled();
      // No replacement is minted automatically: a single send happened and
      // the rejected attempt is gone without a successor.
      expect(api.send).toHaveBeenCalledTimes(1);
      expect(await store.readOnlineAttempts("actor-1")).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("P5 does not show account A's cached versions after switching to account B", async () => {
    const api = makeApi();
    const mutable = makeMutableIdentity("actor-A");
    const versionA = {
      versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      systemId: "system-a",
      systemName: "Private A",
      semanticVersion: "1.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    api.listCreationVersions.mockImplementation(async () => ({
      data: { versions: mutable.identity.getActorId() === "actor-A" ? [versionA] : [] },
      requestId: "r",
    }));
    const store = await openStore();
    // One shared client across the remount, like the application router: the
    // route remounts with an account-lifetime key but the QueryClient persists.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    try {
      const view = render(
        <CreateCharacter key="actor-A:0:" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
        { wrapper },
      );
      expect(await screen.findByRole("button", { name: "Private A 1.0.0" })).toBeVisible();
      expect(api.listCreationVersions).toHaveBeenCalledTimes(1);
      mutable.switchTo("actor-B");
      view.rerender(
        <CreateCharacter key="actor-B:1:" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
      );
      // B must refetch under its own lifetime instead of reusing A's cache.
      await waitFor(() => expect(api.listCreationVersions).toHaveBeenCalledTimes(2));
      await screen.findByText("No system versions are available for character creation.");
      expect(screen.queryByRole("button", { name: "Private A 1.0.0" })).not.toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("P6 disables picker selection while a creation attempt is pending", async () => {
    const api = makeApi();
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
            systemId: "system-a",
            systemName: "Private A",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "r",
    });
    const store = await openStore();
    try {
      await store.saveOnlineAttempt(makeCreateAttempt("actor-1"));
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("button", { name: "Retry creation" })).toBeVisible();
      expect(await screen.findByRole("button", { name: "Private A 1.0.0" })).toBeDisabled();
    } finally {
      await store.close();
    }
  });

  it("G slow A list resolving after B mounted never leaks A's names into B", async () => {
    const api = makeApi();
    const mutable = makeMutableIdentity("actor-A");
    const versionA = {
      versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
      systemId: "system-a",
      systemName: "Private A",
      semanticVersion: "1.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const gate = deferred<{ data: { versions: typeof versionA[] }; requestId: string }>();
    api.listCreationVersions.mockImplementation(async () => {
      if (mutable.identity.getActorId() === "actor-A") return gate.promise;
      return { data: { versions: [] }, requestId: "r-b" };
    });
    const store = await openStore();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    try {
      const view = render(
        <CreateCharacter key="actor-A:0" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
        { wrapper },
      );
      expect(await screen.findByText("Loading available versions…")).toBeVisible();
      // B mounts (route remount with its own lifetime key) before A's slow
      // list resolves; B's own fetch returns an empty list.
      mutable.switchTo("actor-B");
      view.rerender(
        <CreateCharacter key="actor-B:1" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
      );
      await screen.findByText("No system versions are available for character creation.");
      expect(api.listCreationVersions).toHaveBeenCalledTimes(2);
      // A's late response lands in A's cache entry only (keys isolate by
      // actor+generation); it must never appear in B's picker and must never
      // auto-select into a metadata load under B.
      gate.resolve({ data: { versions: [versionA] }, requestId: "r-a" });
      await gate.promise;
      // Wait until A's late response has actually landed in A's own cache
      // entry before asserting isolation: this proves B's UI survived the
      // late write instead of racing it.
      await waitFor(() => expect(
        qc.getQueryData(["characters", "creation-versions", "actor-A", 0]),
      ).toBeDefined());
      expect(screen.queryByRole("button", { name: "Private A 1.0.0" })).not.toBeInTheDocument();
      expect(screen.getByText("No system versions are available for character creation.")).toBeVisible();
      expect(api.creationOptions).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });

  it("G2 picker selection started by A never commits metadata under B", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const picked = "aaaaaaaa-aaaa-4000-8000-000000000001";
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: picked,
            systemId: "system-a",
            systemName: "Private A",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "r",
    });
    const metaGate = deferred<ReturnType<typeof metadata>>();
    api.creationOptions.mockReturnValueOnce(metaGate.promise);
    const store = await openStore();
    const mutable = makeMutableIdentity("actor-A");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    try {
      const view = render(
        <CreateCharacter key="actor-A:0" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
        { wrapper },
      );
      await user.click(await screen.findByRole("button", { name: "Private A 1.0.0" }));
      await waitFor(() => expect(api.creationOptions).toHaveBeenCalledWith(picked));
      // Account switches while the metadata load is in flight; the late
      // response is guarded by the actor/generation alive() check and must
      // not render the entity form under B.
      mutable.switchTo("actor-B");
      mutable.revokeDurable();
      view.rerender(
        <CreateCharacter key="actor-B:1" api={api} store={store} identity={mutable.identity} onCreated={vi.fn()} />,
      );
      metaGate.resolve(metadata());
      await metaGate.promise;
      // B's picker settling proves React processed updates past the account
      // switch; the late metadata must not have committed the entity form.
      await screen.findByRole("button", { name: "Private A 1.0.0" });
      expect(screen.queryByLabelText("Entity")).not.toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("H-a offline shows guidance without fetching; reconnect refetches the list", async () => {
    const api = makeApi();
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
            systemId: "system-a",
            systemName: "Private A",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "r",
    });
    const store = await openStore();
    try {
      const view = renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity({ online: false })} onCreated={vi.fn()} />,
      );
      expect(screen.getByText("Character creation requires an online connection.")).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Choose a system version" })).not.toBeInTheDocument();
      expect(api.listCreationVersions).not.toHaveBeenCalled();
      view.rerender(
        <CreateCharacter api={api} store={store} identity={makeIdentity({ online: true })} onCreated={vi.fn()} />,
      );
      expect(await screen.findByRole("button", { name: "Private A 1.0.0" })).toBeVisible();
      expect(api.listCreationVersions).toHaveBeenCalledTimes(1);
    } finally {
      await store.close();
    }
  });

  it("H-b revoked version shows denied message (not uncertain) with retry available", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    const picked = "aaaaaaaa-aaaa-4000-8000-000000000001";
    api.listCreationVersions.mockResolvedValue({
      data: {
        versions: [
          {
            versionId: picked,
            systemId: "system-a",
            systemName: "Private A",
            semanticVersion: "1.0.0",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      requestId: "r",
    });
    api.creationOptions.mockRejectedValueOnce(
      new ApiError({
        code: "forbidden", message: "No access.", status: 403,
        requestId: "req-403", latestRevision: null, diagnostics: [],
      }),
    );
    api.creationOptions.mockResolvedValueOnce(metadata());
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await user.click(await screen.findByRole("button", { name: "Private A 1.0.0" }));
      expect(await screen.findByText("This system version is unavailable for character creation.")).toBeVisible();
      expect(screen.queryByText(/may have been created|could not be confirmed/i)).not.toBeInTheDocument();
      // Retry stays available: the picker and the manual lookup remain.
      expect(screen.getByRole("heading", { name: "Choose a system version" })).toBeVisible();
      const retry = await screen.findByRole("button", { name: "Private A 1.0.0" });
      expect(retry).toBeEnabled();
      expect(screen.getByLabelText("System version ID")).toBeVisible();
      await user.click(retry);
      expect(await screen.findByLabelText("Entity")).toBeInTheDocument();
    } finally {
      await store.close();
    }
  });

  it("H-b2 missing version shows denied message and 400 shows invalid input (never uncertain)", async () => {
    const user = userEvent.setup();
    const makeListApi = () => {
      const listApi = makeApi();
      listApi.listCreationVersions.mockResolvedValue({
        data: {
          versions: [
            {
              versionId: "aaaaaaaa-aaaa-4000-8000-000000000001",
              systemId: "system-a",
              systemName: "Private A",
              semanticVersion: "1.0.0",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        requestId: "r",
      });
      return listApi;
    };
    const notFound = makeListApi();
    notFound.creationOptions.mockRejectedValueOnce(
      new ApiError({
        code: "not_found", message: "Missing.", status: 404,
        requestId: "req-404", latestRevision: null, diagnostics: [],
      }),
    );
    const notFoundStore = await openStore();
    const { unmount } = renderCreate(
      <CreateCharacter api={notFound} store={notFoundStore} identity={makeIdentity()} onCreated={vi.fn()} />,
    );
    await user.click(await screen.findByRole("button", { name: "Private A 1.0.0" }));
    expect(await screen.findByText("This system version is unavailable for character creation.")).toBeVisible();
    expect(screen.queryByText(/may have been created|could not be confirmed/i)).not.toBeInTheDocument();
    unmount();
    await notFoundStore.close();

    const badInput = makeListApi();
    badInput.creationOptions.mockRejectedValueOnce(
      new ApiError({
        code: "validation_failed", message: "Not a UUID.", status: 400,
        requestId: "req-400", latestRevision: null, diagnostics: [],
      }),
    );
    const badStore = await openStore();
    renderCreate(
      <CreateCharacter api={badInput} store={badStore} identity={makeIdentity()} onCreated={vi.fn()} />,
    );
    await user.click(await screen.findByRole("button", { name: "Private A 1.0.0" }));
    expect(await screen.findByText("The server rejected this character. Correct the details and try again.")).toBeVisible();
    expect(screen.queryByText(/may have been created|could not be confirmed/i)).not.toBeInTheDocument();
    await badStore.close();
  });

  it("H-b3 send-path 400 shows invalid input (not uncertain) and retires the attempt", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValueOnce(metadata());
    api.send.mockRejectedValueOnce(
      new ApiError({
        code: "validation_failed", message: "Bad input.", status: 400,
        requestId: "req-400", latestRevision: null, diagnostics: [],
      }),
    );
    const store = await openStore();
    try {
      renderCreate(
        <CreateCharacter api={api} store={store} identity={makeIdentity()} onCreated={vi.fn()} />,
      );
      await fillAndSubmit(user);
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("The server rejected this character. Correct the details and try again.")).toBeVisible();
      expect(screen.queryByText(/may have been created|could not be confirmed/i)).not.toBeInTheDocument();
      await waitFor(() => expect(store.readOnlineAttempts("actor-1")).resolves.toHaveLength(0));
    } finally {
      await store.close();
    }
  });
});
