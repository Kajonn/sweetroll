import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "../api/client.js";
import { useDraftSync } from "./draftSync.js";

type FetchMock = ReturnType<typeof vi.fn>;

function makeClient(fetch_: FetchMock) {
  return createApiClient({ baseUrl: "http://x", fetch: fetch_ as unknown as typeof fetch });
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function okSaveResponse(revision: number) {
  return new Response(
    JSON.stringify({
      workspace: {
        system: {
          systemId: "s1",
          name: "Test",
          access: "private",
          lifecycle: "active",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        draft: {
          revision,
          document: {},
          sourceChecksum: "abc",
          updatedBy: "u1",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        versions: [],
        assessment: { ok: true, diagnostics: [] },
      },
      requestId: "r",
    }),
    { status: 200 },
  );
}

function conflictResponse(latestRevision: number) {
  return new Response(
    JSON.stringify({
      error: {
        code: "conflict",
        message: "The draft was modified by another request.",
        latestRevision,
      },
      requestId: "r",
    }),
    { status: 409, headers: { "content-type": "application/json" } },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("useDraftSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts in idle status with no banner", () => {
    const fetch_ = vi.fn();
    const client = makeClient(fetch_);
    const { result } = renderHook(() => useDraftSync({ client, systemId: "s1" }), {
      wrapper: makeWrapper(),
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.banner).toBeNull();
  });

  it("debounces saves and only fires one PUT after debounceMs", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 30 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ a: 1 }, null);
      result.current.save({ a: 2 }, null);
      result.current.save({ a: 3 }, null);
    });
    expect(fetch_).not.toHaveBeenCalled();

    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(fetch_).toHaveBeenCalledTimes(1);
    const call = fetch_.mock.calls[0] as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ document: { a: 3 } });
  });

  it("uses a 600ms debounce by default", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(() => useDraftSync({ client, systemId: "s1" }), {
      wrapper: makeWrapper(),
    });

    act(() => {
      result.current.save({ a: 1 }, null);
    });
    expect(fetch_).not.toHaveBeenCalled();
    await sleep(500);
    expect(fetch_).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(fetch_).toHaveBeenCalledTimes(1);
  }, 5000);

  it("skips saves when the document hash is unchanged from the last successful save", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, null);
    });
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(fetch_).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 1);
    });
    await sleep(40);
    expect(fetch_).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.save({ metadata: { name: "Y" } }, 1);
    });
    await waitFor(() => expect(fetch_).toHaveBeenCalledTimes(2));
  });

  it("hashes are key-order-independent", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ a: 1, b: 2 }, null);
    });
    await waitFor(() => expect(result.current.status).toBe("saved"));

    act(() => {
      result.current.save({ b: 2, a: 1 }, 1);
    });
    await sleep(40);
    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it("surfaces a conflict banner on 409 and exposes keep-mine / merge / accept-theirs handlers", async () => {
    const fetch_ = vi.fn().mockResolvedValueOnce(conflictResponse(7));
    const client = makeClient(fetch_);
    const onAcceptTheirs = vi.fn();
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10, onAcceptTheirs }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));
    const banner = result.current.banner;
    expect(banner).not.toBeNull();
    if (banner === null) throw new Error("banner expected");
    expect(banner.latestRevision).toBe(7);
    expect(typeof banner.onAcceptTheirs).toBe("function");
    expect(typeof banner.onKeepMine).toBe("function");
    expect(typeof banner.onMergeIntoServer).toBe("function");
    expect(typeof banner.onDismiss).toBe("function");
  });

  it("keep-mine issues a fresh save with expectedRevision: null (force)", async () => {
    const fetch_ = vi.fn()
      .mockResolvedValueOnce(conflictResponse(7))
      .mockResolvedValueOnce(okSaveResponse(8));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    await act(async () => {
      banner.onKeepMine();
    });

    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(fetch_).toHaveBeenCalledTimes(2);
    const second = fetch_.mock.calls[1] as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(second?.[1]?.body as string)).toMatchObject({ expectedRevision: null });
    expect(result.current.banner).toBeNull();
  });

  it("merge-into-server saves with expectedRevision: latestRevision", async () => {
    const fetch_ = vi.fn()
      .mockResolvedValueOnce(conflictResponse(7))
      .mockResolvedValueOnce(okSaveResponse(8));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    await act(async () => {
      banner.onMergeIntoServer();
    });

    await waitFor(() => expect(result.current.status).toBe("saved"));
    const second = fetch_.mock.calls[1] as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(second?.[1]?.body as string)).toMatchObject({ expectedRevision: 7 });
  });

  it("merge-into-server uses the latest save()-ed document at click time", async () => {
    const fetch_ = vi.fn()
      .mockResolvedValueOnce(conflictResponse(7))
      .mockResolvedValueOnce(okSaveResponse(8));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    // User makes a further edit before clicking merge; save() updates latest document.
    act(() => {
      result.current.save({ metadata: { name: "Newer" } }, 5);
    });

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    await act(async () => {
      banner.onMergeIntoServer();
    });

    await waitFor(() => expect(result.current.status).toBe("saved"));
    const calls = fetch_.mock.calls as [string, RequestInit | undefined][];
    const lastCall = calls[calls.length - 1];
    expect(JSON.parse(lastCall?.[1]?.body as string)).toMatchObject({
      expectedRevision: 7,
      document: { metadata: { name: "Newer" } },
    });
  });

  it("accept-theirs clears the banner and notifies the parent", async () => {
    const fetch_ = vi.fn().mockResolvedValueOnce(conflictResponse(7));
    const client = makeClient(fetch_);
    const onAcceptTheirs = vi.fn();
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10, onAcceptTheirs }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    act(() => {
      banner.onAcceptTheirs();
    });
    expect(onAcceptTheirs).toHaveBeenCalledTimes(1);
    expect(result.current.banner).toBeNull();
    expect(result.current.status).toBe("idle");
  });

  it("dismiss clears the banner without other side effects", async () => {
    const fetch_ = vi.fn().mockResolvedValueOnce(conflictResponse(7));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, 5);
    });
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    act(() => {
      banner.onDismiss();
    });
    expect(result.current.banner).toBeNull();
    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it("treats non-409 errors as error status without surfacing a banner", async () => {
    const fetch_ = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "internal", message: "boom" }, requestId: "r" }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ metadata: { name: "X" } }, null);
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.banner).toBeNull();
    expect(result.current.error).toBeInstanceOf(ApiError);
  });

  it("flushes a pending save after a successful save with new content", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ a: 1 }, null);
    });
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(fetch_).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.save({ b: 1 }, 1);
    });
    await waitFor(() => expect(fetch_).toHaveBeenCalledTimes(2));
  });
});
