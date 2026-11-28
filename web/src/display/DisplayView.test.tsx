// web/src/display/DisplayView.test.tsx
// Display shell over the live scene stream: code entry redeems and renders
// streamed snapshots; entry purges ["campaigns", ...] GM state before the
// stream opens; disconnects and revocation blank the frame; image-revision
// changes clear the map until the new redacted bytes arrive.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISPLAY_CREDENTIAL_STORAGE_KEY, DisplayView } from "./DisplayView.js";
import type { SceneStreamFactory, SceneStreamHandlers, SceneStreamOptions } from "./sceneStream.js";
import type { DisplayProjection } from "../campaigns/types.js";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
  };
}

function projection(overrides: Partial<DisplayProjection> = {}): DisplayProjection {
  return {
    sceneId: "s1",
    sceneRevision: 3,
    imageRevision: 2,
    imageUrl: "/displays/d1/scenes/s1/image?rev=2",
    tokens: [{ tokenId: "t1", label: "Alpha", x: 0.25, y: 0.5, size: 1, imageUrl: null }],
    ...overrides,
  };
}

/** Controllable stand-in for the fetch-based SSE client. */
function fakeStreams() {
  const opened: Array<{ options: SceneStreamOptions; handlers: SceneStreamHandlers; closed: boolean; retries: number }> = [];
  const factory: SceneStreamFactory = vi.fn((options, handlers) => {
    const entry = { options, handlers, closed: false, retries: 0 };
    opened.push(entry);
    return {
      close: () => {
        entry.closed = true;
      },
      retryNow: () => {
        entry.retries += 1;
      },
    };
  });
  const current = () => opened.at(-1)!;
  return {
    factory,
    opened,
    snapshot(value: DisplayProjection) {
      act(() => {
        current().handlers.onSnapshot(value);
        current().handlers.onStatus("open");
      });
    },
    status(value: Parameters<SceneStreamHandlers["onStatus"]>[0]) {
      act(() => current().handlers.onStatus(value));
    },
  };
}

function api() {
  return { redeemDisplay: vi.fn(), openCampaign: vi.fn(), openScene: vi.fn() };
}

function renderDisplay(ui: ReactNode, client: QueryClient) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function seedCredential() {
  return { [DISPLAY_CREDENTIAL_STORAGE_KEY]: JSON.stringify({ displayId: "d1", secret: "s3cr3t" }) };
}

type Deferred = { resolve(value: unknown): void };

