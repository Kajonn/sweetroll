import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import {
  POST_SIGNIN_STORAGE_KEY,
  storePostSigninPath,
  takePostSigninPath,
} from "../characters/identity.js";
import { createAppRouter } from "../router.js";
import { Account } from "./Account.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

function stubClient(me: () => Promise<Response>): ApiClient {
  return {
    fetch: (async (method: string, path: string) => {
      if (path === "/me/preferences" || method === "PATCH") {
        return { theme_default: null };
      }
      const response = await me();
      if (!response.ok) {
        throw new ApiError({
          code: response.status === 401 ? "unauthorized" : "forbidden",
          message: `Request failed: ${response.status}`,
          status: response.status,
          requestId: "r",
          latestRevision: null,
          diagnostics: [],
        });
      }
      return response.json() as Promise<unknown>;
    }) as ApiClient["fetch"],
  } as unknown as ApiClient;
}

function renderAccount(identity: { signOut: () => Promise<void> }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Account
        client={stubClient(async () => new Response(JSON.stringify({ state: "session_expired" })))}
        identity={{ getActorId: () => null, isOnline: () => true, signOut: identity.signOut }}
        storageUnavailable={false}
      />
    </QueryClientProvider>,
  );
}

function renderAt(path: string) {
  window.history.pushState({}, "", path);
  const router = createAppRouter();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

afterEach(() => {
  window.history.pushState({}, "", "/");
  try {
    sessionStorage.removeItem(POST_SIGNIN_STORAGE_KEY);
  } catch {
    // jsdom always provides sessionStorage; ignore otherwise.
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("expired session re-auth (G6 Task 6)", () => {
  it("renders the Account re-auth panel for a session_expired payload", async () => {
    renderAccount({ signOut: vi.fn(async () => {}) });
    expect(await screen.findByRole("heading", { name: "Session expired" })).toBeInTheDocument();
    expect(screen.getByTestId("account-reauth-mount")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("Sign in again stores the current path and returns to the sign-in entry", async () => {
    const signOut = vi.fn(async () => {});
    window.history.pushState({}, "", "/account");
    renderAccount({ signOut });
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in again" }));
    expect(sessionStorage.getItem(POST_SIGNIN_STORAGE_KEY)).toBe("/account");
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("takePostSigninPath consumes once and defaults invalid entries", () => {
    expect(takePostSigninPath()).toBe("/characters");
    storePostSigninPath("/activity");
    expect(takePostSigninPath()).toBe("/activity");
    expect(takePostSigninPath()).toBe("/characters");
    storePostSigninPath("https://evil.example.net/phish");
    expect(takePostSigninPath()).toBe("/characters");
  });

  it("/cb refreshes the session and restores the stored path", { timeout: 30000 }, async () => {
    sessionStorage.setItem(POST_SIGNIN_STORAGE_KEY, "/activity");
    const meCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        meCalls.push(url.pathname);
        return new Response(JSON.stringify({ state: "authenticated", userId: ACTOR }));
      }
      if (url.pathname === "/api/characters") {
        return new Response(
          JSON.stringify({ characters: [], nextCursor: null, requestId: "r" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      // Provider redirect params ride along but are never validated.
      const router = renderAt("/cb?code=provider-code&state=xyz");
      await waitFor(() => expect(router.state.location.pathname).toBe("/activity"), {
        timeout: 10_000,
      });
      // The return leg refreshed the session before navigating...
      expect(meCalls.length).toBeGreaterThan(0);
      // ...and consumed the stored path exactly once.
      expect(sessionStorage.getItem(POST_SIGNIN_STORAGE_KEY)).toBeNull();
      await waitFor(
        () => expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument(),
        { timeout: 10_000 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("/cb defaults to /characters with nothing stored", { timeout: 30000 }, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") {
        return new Response(JSON.stringify({ state: "authenticated", userId: ACTOR }));
      }
      if (url.pathname === "/api/characters") {
        return new Response(
          JSON.stringify({ characters: [], nextCursor: null, requestId: "r" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    try {
      const router = renderAt("/cb");
      await waitFor(() => expect(router.state.location.pathname).toBe("/characters"), {
        timeout: 10_000,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
