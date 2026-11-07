// web/src/display/DisplayView.test.tsx
// Task 7 RED: code entry redeems and renders the projection; entry purges
// ["campaigns", ...] GM state before the first projection fetch; revoked
// credentials blank with no GM chrome or GM endpoint calls.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISPLAY_CREDENTIAL_STORAGE_KEY,
  DisplayView,
} from "./DisplayView.js";

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

function projectionPayload(overrides: Record<string, unknown> = {}) {
  return {
    projection: {
      sceneId: "s1",
      sceneRevision: 3,
      imageUrl: "/displays/d1/scenes/s1/image?rev=3",
      tokens: [
        { tokenId: "t1", label: "Alpha", x: 0.25, y: 0.5, size: 1, imageUrl: null },
      ],
    },
    requestId: "r-projection",
    ...overrides,
  };
}

function failingApi() {
  return {
    redeemDisplay: vi.fn(),
    getDisplayProjection: vi.fn(),
    openCampaign: vi.fn(),
    openScene: vi.fn(),
  };
}

function renderDisplay(
  ui: ReactNode,
  client: QueryClient,
) {
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function seedCredential() {
  return {
    [DISPLAY_CREDENTIAL_STORAGE_KEY]: JSON.stringify({ displayId: "d1", secret: "s3cr3t" }),
  };
}

describe("DisplayView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(["redacted"],{type:"image/png"})}));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:redacted");
      static revokeObjectURL = vi.fn();
    });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
  it("fetches token art only with the display credential and blanks/revokes its URL on revocation", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    const payload = projectionPayload(); payload.projection.tokens = [{ tokenId:"t1",label:"Alpha",x:.25,y:.5,size:.12,imageUrl:"/displays/d1/scenes/s1/tokens/t1/image?rev=3" }] as never;
    api.getDisplayProjection.mockResolvedValue(payload);
    renderDisplay(<DisplayView api={api as never} sceneId="s1" online pollMs={50} storage={memoryStorage(seedCredential())} />, qc);
    await waitFor(() => expect(screen.getByText("Alpha").closest("li")?.querySelector("img")).not.toBeNull());
    const image = screen.getByText("Alpha").closest("li")!.querySelector("img")!;
    expect(image.closest("li")).toHaveStyle({width:"12%",left:"25%",top:"50%"});
    expect(fetch).toHaveBeenCalledWith("/api/displays/d1/scenes/s1/tokens/t1/image?rev=3", expect.objectContaining({credentials:"omit",headers:{"x-display-secret":"s3cr3t"}}));
    api.getDisplayProjection.mockRejectedValue({ status:404 });
    await screen.findByText(/this display is unavailable/i);
    expect(screen.queryByRole("img")).toBeNull(); expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it("redeems the entered code and renders the image with visible tokens", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // GM state that must not survive display entry.
    qc.setQueryData(["campaigns", "detail", "c1"], { campaign: { campaignId: "c1" } });
    const cancelSpy = vi.spyOn(qc, "cancelQueries");
    const removeSpy = vi.spyOn(qc, "removeQueries");
    const api = failingApi();
    api.redeemDisplay.mockResolvedValue({
      display: { displayId: "d1", secret: "s3cr3t" },
      requestId: "r-redeem",
    });
    api.getDisplayProjection.mockResolvedValue(projectionPayload());
    const storage = memoryStorage();

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={storage} />,
      qc,
    );

    // Entry purge drops GM cache and cancels in-flight campaign reads.
    await waitFor(() => expect(qc.getQueryData(["campaigns", "detail", "c1"])).toBeUndefined());
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ["campaigns"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["campaigns"] });

    await user.type(screen.getByLabelText(/display code/i), "AB12CD");
    await user.click(screen.getByRole("button", { name: /connect display/i }));
    expect(api.redeemDisplay).toHaveBeenCalledWith({ code: "AB12CD" });

    const image = await screen.findByRole("img", { name: /display image/i });
    expect(image).toHaveAttribute("src", "blob:redacted");
    expect(fetch).toHaveBeenCalledWith("/api/displays/d1/scenes/s1/image?rev=3",expect.objectContaining({headers:{"x-display-secret":"s3cr3t"},credentials:"omit"}));
    const alpha = await screen.findByText("Alpha");
    expect(alpha.closest("li")?.style.left).toBe("25%");
    expect(alpha.closest("li")?.style.top).toBe("50%");

    // The restricted shell never touches GM endpoints.
    expect(api.openCampaign).not.toHaveBeenCalled();
    expect(api.openScene).not.toHaveBeenCalled();
    // The credential persists for the reload path.
    expect(storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY)).toContain("d1");
  });

  it("purges GM state before the first projection fetch and revalidates on reload", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["campaigns", "detail", "c1"], { campaign: { campaignId: "c1" } });
    const removeSpy = vi.spyOn(qc, "removeQueries");
    const cancelSpy = vi.spyOn(qc, "cancelQueries");
    const api = failingApi();
    let resolveProjection!: (value: unknown) => void;
    api.getDisplayProjection.mockReturnValue(
      new Promise((resolve) => {
        resolveProjection = resolve as (value: unknown) => void;
      }),
    );
    const storage = memoryStorage(seedCredential());

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={storage} />,
      qc,
    );

    // Reload revalidates before rendering: connecting status, no image yet,
    // and the credential-scoped fetch already issued.
    expect(await screen.findByText(/connecting display/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    await waitFor(() => expect(api.getDisplayProjection).toHaveBeenCalledTimes(1));
    expect(api.getDisplayProjection).toHaveBeenCalledWith("d1", "s1", "s3cr3t");

    // The purge ran before that first fetch.
    expect(cancelSpy).toHaveBeenCalledWith({ queryKey: ["campaigns"] });
    expect(removeSpy).toHaveBeenCalledWith({ queryKey: ["campaigns"] });
    expect(qc.getQueryData(["campaigns", "detail", "c1"])).toBeUndefined();
    const purgeOrder = Math.min(
      ...(removeSpy.mock.invocationCallOrder as number[]),
    );
    const fetchOrder = Math.min(
      ...(api.getDisplayProjection.mock.invocationCallOrder as number[]),
    );
    expect(purgeOrder).toBeLessThan(fetchOrder);

    resolveProjection(projectionPayload());
    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    expect(api.openCampaign).not.toHaveBeenCalled();
  });

  it("blanks a revoked credential with no GM chrome or GM endpoint calls", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.getDisplayProjection.mockRejectedValue({ code: "not_found", status: 404, message: "gone" });
    const storage = memoryStorage(seedCredential());

    const { container } = renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={storage} />,
      qc,
    );

    expect(await screen.findByText(/this display is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    // No GM chrome: no links anywhere in the restricted shell.
    expect(container.querySelectorAll("a").length).toBe(0);
    expect(api.openCampaign).not.toHaveBeenCalled();
    expect(api.openScene).not.toHaveBeenCalled();
    expect(api.redeemDisplay).not.toHaveBeenCalled();

    // The operator can drop the dead credential and return to code entry.
    await user.click(screen.getByRole("button", { name: /enter a different code/i }));
    expect(screen.getByLabelText(/display code/i)).toBeVisible();
    expect(storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it("blanks the cached frame when revocation lands after a good frame", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.getDisplayProjection.mockResolvedValue(projectionPayload());
    // Revocation surfaces strictly as 404/not_found (backend Task 5
    // contract: every credential failure collapses to generic not_found).
    const storage = memoryStorage(seedCredential());

    const { container } = renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online pollMs={50} storage={storage} />,
      qc,
    );

    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    api.getDisplayProjection.mockRejectedValue({ code: "not_found", status: 404, message: "gone" });
    // The poll picks up revocation after an actually rendered frame: the
    // frozen frame must blank per §7.7, not linger behind a notice.
    expect(await screen.findByText(/this display is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelectorAll("a").length).toBe(0);

    await user.click(screen.getByRole("button", { name: /enter a different code/i }));
    expect(screen.getByLabelText(/display code/i)).toBeVisible();
    expect(storage.getItem(DISPLAY_CREDENTIAL_STORAGE_KEY)).toBeNull();
  });

  it("keeps the cached frame across transient non-404 poll failures", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.getDisplayProjection.mockResolvedValueOnce(projectionPayload());
    api.getDisplayProjection.mockRejectedValue({ status: 500, message: "boom" });

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online pollMs={50} storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    // Transient failure: the last good frame stays with a reconnecting
    // notice — only revocation (404/not_found) blanks.
    await waitFor(() => expect(screen.getByText(/reconnecting/i)).toBeVisible());
    expect(screen.getByRole("img", { name: /display image/i })).toBeVisible();
    expect(screen.queryByText(/this display is unavailable/i)).toBeNull();
  });

  it("blanks on the code-only revocation shape (no status attached)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    // The HTTP contract always carries code "not_found" for revoked
    // credentials; match it even when no numeric status is attached.
    api.getDisplayProjection.mockRejectedValue({ code: "not_found", message: "gone" });

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByText(/this display is unavailable/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    expect(api.openCampaign).not.toHaveBeenCalled();
  });

  it("shows reconnecting with retry when the projection poll fails", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.getDisplayProjection.mockRejectedValue({ status: 500, message: "boom" });

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByText(/reconnecting/i)).toBeVisible();
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(api.getDisplayProjection).toHaveBeenCalledTimes(2));
    expect(api.openCampaign).not.toHaveBeenCalled();
  });

  it("polls the projection while the credential is active", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.getDisplayProjection.mockResolvedValue(projectionPayload());

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online pollMs={50} storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByRole("img", { name: /display image/i })).toBeVisible();
    // First fetch (revision 0) adopts revision 3 and refetches; the interval
    // keeps polling after that, so an active display issues ongoing reads.
    await waitFor(() => expect(api.getDisplayProjection.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 5000,
    });
    expect(api.openCampaign).not.toHaveBeenCalled();
  });

  it("explains offline without fetching while offline", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online={false} storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByText(/you are offline/i)).toBeVisible();
    expect(api.getDisplayProjection).not.toHaveBeenCalled();
    expect(api.openCampaign).not.toHaveBeenCalled();
  });

  it("rejects an unknown code and stays on code entry", async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();
    api.redeemDisplay.mockRejectedValue({ code: "not_found", status: 404, message: "gone" });

    renderDisplay(
      <DisplayView api={api as never} sceneId="s1" online storage={memoryStorage()} />,
      qc,
    );

    await user.type(screen.getByLabelText(/display code/i), "ZZ99ZZ");
    await user.click(screen.getByRole("button", { name: /connect display/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not recognized/i);
    expect(api.getDisplayProjection).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/display code/i)).toBeVisible();
  });

  it("renders the empty state without fetching when no target is selected", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = failingApi();

    renderDisplay(
      <DisplayView api={api as never} sceneId="" online storage={memoryStorage(seedCredential())} />,
      qc,
    );

    expect(await screen.findByText(/no target selected/i)).toBeVisible();
    expect(api.getDisplayProjection).not.toHaveBeenCalled();
  });
});


it("hides an already rendered frame while offline", async () => {
  const qc = new QueryClient({defaultOptions:{queries:{retry:false}}});
  const api = failingApi(); api.getDisplayProjection.mockResolvedValue(projectionPayload());
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,blob:async()=>new Blob(["redacted"])}));
  vi.stubGlobal("URL",class extends URL { static createObjectURL=vi.fn(()=>"blob:offline-test"); static revokeObjectURL=vi.fn(); });
  try {
    const storage=memoryStorage(seedCredential());
    const {rerender}=renderDisplay(<DisplayView api={api as never} sceneId="s1" online storage={storage}/>,qc);
    expect(await screen.findByRole("img")).toBeVisible();
    rerender(<QueryClientProvider client={qc}><DisplayView api={api as never} sceneId="s1" online={false} storage={storage}/></QueryClientProvider>);
    expect(screen.queryByRole("img")).toBeNull();
    expect(await screen.findByText(/you are offline/i)).toBeVisible();
  } finally {cleanup(); vi.unstubAllGlobals();}
});