describe("DisplayView", () => {
  let pendingImages: Map<string, Deferred[]>;
  let blobCount: number;
  beforeEach(() => {
    pendingImages = new Map();
    blobCount = 0;
    // Image bytes resolve immediately unless a test holds them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({ ok: true, blob: async () => new Blob([url], { type: "image/png" }) })),
    );
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${++blobCount}`);
        static revokeObjectURL = vi.fn();
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const qc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  it("redeems the entered code, purges GM state first and renders streamed snapshots", async () => {
    const user = userEvent.setup();
    const client = qc();
    client.setQueryData(["campaigns", "detail", "c1"], { campaign: { campaignId: "c1" } });
    const removeSpy = vi.spyOn(client, "removeQueries");
    const cancelSpy = vi.spyOn(client, "cancelQueries");
    const a = api();
    a.redeemDisplay.mockResolvedValue({ display: { displayId: "d1", secret: "s3cr3t" }, requestId: "r" });
    const streams = fakeStreams();
    const storage = memoryStorage();

    renderDisplay(<DisplayView api={a as never} sceneId="s1" online storage={storage} openSceneStream={streams.factory} />, client);
    await waitFor(() => expect(client.getQueryData(["campaigns", "detail", "c1"])).toBeUndefined());
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ["campaigns"] });
    expect(streams.opened).toHaveLength(0);

    await user.type(screen.getByLabelText(/display code/i), "AB12CD");
    await user.click(screen.getByRole("button", { name: /connect display/i }));
    expect(a.redeemDisplay).toHaveBeenCalledWith({ code: "AB12CD" });
    await waitFor(() => expect(streams.opened).toHaveLength(1));
    expect(streams.opened[0]!.options).toMatchObject({ displayId: "d1", sceneId: "s1", secret: "s3cr3t" });
    expect(Math.min(...removeSpy.mock.invocationCallOrder)).toBeLessThan(
      (streams.factory as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByText(/connecting display/i)).toBeVisible();

    streams.snapshot(projection());
    const image = await screen.findByRole("img", { name: /display image/i });
    expect(image.getAttribute("src")).toMatch(/^blob:/);
    expect(await screen.findByText("Alpha")).toBeVisible();
    expect(fetch).toHaveBeenCalledWith(
      "/api/displays/d1/scenes/s1/image?rev=2",
      expect.objectContaining({ credentials: "omit", headers: { "x-display-secret": "s3cr3t" } }),
    );
    expect(storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY)).toContain("d1");
    expect(a.openCampaign).not.toHaveBeenCalled();
    expect(a.openScene).not.toHaveBeenCalled();
  });

  it("closes the stream on page hide and opens a fresh one when the page is restored", () => {
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());

    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(streams.opened[0]?.closed).toBe(true);

    act(() => window.dispatchEvent(new Event("pageshow")));
    expect(streams.opened).toHaveLength(1);
    act(() => window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    expect(streams.opened).toHaveLength(2);
    expect(streams.opened[1]?.options).toEqual(streams.opened[0]?.options);
  });

  it("moves tokens on the current map without downloading the map again", async () => {
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    const art = "/displays/d1/scenes/s1/tokens/t1/image?file=f-1";
    streams.snapshot(projection({ tokens: [{ tokenId: "t1", label: "Alpha", x: 0.25, y: 0.5, size: 0.12, imageUrl: art }] }));
    await waitFor(() => expect(screen.getByText("Alpha").closest("li")?.querySelector("img")).not.toBeNull());
    const mapImage = screen.getByRole("img", { name: /display image/i });
    const mapCalls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes("/image?rev=")).length;
    const artCalls = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).includes("?file=")).length;
    expect([mapCalls(), artCalls()]).toEqual([1, 1]);

    streams.snapshot(projection({ sceneRevision: 4, tokens: [{ tokenId: "t1", label: "Alpha", x: 0.6, y: 0.4, size: 0.12, imageUrl: art }] }));
    await waitFor(() => expect(screen.getByText("Alpha").closest("li")).toHaveStyle({ left: "60%", top: "40%" }));
    // Same map element, no new map or token-art download.
    expect(screen.getByRole("img", { name: /display image/i })).toBe(mapImage);
    expect([mapCalls(), artCalls()]).toEqual([1, 1]);
  });

  it("clears the frame on an image revision change and shows the new map only after it loads", async () => {
    const holds: Deferred[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: { signal: AbortSignal }) =>
        url.endsWith("rev=2")
          ? Promise.resolve({ ok: true, blob: async () => new Blob(["old"]) })
          : new Promise((resolve, reject) => {
              holds.push({ resolve });
              init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }),
      ),
    );
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    streams.snapshot(projection());
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();

    streams.snapshot(projection({ sceneRevision: 4, imageRevision: 3, imageUrl: "/displays/d1/scenes/s1/image?rev=3" }));
    // Old frame and its tokens are gone immediately.
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText(/connecting display/i)).toBeVisible();

    await act(async () => {
      holds[0]!.resolve({ ok: true, blob: async () => new Blob(["new-map"]) });
    });
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    expect(screen.getByText("Alpha")).toBeVisible();
  });

  it("never shows a superseded map when a conceal lands while the previous image is loading", async () => {
    const holds = new Map<string, Deferred>();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (url: string) =>
          new Promise((resolve) => {
            holds.set(url, { resolve });
          }),
      ),
    );
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    // Reveal (rev 2) starts loading, then a conceal (rev 3) supersedes it.
    streams.snapshot(projection({ imageRevision: 2, imageUrl: "/displays/d1/scenes/s1/image?rev=2" }));
    await waitFor(() => expect(holds.has("/api/displays/d1/scenes/s1/image?rev=2")).toBe(true));
    streams.snapshot(projection({ sceneRevision: 4, imageRevision: 3, imageUrl: "/displays/d1/scenes/s1/image?rev=3", tokens: [] }));
    await waitFor(() => expect(holds.has("/api/displays/d1/scenes/s1/image?rev=3")).toBe(true));

    // The superseded (more revealing) response arrives late: never adopted.
    await act(async () => {
      holds.get("/api/displays/d1/scenes/s1/image?rev=2")!.resolve({ ok: true, blob: async () => new Blob(["revealing-old-frame"]) });
    });
    expect(screen.queryByRole("img")).toBeNull();
    const signal = ((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    await act(async () => {
      holds.get("/api/displays/d1/scenes/s1/image?rev=3")!.resolve({ ok: true, blob: async () => new Blob(["concealed"]) });
    });
    const shown = await screen.findByRole("img", { name: /display image/i });
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect((URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0].size).toBe("concealed".length);
    expect(shown).toBeVisible();
  });

  it("blanks the frame on disconnect and restores it from the next snapshot", async () => {
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    streams.snapshot(projection());
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    streams.status("reconnecting");
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(await screen.findByText(/reconnecting/i)).toBeVisible();
    streams.snapshot(projection({ sceneRevision: 5 }));
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
  });

  it("blanks a revoked credential, stops automatic retries and only retries on request", async () => {
    const user = userEvent.setup();
    const streams = fakeStreams();
    const storage = memoryStorage(seedCredential());
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={storage} openSceneStream={streams.factory} />, qc());
    streams.snapshot(projection());
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    streams.status("revoked");
    expect(await screen.findByText(/this display is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(streams.opened).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(streams.opened[0]!.retries).toBe(1);
    await user.click(screen.getByRole("button", { name: /different code/i }));
    expect(streams.opened[0]!.closed).toBe(true);
    expect(storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY)).toBeNull();
    expect(screen.getByLabelText(/display code/i)).toBeVisible();
  });

  it("closes the stream and hides the frame while offline", async () => {
    const streams = fakeStreams();
    const storage = memoryStorage(seedCredential());
    const client = qc();
    const { rerender } = renderDisplay(<DisplayView api={api() as never} sceneId="s1" online storage={storage} openSceneStream={streams.factory} />, client);
    streams.snapshot(projection());
    expect(await screen.findByRole("img")).toBeVisible();
    rerender(
      <QueryClientProvider client={client}>
        <DisplayView api={api() as never} sceneId="s1" online={false} storage={storage} openSceneStream={streams.factory} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(await screen.findByText(/you are offline/i)).toBeVisible();
    expect(streams.opened[0]!.closed).toBe(true);
    rerender(
      <QueryClientProvider client={client}>
        <DisplayView api={api() as never} sceneId="s1" online storage={storage} openSceneStream={streams.factory} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(streams.opened).toHaveLength(2));
  });

  it("does not open a stream while offline or without a target", async () => {
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={api() as never} sceneId="s1" online={false} storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    expect(await screen.findByText(/you are offline/i)).toBeVisible();
    cleanup();
    renderDisplay(<DisplayView api={api() as never} sceneId="" online storage={memoryStorage(seedCredential())} openSceneStream={streams.factory} />, qc());
    expect(await screen.findByText(/no target selected/i)).toBeVisible();
    expect(streams.opened).toHaveLength(0);
  });

  it("rejects an unknown code and stays on code entry", async () => {
    const user = userEvent.setup();
    const a = api();
    a.redeemDisplay.mockRejectedValue({ code: "not_found", status: 404, message: "gone" });
    const streams = fakeStreams();
    renderDisplay(<DisplayView api={a as never} sceneId="s1" online storage={memoryStorage()} openSceneStream={streams.factory} />, qc());
    await user.type(screen.getByLabelText(/display code/i), "ZZ99ZZ");
    await user.click(screen.getByRole("button", { name: /connect display/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not recognized/i);
    expect(streams.opened).toHaveLength(0);
    expect(screen.getByLabelText(/display code/i)).toBeVisible();
  });
});
