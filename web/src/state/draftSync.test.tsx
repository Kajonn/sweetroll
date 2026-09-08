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

  it("surfaces a conflict banner with explicit replace/reload actions and no merge action", async () => {
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
    expect(typeof banner.onDismiss).toBe("function");
    // A whole-document overwrite must never be offered as a merge.
    expect("onMergeIntoServer" in banner).toBe(false);
  });

  it("keep-mine replaces against the conflict revision instead of sending null", async () => {
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
    expect(JSON.parse(second?.[1]?.body as string)).toMatchObject({ expectedRevision: 7 });
    expect(result.current.banner).toBeNull();
  });

  it("keep-mine uses the latest save()-ed document at click time", async () => {
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

    // User makes a further edit before clicking keep-mine; save() updates latest document.
    act(() => {
      result.current.save({ metadata: { name: "Newer" } }, 5);
    });

    const banner = result.current.banner;
    if (banner === null) throw new Error("banner expected");
    await act(async () => {
      banner.onKeepMine();
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

  it("serializes an edit made during a slow save against the fresh revision", async () => {
    // Emulates the server revision check: only the current revision is accepted.
    let revision = 5;
    let calls = 0;
    let releaseFirst!: (response: Response) => void;
    const firstGate = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    const fetch_ = vi.fn(async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(init?.body as string) as { expectedRevision: number | null; document: unknown };
      if (calls === 1) {
        // The slow first save still goes through the revision check on completion.
        const response = await firstGate;
        if (body.expectedRevision !== revision) return conflictResponse(revision);
        revision += 1;
        return response;
      }
      if (body.expectedRevision !== revision) return conflictResponse(revision);
      revision += 1;
      return okSaveResponse(revision);
    });
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ v: 1 }, 5);
    });
    await waitFor(() => expect(fetch_).toHaveBeenCalledTimes(1));

    // Edit while the first save is still in flight, then let it complete.
    // The follow-up must go out once, with the newest document against the
    // revision the completed save produced — never a stale-revision 409.
    act(() => {
      result.current.save({ v: 2 }, 5);
    });
    releaseFirst(okSaveResponse(6));

    await waitFor(() => expect(result.current.status).toBe("saved"));
    await waitFor(() => expect(fetch_).toHaveBeenCalledTimes(2));
    expect(result.current.banner).toBeNull();
    const second = fetch_.mock.calls[1] as [string, RequestInit | undefined] | undefined;
    expect(JSON.parse(second?.[1]?.body as string)).toMatchObject({
      expectedRevision: 6,
      document: { v: 2 },
    });
  });

  it("cancel drops a debounced save and stashed edits", async () => {
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ a: 1 }, null);
      result.current.cancel();
    });
    await sleep(40);
    expect(fetch_).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("unmount with a pending debounced save sends no PUT after unmount", async () => {
    // Route change with pending work: the debounce timer is dropped on
    // unmount, so nothing goes out after the editor is gone.
    const fetch_ = vi.fn(async () => okSaveResponse(1));
    const client = makeClient(fetch_);
    const { result, unmount } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 50 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ a: 1 }, null);
    });
    unmount();
    await sleep(150);
    expect(fetch_).not.toHaveBeenCalled();
  });

  it("unmount with an in-flight save ignores the late resolution", async () => {
    // The PUT already on the wire cannot be recalled, but its late response
    // must commit no state and flush no follow-up PUT for the stashed edit.
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch_ = vi.fn(async () => gate);
    const client = makeClient(fetch_);
    const { result, unmount } = renderHook(
      () => useDraftSync({ client, systemId: "s1", debounceMs: 10 }),
      { wrapper: makeWrapper() },
    );

    act(() => {
      result.current.save({ v: 1 }, 5);
    });
    await waitFor(() => expect(fetch_).toHaveBeenCalledTimes(1));
    // Edit stashed while the first save is in flight, then route away.
    act(() => {
      result.current.save({ v: 2 }, 5);
    });
    unmount();
    release(okSaveResponse(6));
    await sleep(80);
    expect(fetch_).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("saving");
    expect(result.current.banner).toBeNull();
  });
});
