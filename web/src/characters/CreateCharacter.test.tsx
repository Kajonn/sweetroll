import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client.js";
import type { CharactersApi } from "./api.js";
import { openCharacterStore, type CharacterStore } from "./store.js";
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
});
