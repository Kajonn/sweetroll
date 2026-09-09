import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import { createCharactersApi } from "./api.js";
import type { FrozenRequest } from "./types.js";

function rejectWith(overrides: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) {
  return Object.assign(
    new ApiError({
      code: "internal",
      message: "boom",
      status: 500,
      requestId: "req-1",
      latestRevision: null,
      diagnostics: [],
    }),
    overrides,
  );
}

function makeClient(): ApiClient & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => null),
  } as unknown as ApiClient & { fetch: ReturnType<typeof vi.fn> };
}

const request = {
  method: "POST" as const,
  path: "/characters/11111111-1111-4111-8111-111111111111/fields/health/set",
  body: { value: 14, expectedRevision: 2, idempotencyKey: "key-1" },
  firstAttemptAt: "2026-09-06T00:00:00.000Z",
};

describe("createCharactersApi", () => {
  it("open fetches the character envelope from GET /characters/:characterId", async () => {
    const client = makeClient();
    const envelope = { character: { characterId: "c-1" }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(api.open("c-1")).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith("GET", "/characters/c-1");
  });

  it("creationOptions passes the version query parameter", async () => {
    const client = makeClient();
    const envelope = { data: { versionId: "v-1", packageChecksum: "abc", entities: [] }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(api.creationOptions("v-1")).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith(
      "GET",
      "/characters/creation-options",
      { query: { systemVersionId: "v-1" } },
    );
  });

  it("listCreationVersions fetches GET /characters/creation-versions with no query/body", async () => {
    const client = makeClient();
    const envelope = { data: { versions: [] }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(api.listCreationVersions()).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith("GET", "/characters/creation-versions");
  });

  it("listCreationVersions forwards cursor, limit, q and systemId filters", async () => {
    const client = makeClient();
    const envelope = { data: { versions: [], nextCursor: null }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(
      api.listCreationVersions({ cursor: "cursor-1", limit: 2, q: "alp", systemId: "system-1" }),
    ).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith(
      "GET",
      "/characters/creation-versions",
      { query: { cursor: "cursor-1", limit: 2, q: "alp", systemId: "system-1" } },
    );
  });

  it("listCreationVersions omits unset filters from the query", async () => {
    const client = makeClient();
    client.fetch.mockResolvedValueOnce({ data: { versions: [], nextCursor: null }, requestId: "r-1" });
    const api = createCharactersApi(client);
    await api.listCreationVersions({ cursor: null, limit: 20, q: null, systemId: null });
    expect(client.fetch).toHaveBeenCalledWith(
      "GET",
      "/characters/creation-versions",
      { query: { cursor: undefined, limit: 20, q: undefined, systemId: undefined } },
    );
  });

  it("activity forwards the cursor query parameter", async () => {
    const client = makeClient();
    const envelope = { events: [], nextCursor: null, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(api.activity("c-1", "cursor-1")).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith(
      "GET",
      "/characters/c-1/activity",
      { query: { cursor: "cursor-1" } },
    );
  });

  it("activity omits a null cursor", async () => {
    const client = makeClient();
    client.fetch.mockResolvedValueOnce({ events: [], nextCursor: null, requestId: "r-1" });
    const api = createCharactersApi(client);
    await api.activity("c-1", null);
    expect(client.fetch).toHaveBeenCalledWith(
      "GET",
      "/characters/c-1/activity",
      { query: { cursor: null } },
    );
  });

  it("send forwards method, path and body unchanged and never mints an idempotency key", async () => {
    const client = makeClient();
    const envelope = { result: { character: { characterId: "c-1" }, roll: null }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    await expect(api.send(request)).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith("POST", request.path, { body: request.body });
    expect(request.body.idempotencyKey).toBe("key-1");
    expect(Object.keys(request.body).sort()).toEqual(["expectedRevision", "idempotencyKey", "value"]);
  });

  it("send forwards a PATCH management request unchanged", async () => {
    const client = makeClient();
    const envelope = { result: { character: { characterId: "c-1" }, roll: null }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    const management: FrozenRequest = {
      method: "PATCH",
      path: "/characters/c-1",
      body: { command: "archive", expectedRevision: 3, idempotencyKey: "key-2" },
      firstAttemptAt: "2026-09-06T00:00:00.000Z",
    };
    await api.send(management);
    expect(client.fetch).toHaveBeenCalledWith("PATCH", "/characters/c-1", { body: management.body });
  });

  it("export posts to the export endpoint and returns the authoritative document", async () => {
    const client = makeClient();
    const document = { schemaVersion: "1.0", characterId: "c-1", name: "Aria", revision: 1 };
    client.fetch.mockResolvedValueOnce(document);
    const api = createCharactersApi(client);
    await expect(api.export("c-1")).resolves.toBe(document);
    expect(client.fetch).toHaveBeenCalledWith("POST", "/characters/c-1/exports");
  });

  it("previewMigration posts the target version body", async () => {
    const client = makeClient();
    const envelope = { preview: { previewId: "p-1", warnings: [] }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    const body = { targetVersionId: "v-2", mappings: { ability: "strength" } };
    await expect(api.previewMigration("c-1", body)).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith(
      "POST",
      "/characters/c-1/migration-previews",
      { body },
    );
  });

  it("propagates a 401 ApiError from the transport", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(rejectWith({ code: "unauthorized", status: 401, message: "Authentication is required." }));
    const api = createCharactersApi(client);
    await expect(api.open("c-1")).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("retains cacheDisposition purge on an inaccessible-character 404", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(rejectWith({ code: "not_found", status: 404, cacheDisposition: "purge" }));
    const api = createCharactersApi(client);
    await expect(api.open("c-1")).rejects.toMatchObject({ code: "not_found", cacheDisposition: "purge" });
  });

  it("retains changedDefinitionIds and replace disposition on a 409 conflict", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(
      rejectWith({
        code: "conflict",
        status: 409,
        latestRevision: 7,
        changedDefinitionIds: ["health"],
        activityCursor: "cursor-1",
        cacheDisposition: "replace",
      }),
    );
    const api = createCharactersApi(client);
    const error = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(error.cacheDisposition).toBe("replace");
    expect(error.changedDefinitionIds).toEqual(["health"]);
    expect(error.activityCursor).toBe("cursor-1");
    expect(error.latestRevision).toBe(7);
  });

  it("retains runtime definition diagnostics on a 422", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(
      rejectWith({
        code: "invalid_value",
        status: 422,
        runtimeDiagnostics: [
          { validationId: "health_valid", severity: "error", message: "Health must be positive", targetDefinitionId: "health" },
        ],
      }),
    );
    const api = createCharactersApi(client);
    const error = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(error.code).toBe("invalid_value");
    expect(error.runtimeDiagnostics[0]?.targetDefinitionId).toBe("health");
    expect(error.runtimeDiagnostics[0]?.validationId).toBe("health_valid");
  });

  it("surfaces a malformed successful send as an error rather than silently passing", async () => {
    const client = makeClient();
    client.fetch.mockResolvedValueOnce(null);
    const api = createCharactersApi(client);
    const error = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("malformed_response");
  });

  it("does not swallow authoring diagnostics from system-authoring errors", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(
      rejectWith({ code: "bad_request", status: 400, diagnostics: [{ code: "required", path: "/widgets", message: "Missing widget" }] }),
    );
    const api = createCharactersApi(client);
    const error = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(error.diagnostics).toEqual([{ code: "required", path: "/widgets", message: "Missing widget" }]);
  });

  it("send forwards a migration commit unchanged and never mints an idempotency key", async () => {
    const client = makeClient();
    const envelope = { result: { character: { characterId: "c-1" }, roll: null }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    const commit: FrozenRequest = {
      method: "POST",
      path: "/characters/c-1/migrations/p-1/commit",
      body: { expectedRevision: 3, idempotencyKey: "commit-key" },
      firstAttemptAt: "2026-09-06T00:00:00.000Z",
    };
    await expect(api.send(commit)).resolves.toBe(envelope);
    expect(client.fetch).toHaveBeenCalledWith("POST", commit.path, { body: commit.body });
    expect(commit.body.idempotencyKey).toBe("commit-key");
    expect(Object.keys(commit.body).sort()).toEqual(["expectedRevision", "idempotencyKey"]);
  });

  it("send forwards a migration rollback unchanged", async () => {
    const client = makeClient();
    const envelope = { result: { character: { characterId: "c-1" }, roll: null }, requestId: "r-1" };
    client.fetch.mockResolvedValueOnce(envelope);
    const api = createCharactersApi(client);
    const rollback: FrozenRequest = {
      method: "POST",
      path: "/characters/c-1/migrations/m-1/rollback",
      body: { idempotencyKey: "rollback-key" },
      firstAttemptAt: "2026-09-06T00:00:00.000Z",
    };
    await api.send(rollback);
    expect(client.fetch).toHaveBeenCalledWith("POST", rollback.path, { body: rollback.body });
    expect(rollback.body.idempotencyKey).toBe("rollback-key");
  });

  it.each(["command_in_progress", "temporarily_unavailable"] as const)(
    "propagates %s with code, status and revision intact for same-request retry",
    async (code) => {
      const client = makeClient();
      client.fetch.mockRejectedValueOnce(rejectWith({ code, status: 409, message: "Busy.", latestRevision: 3 }));
      const api = createCharactersApi(client);
      const error = await api.send(request).catch((e: unknown) => e) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe(code);
      expect(error.status).toBe(409);
      expect(error.latestRevision).toBe(3);
    },
  );

  it("propagates replay-window expiry conflicts with code and message intact", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(
      rejectWith({
        code: "conflict",
        status: 409,
        message: "The replay window for this idempotency key has expired. Retry with a new key.",
        latestRevision: 3,
      }),
    );
    const api = createCharactersApi(client);
    const error = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(error.code).toBe("conflict");
    expect(error.message).toMatch(/replay window/);
    expect(error.latestRevision).toBe(3);
  });

  it("propagates idempotency mismatches and unexpected 500s without rewriting them", async () => {
    const client = makeClient();
    client.fetch.mockRejectedValueOnce(
      rejectWith({ code: "idempotency_mismatch", status: 409, message: "Mismatch." }),
    );
    const api = createCharactersApi(client);
    const mismatch = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(mismatch.code).toBe("idempotency_mismatch");
    expect(mismatch.status).toBe(409);

    client.fetch.mockRejectedValueOnce(rejectWith({ code: "internal", status: 500, message: "boom" }));
    const internal = await api.send(request).catch((e: unknown) => e) as ApiError;
    expect(internal.code).toBe("internal");
    expect(internal.status).toBe(500);
  });
});