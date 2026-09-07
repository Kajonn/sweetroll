import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore, type OnlineAttempt } from "./store.js";
import { CreateCharacter } from "./CreateCharacter.js";

const VERSION_ID = "11111111-1111-4000-8000-000000000001";

function makeApi(): CharactersApi & {
  creationOptions: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  return {
    open: vi.fn(),
    creationOptions: vi.fn(),
    activity: vi.fn(),
    send: vi.fn(),
    export: vi.fn(),
    previewMigration: vi.fn(),
  } as unknown as CharactersApi & {
    creationOptions: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
  };
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
      render(
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
    const { unmount } = render(
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
    render(
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
      render(
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
      render(
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
      const first = render(
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

      render(
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
      render(
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
      render(
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
      const view = render(
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
      render(
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
      render(
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
      render(
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
      render(
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
      render(
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
      render(
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
      render(
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
      const view = render(
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
      render(
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
      render(
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
      render(
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

  it("T4l an idempotency mismatch stops with protocol review: attempt retired, no retry, no replacement key", async () => {
    const user = userEvent.setup();
    const api = makeApi();
    api.creationOptions.mockResolvedValue(metadata());
    const store = await openStore();
    const onCreated = vi.fn();
    try {
      render(
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
});
