import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "./client.js";

describe("createApiClient", () => {
  it("returns parsed JSON on 2xx", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-request-id": "req-1" } }));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    const out = await client.fetch("GET", "/foo");
    expect(out).toEqual({ ok: true });
    expect(fetch_).toHaveBeenCalledWith("http://api/foo", expect.objectContaining({ credentials: "include" }));
  });

  it("throws ApiError with code + status + requestId on 4xx", async () => {
    const fetch_ = vi.fn(async () => new Response(JSON.stringify({ error: { code: "bad_request", message: "no" }, requestId: "r-2" }), { status: 400, headers: { "content-type": "application/json" } }));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    await expect(client.fetch("POST", "/x", { body: { a: 1 } })).rejects.toMatchObject({ code: "bad_request", status: 400, requestId: "r-2" });
  });

  it("retains character reconciliation fields on non-2xx responses", async () => {
    const fetch_ = vi.fn(async () => new Response(
      JSON.stringify({
        error: {
          code: "conflict",
          message: "The character has a newer revision.",
          latestRevision: 7,
          changedDefinitionIds: ["health"],
          activityCursor: "cursor-1",
          cacheDisposition: "replace",
        },
        requestId: "r-3",
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    await expect(client.fetch("POST", "/c/1/fields/health/set", { body: {} })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
      requestId: "r-3",
      latestRevision: 7,
      changedDefinitionIds: ["health"],
      activityCursor: "cursor-1",
      cacheDisposition: "replace",
    });
  });

  it("retains character runtime diagnostics alongside authoring diagnostics", async () => {
    const runtime = [
      {
        validationId: "ability_valid_expr",
        severity: "error",
        message: "Ability must be between 3 and 18",
        targetDefinitionId: "ability",
      },
    ];
    const fetch_ = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "invalid_value", message: "Field value is invalid.", diagnostics: runtime }, requestId: "r-4" }),
      { status: 422, headers: { "content-type": "application/json" } },
    ));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    const error = await client.fetch("POST", "/c/1/fields/ability/set", { body: {} }).catch((e: unknown) => e) as ApiError;
    expect(error.code).toBe("invalid_value");
    expect(error.runtimeDiagnostics).toEqual(runtime);
    expect(error.diagnostics).toEqual([]);
  });

  it("still parses authoring diagnostics into the diagnostics field", async () => {
    const authoring = [{ code: "required", path: "/systems/widgets", message: "Missing widget" }];
    const fetch_ = vi.fn(async () => new Response(
      JSON.stringify({ error: { code: "bad_request", message: "no", diagnostics: authoring }, requestId: "r-5" }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    const error = await client.fetch("PUT", "/systems/w", { body: {} }).catch((e: unknown) => e) as ApiError;
    expect(error.code).toBe("bad_request");
    expect(error.diagnostics).toEqual(authoring);
    expect(error.runtimeDiagnostics).toEqual([]);
  });

  it("treats a 2xx with an unparseable body as a malformed response, never silent success", async () => {
    const fetch_ = vi.fn(async () => new Response("not-json", { status: 200, headers: { "content-type": "text/html" } }));
    const client = createApiClient({ baseUrl: "http://api", fetch: fetch_ as typeof fetch });
    const error = await client.fetch("POST", "/c/1/fields/health/set", { body: {} }).catch((e: unknown) => e) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("malformed_response");
    expect(error.status).toBe(200);
  });
});