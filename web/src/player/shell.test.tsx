import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../api/client.js";
import type { ActivityResponse } from "../characters/types.js";
import { createAppRouter } from "../router.js";
import { AppShell } from "../shell/AppShell.js";
import styles from "../shell/AppShell.module.css";
import { Account } from "./Account.js";
import { isOnboardingComplete, onboardingKey } from "./Onboarding.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

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

function renderShell(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(impl: FetchStub) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function meResponse(state: { state: string; userId?: string }, status = 200): Response {
  return new Response(JSON.stringify(state), { status });
}

function libraryPage(names: string[], nextCursor: string | null = null): Response {
  return new Response(
    JSON.stringify({
      characters: names.map((name, index) => ({
        characterId: `char-${index}`,
        name,
        entityDefinitionId: "character",
        systemVersionId: "11111111-1111-4000-8000-000000000001",
        revision: 1,
        lifecycle: "active",
        updatedAt: "2026-09-09T00:00:00.000Z",
      })),
      nextCursor,
      requestId: "r-lib",
    }),
    { status: 200 },
  );
}

function activityPage(
  events: Array<{ id: string; characterRevision: number; occurredAt: string; kind?: string }>,
): ActivityResponse {
  return {
    events: events.map(event => ({
      id: event.id,
      characterRevision: event.characterRevision,
      kind: event.kind ?? "set",
      payload: {},
      rollId: null,
      requestId: "r",
      occurredAt: event.occurredAt,
    })),
    nextCursor: null,
    requestId: "r",
  } as unknown as ActivityResponse;
}

function clearOnboardingFlags() {
  for (const key of ["anonymous", ACTOR]) {
    window.localStorage.removeItem(onboardingKey(key === "anonymous" ? null : key));
  }
}

afterEach(() => {
  window.history.pushState({}, "", "/");
  clearOnboardingFlags();
  window.localStorage.removeItem("sweetroll:pwa-install-dismissed");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function anonymousFetch(): FetchStub {
  return async (input: string | URL | Request) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/me") return meResponse({ state: "anonymous" });
    return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
  };
}

describe("player shell routes and first-run (G6 Task 3)", () => {
  it("anonymous first-run routes to /welcome with create-first-character entry", { timeout: 30000 }, async () => {
    clearOnboardingFlags();
    const restore = stubFetch(anonymousFetch());
    try {
      renderAt("/characters");
      // TODAY: fails — no /welcome, no flag
      await waitFor(
        () => expect(screen.getByRole("heading", { name: /welcome/i })).toBeInTheDocument(),
        { timeout: 10_000 },
      );
      const entry = screen.getByRole("link", { name: /create.*first.*character/i });
      expect(entry).toHaveAttribute("href", "/characters/new");
      expect(isOnboardingComplete(null)).toBe(false);
    } finally {
      restore();
    }
  });

  it("anonymous returning visitors see the sign-in prompt instead of welcome", { timeout: 30000 }, async () => {
    window.localStorage.setItem(onboardingKey(null), "1");
    const restore = stubFetch(anonymousFetch());
    try {
      renderAt("/characters");
      await waitFor(
        () => expect(screen.getByText(/sign in to open this character/i)).toBeInTheDocument(),
        { timeout: 10_000 },
      );
      expect(screen.queryByRole("heading", { name: /welcome/i })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("/welcome dismiss persists the per-actor flag", { timeout: 30000 }, async () => {
    const restore = stubFetch(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") return meResponse({ state: "authenticated", userId: ACTOR });
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    try {
      renderAt("/welcome");
      await waitFor(
        () => expect(screen.getByRole("heading", { name: /welcome/i })).toBeInTheDocument(),
        { timeout: 10_000 },
      );
      // Wait for the identity gate to settle: the welcome renders before
      // /me resolves, and dismiss must persist the per-actor flag.
      await screen.findByRole("button", { name: "Sign out" }, { timeout: 10_000 });
      expect(window.localStorage.getItem(onboardingKey(ACTOR))).toBeNull();
      await userEvent.setup().click(screen.getByRole("button", { name: /continue/i }));
      expect(window.localStorage.getItem(onboardingKey(ACTOR))).toBe("1");
      expect(screen.getByRole("link", { name: /view.*library/i })).toHaveAttribute("href", "/characters");
    } finally {
      restore();
    }
  });

  it("phone bottom nav has Characters/Activity/Account", { timeout: 30000 }, async () => {
    const restore = stubFetch(async () => meResponse({ state: "authenticated", userId: ACTOR }));
    try {
      renderShell(<AppShell><span data-testid="child">x</span></AppShell>);
      await screen.findByRole("button", { name: "Sign out" }, { timeout: 10_000 });
      // render AppShell at 360px, expect three nav links with bottom-nav landmark
      const nav = screen.getByTestId("player-bottom-nav");
      expect(nav.tagName.toLowerCase()).toBe("nav");
      expect(within(nav).getByRole("link", { name: "Characters" })).toHaveAttribute("href", "/characters");
      expect(within(nav).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
      expect(within(nav).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
      const css = readFileSync(join(process.cwd(), "src/shell/AppShell.module.css"), "utf8");
      expect(css).toMatch(/@media\s*\(\s*max-width\s*:\s*599px\s*\)/);
      expect(css).toMatch(/env\(safe-area-inset-bottom\)/);
      expect(css).toMatch(/min-height\s*:\s*44px/);
    } finally {
      restore();
    }
  });
});

describe("PersonalActivity fan-out (G6 Task 3)", () => {
  function activityFetch(): { restore: () => void; calls: string[] } {
    const calls: string[] = [];
    const restore = stubFetch(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") return meResponse({ state: "authenticated", userId: ACTOR });
      if (url.pathname === "/api/characters") return libraryPage(["Aria", "Bram", "Cora"]);
      const activityMatch = url.pathname.match(/^\/api\/characters\/(char-\d+)\/activity$/);
      if (activityMatch?.[1] !== undefined) {
        const matched = activityMatch[1];
        calls.push(matched);
        const index = Number(matched.split("-")[1]);
        return new Response(
          JSON.stringify(
            activityPage([
              { id: `ev-${index}`, characterRevision: index + 1, occurredAt: `2026-09-0${index + 1}T00:00:00.000Z` },
            ]),
          ),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    return { restore, calls };
  }

  it("merges per-character activity newest-first with links to sheets", { timeout: 30000 }, async () => {
    const { restore, calls } = activityFetch();
    try {
      renderAt("/activity");
      await waitFor(
        () => expect(screen.getByRole("heading", { name: "Activity" })).toBeInTheDocument(),
        { timeout: 10_000 },
      );
      await waitFor(() => expect(calls).toHaveLength(3), { timeout: 10_000 });
      const items = await screen.findAllByTestId(/^activity-item-/, undefined, { timeout: 10_000 });
      expect(items).toHaveLength(3);
      // Newest first: Cora (09-03) before Bram (09-02) before Aria (09-01).
      const [first, , last] = items;
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      expect(first).toHaveTextContent("Cora");
      expect(last).toHaveTextContent("Aria");
      expect(within(first as HTMLElement).getByRole("link", { name: "Open Cora" })).toHaveAttribute("href", "/characters/char-2");
    } finally {
      restore();
    }
  });

  it("bounds fan-out to the first page and shows the shared empty state", { timeout: 30000 }, async () => {
    const names = Array.from({ length: 12 }, (_, index) => `Hero ${index}`);
    const calls: string[] = [];
    const restore = stubFetch(async (input: string | URL | Request) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/me") return meResponse({ state: "authenticated", userId: ACTOR });
      if (url.pathname === "/api/characters") return libraryPage(names);
      const activityMatch = url.pathname.match(/^\/api\/characters\/(char-\d+)\/activity$/);
      if (activityMatch?.[1] !== undefined) {
        calls.push(activityMatch[1]);
        return new Response(JSON.stringify(activityPage([])), { status: 200 });
      }
      return new Response(JSON.stringify({ systems: [], nextCursor: null, requestId: "r" }), { status: 200 });
    });
    try {
      renderAt("/activity");
      await waitFor(() => expect(calls.length).toBeGreaterThan(0), { timeout: 10_000 });
      await waitFor(() => expect(screen.getByText("No activity yet.")).toBeInTheDocument(), { timeout: 10_000 });
      // Bounded: max 10 characters, first page only.
      expect(calls.length).toBeLessThanOrEqual(10);
    } finally {
      restore();
    }
  });
});

describe("Account screen (G6 Task 3)", () => {
  function stubClient(me: () => Promise<Response>): ApiClient {
    return {
      fetch: (async (_method: string, _path: string) => {
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

  function stubIdentity() {
    return {
      getActorId: () => ACTOR,
      isOnline: () => true,
      signOut: vi.fn(async () => {}),
    };
  }

  function renderAccount(options?: {
    me?: () => Promise<Response>;
    storageUnavailable?: boolean;
    online?: boolean;
  }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const identity = stubIdentity();
    if (options?.online === false) identity.isOnline = () => false;
    render(
      <QueryClientProvider client={qc}>
        <Account
          client={stubClient(options?.me ?? (async () => meResponse({ state: "authenticated", userId: ACTOR })))}
          identity={identity}
          storageUnavailable={options?.storageUnavailable ?? false}
        />
      </QueryClientProvider>,
    );
    return identity;
  }

  it("shows the useMe profile with locale, current session, and the theme mount point", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAccount();
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
    expect(await screen.findByText(ACTOR)).toBeInTheDocument();
    expect(screen.getByText(/locale/i)).toBeInTheDocument();
    expect(screen.getByText(/this device/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // Task 4 owns the theme-default control; this task only provides the mount.
    expect(screen.getByTestId("account-theme-section")).toBeInTheDocument();
  });

  it("renders a loading skeleton while the profile loads", () => {
    renderAccount({ me: () => new Promise<Response>(() => {}) });
    expect(screen.getByTestId("account-loading")).toBeInTheDocument();
  });

  it("renders the empty state when the profile has no fields", async () => {
    renderAccount({ me: async () => meResponse({ state: "anonymous" }) });
    expect(await screen.findByText("No profile details are available.")).toBeInTheDocument();
  });

  it("renders the sign-in prompt on permission-denied (403)", async () => {
    renderAccount({ me: async () => new Response("forbidden", { status: 403 }) });
    await waitFor(
      () => expect(screen.getByText(/sign in to open this character/i)).toBeInTheDocument(),
    );
  });

  it("renders the storage-unavailable pattern when the store cannot open", async () => {
    renderAccount({ storageUnavailable: true });
    expect(await screen.findByText(/offline character storage is unavailable/i)).toBeInTheDocument();
  });

  it("mounts the Task 6 re-auth entry on expired session (401)", async () => {
    renderAccount({ me: async () => new Response("unauthorized", { status: 401 }) });
    // Mount point only — re-auth behavior lands in Task 6.
    expect(await screen.findByTestId("account-reauth-mount")).toBeInTheDocument();
  });

  it("reuses the offline texts for storage/sync/recovery guidance", async () => {
    renderAccount();
    await screen.findByText(ACTOR);
    expect(screen.getByText("Online")).toBeInTheDocument();
    expect(screen.getByText("Open a character to archive or recover it.")).toBeInTheDocument();
  });

  it("signs out through the existing session with confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const identity = renderAccount();
    await screen.findByText(ACTOR);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/unsynchronized/i));
    expect(identity.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("PWA install prompt (G6 Task 3)", () => {
  it("captures beforeinstallprompt into a shared Install button with persisted dismiss", { timeout: 30000 }, async () => {
    const restore = stubFetch(async () => meResponse({ state: "authenticated", userId: ACTOR }));
    try {
      renderShell(<AppShell><span data-testid="child">x</span></AppShell>);
      await screen.findByRole("button", { name: "Sign out" }, { timeout: 10_000 });
      expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
      window.dispatchEvent(new Event("beforeinstallprompt"));
      expect(await screen.findByRole("button", { name: "Install" })).toBeVisible();
      await userEvent.setup().click(screen.getByRole("button", { name: "Not now" }));
      expect(window.localStorage.getItem("sweetroll:pwa-install-dismissed")).toBe("1");
      expect(screen.queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("keeps the bottom-nav CSS on semantic tokens with no fixed positioning", () => {
    const css = readFileSync(join(process.cwd(), "src/shell/AppShell.module.css"), "utf8");
    const start = css.indexOf(".bottomNav");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(css).toMatch(/position\s*:\s*sticky/);
    expect(css.slice(css.indexOf(".bottomNav"))).not.toMatch(/position\s*:\s*fixed/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
