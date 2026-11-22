import { expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { createCharactersApi } from "../characters/api.js";
import type { FrozenRequest } from "../characters/types.js";
import { preparePhysicalRequest } from "./commands.js";

const dates = { firstAttemptAt: "2026-11-21T13:00:00Z" };
const request: FrozenRequest = {
  method: "POST",
  path: "/characters/hero/actions/test",
  body: { idempotencyKey: "once", expectedRevision: 1, entryId: "gear", audience: "gm_only" },
  ...dates,
};

it("keeps the frozen campaign command identity and replays only the exact settlement", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      attempt: { attemptId: "throw", launch: { version: "rapier-v1" } },
      serverTime: dates.firstAttemptAt,
    })
    .mockRejectedValueOnce(new TypeError("connection lost"))
    .mockResolvedValueOnce({ result: {} });
  const client = { fetch } as ApiClient;
  const signal = new AbortController().signal;
  const simulate = vi.fn().mockResolvedValue({ tick: 84, dice: [{ id: "die", value: 6 }] });
  const frozen = await preparePhysicalRequest(client, request, signal, simulate);
  expect(frozen.path).toBe(request.path);
  expect(fetch.mock.calls[0]![2].body).toEqual({
    ...request.body,
    kind: "executeAction",
    actionId: "test",
    inputs: {},
  });
  const api = createCharactersApi(client);
  await expect(api.send(frozen)).rejects.toThrow("connection lost");
  await api.send(JSON.parse(JSON.stringify(frozen)));
  expect(fetch.mock.calls[2]).toEqual(fetch.mock.calls[1]);
  expect(fetch.mock.calls[2]!.slice(0, 2)).toEqual([
    "POST",
    "/characters/hero/physical-rolls/throw/complete",
  ]);
  expect(fetch.mock.calls[2]![2].body).toEqual({ tick: 84, dice: [{ id: "die", value: 6 }] });
  expect(simulate).toHaveBeenCalledTimes(1);
});

it("uses the normal roll when the server reports an unsupported push", async () => {
  const fetch = vi.fn().mockResolvedValue({ attempt: null });
  const normal = {
    ...request,
    path: "/characters/hero/rolls/root/push",
    body: { idempotencyKey: "once", expectedRevision: 1 },
  };
  const simulate = vi.fn();
  expect(
    await preparePhysicalRequest({ fetch } as ApiClient, normal, new AbortController().signal, simulate),
  ).toBe(normal);
  expect(fetch.mock.calls[0]![2].body).toMatchObject({ kind: "pushRoll", parentRollId: "root" });
  expect(simulate).not.toHaveBeenCalled();
});

it("falls back to the ordinary roll when the physical throw cannot settle", async () => {
  const fetch = vi.fn().mockResolvedValue({
    attempt: { attemptId: "throw", launch: { version: "rapier-v1" } },
    serverTime: dates.firstAttemptAt,
  });
  const simulate = vi.fn().mockRejectedValue(Error("The dice did not settle cleanly."));
  const frozen = await preparePhysicalRequest({ fetch } as ApiClient, request, new AbortController().signal, simulate);
  expect(frozen).toBe(request);
  expect(frozen.physical).toBeUndefined();
});

it("still stops when the throw is cancelled", async () => {
  const fetch = vi.fn().mockResolvedValue({
    attempt: { attemptId: "throw", launch: { version: "rapier-v1" } },
    serverTime: dates.firstAttemptAt,
  });
  const controller = new AbortController();
  const simulate = vi.fn().mockImplementation(async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  await expect(preparePhysicalRequest({ fetch } as ApiClient, request, controller.signal, simulate)).rejects.toThrow();
});
