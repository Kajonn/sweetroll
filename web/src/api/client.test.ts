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
});