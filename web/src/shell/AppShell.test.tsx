import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";

import { createApiClient } from "../api/client.js";
import { DocumentEditor } from "../editor/DocumentEditor.js";
import { registerLocale, resetLocale } from "../i18n/index.js";
import { defaultMessages } from "../i18n/messages.js";
import { queryClient } from "../queryClient.js";
import { AppShell, useAuth } from "./AppShell.js";
import styles from "./AppShell.module.css";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("AppShell", () => {
  it("keeps real dev sign-in working when character IndexedDB cannot open", async () => {
    vi.stubEnv("MODE", "development");
    vi.spyOn(indexedDB, "open").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    let signedIn = false;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      paths.push(new URL(url, window.location.origin).pathname);
      if (url === "/dev/signin") { signedIn = true; return new Response("{}"); }
      return new Response(JSON.stringify(signedIn ? { state: "authenticated", userId: "real-without-idb" } : { state: "anonymous" }));
    }));
    function Identity() { const auth = useAuth(); return <p>{auth.state === "authenticated" ? auth.userId : auth.state}</p>; }
    render(<AppShell><Identity /></AppShell>);
    expect(await screen.findByText(/offline character storage is unavailable/i)).toBeInTheDocument();
    await userEvent.setup().click(await screen.findByTestId("dev-signin"));
    expect(await screen.findByText("real-without-idb")).toBeInTheDocument();
    expect(paths).toEqual(["/api/me", "/dev/signin", "/api/me"]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText(/local sign-out could not be saved/i)).toBeInTheDocument();
    expect(paths.at(-1)).toBe("/api/signout");
  });
  it("preserves dev sign-in but verifies me instead of inventing an account", async () => {
    vi.stubEnv("MODE", "development");
    let signedIn = false;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      paths.push(new URL(url, window.location.origin).pathname);
      if (url === "/dev/signin") { signedIn = true; return new Response("{}"); }
      return new Response(JSON.stringify(signedIn ? { state: "authenticated", userId: "real-dev-account" } : { state: "anonymous" }));
    }));
    function Identity() { const auth = useAuth(); return <p>{auth.state === "authenticated" ? auth.userId : auth.state}</p>; }
    render(<AppShell><Identity /></AppShell>);
    await userEvent.setup().click(await screen.findByTestId("dev-signin"));
    expect(await screen.findByText("real-dev-account")).toBeInTheDocument();
    expect(paths).toEqual(["/api/me", "/dev/signin", "/api/me"]);
  });

  it("warns before clearing edits and distinguishes pending server signout", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/signout")
      ? new Promise<Response>(resolve => { finish = resolve; })
      : new Response(JSON.stringify({ state: "authenticated", userId: "signed-in" }))));
    render(<AppShell>builder</AppShell>);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringMatching(/unsynchronized/i));
    expect(await screen.findByText(/server sign-out is pending/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish(new Response(null, { status: 204 }));
    expect(await screen.findByText("Signed out.")).toBeInTheDocument();
  });
  it("passes the real me identity through AuthProvider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ state: "authenticated", userId: "actual-account" }))));
    function Identity() { const auth = useAuth(); return <p>{auth.state === "authenticated" ? auth.userId : auth.state}</p>; }
    render(<AppShell><Identity /></AppShell>);
    expect(screen.queryByText("dev")).not.toBeInTheDocument();
    expect(await screen.findByText("actual-account")).toBeInTheDocument();
  });
  it("renders header, main, and footer landmarks", () => {
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("Online");
  });

  it("renders children in the main region", async () => {
    render(<AppShell><span data-testid="child">x</span></AppShell>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("cancels and clears account-scoped queries on sign-out", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/signout")
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ state: "authenticated", userId: "signed-in" }))));
    const qc = queryClient;
    qc.clear();
    render(<AppShell>builder</AppShell>);
    // Seed previous-identity cache entries only after sign-in settles, so the
    // sign-in lifetime change cannot clear them vacuously.
    await screen.findByRole("button", { name: "Sign out" });
    qc.setQueryData(["me"], { state: "authenticated", userId: "signed-in" });
    qc.setQueryData(["system", "library"], { pages: [] });
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Signed out.");
    await vi.waitFor(() => {
      expect(qc.getQueryData(["me"])).toBeUndefined();
      expect(qc.getQueryData(["system", "library"])).toBeUndefined();
    });
    qc.clear();
  });

  it("unmounts the system editor on sign-out with no system data or further fetches", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path === "/api/signout") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ state: "authenticated", userId: "user-a" }));
    }));
    const doc = (name: string) => ({
      schemaVersion: "1.0",
      metadata: { name, description: "d", language: "en", defaultDice: "d20" },
      entities: [],
      referenceData: [],
      sheets: [],
      expressions: [],
      actions: [],
      validations: [],
    });
    let revision = 1;
    let gets = 0;
    let puts = 0;
    const workspace = () => ({
      system: {
        systemId: "s1",
        name: "Secret System",
        access: "private",
        lifecycle: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      draft: {
        revision,
        document: doc("Secret System"),
        sourceChecksum: "c",
        updatedBy: "user-a",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      versions: [],
      assessment: { ok: true, diagnostics: [] },
    });
    const editorFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.endsWith("/draft")) {
        puts += 1;
        revision += 1;
        return new Response(JSON.stringify({ workspace: workspace(), requestId: "r" }), { status: 200 });
      }
      gets += 1;
      return new Response(JSON.stringify({ workspace: workspace(), requestId: "r" }), { status: 200 });
    });
    const qc = queryClient;
    qc.clear();
    const client = createApiClient({ baseUrl: "http://x", fetch: editorFetch as typeof fetch });
    render(
      <QueryClientProvider client={qc}>
        <AppShell>
          <DocumentEditor client={client} systemId="s1" />
        </AppShell>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("document-editor-name")).toHaveTextContent("Secret System");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    // Production anonymous renders a sign-in prompt instead of protected children.
    expect(await screen.findByText(/sign in to open this character/i)).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(screen.queryByTestId("document-editor-header")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("Secret System")).not.toBeInTheDocument();
    // The unmounted editor issues no further system fetches or draft saves.
    const settled = { gets, puts };
    await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
    expect({ gets, puts }).toEqual(settled);
    qc.clear();
  });

  it("surfaces a retryable server-revocation failure and clears it on retry", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let signouts = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = new URL(url, window.location.origin).pathname;
      if (path === "/api/signout") {
        signouts += 1;
        if (signouts === 1) {
          return new Response(
            JSON.stringify({ error: { code: "revocation_failed", message: "Revocation failed." }, requestId: "r-1" }),
            { status: 500 },
          );
        }
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ state: "authenticated", userId: "signed-in" }));
    }));
    render(<AppShell>builder</AppShell>);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign out" }));
    // Server failure is distinct from local-storage failure: retryable
    // message, and the sign-out action stays available as the retry.
    expect(await screen.findByText(/server sign-out failed.*retry/i)).toBeVisible();
    expect(screen.queryByText(/local sign-out could not be saved/i)).not.toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Sign out" });
    expect(retry).toBeVisible();
    await userEvent.setup().click(retry);
    expect(await screen.findByText("Signed out.")).toBeInTheDocument();
    expect(signouts).toBe(2);
  });

  it("switches the device theme without remounting content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ state: "authenticated", userId: "theme-user" }))));
    const previousTheme = document.documentElement.getAttribute("data-theme");
    let mounts = 0;
    function Probe() {
      const seen = useRef(false);
      useEffect(() => { if (!seen.current) { seen.current = true; mounts += 1; } }, []);
      return <input data-testid="probe-input" defaultValue="draft-title" />;
    }
    try {
      render(<AppShell><Probe /></AppShell>);
      // Wait for the auth lifecycle (loading -> authenticated) to settle:
      // children mount during loading and remount across that transition,
      // so the no-remount assertion must start from the settled tree.
      await screen.findByRole("button", { name: "Sign out" });
      mounts = 0;
      const input = await screen.findByTestId("probe-input");
      const user = userEvent.setup();
      await user.click(input);
      await user.type(input, "+edited");
      const theme = screen.getByLabelText("Theme");
      await user.selectOptions(theme, "dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.style.colorScheme).toBe("dark");
      await user.selectOptions(theme, "light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      // Attribute-only switch: content is neither remounted nor reset.
      expect(mounts).toBe(0);
      expect(screen.getByTestId("probe-input")).toHaveValue("draft-title+edited");
    } finally {
      window.localStorage.removeItem("sweetroll:theme");
      if (previousTheme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", previousTheme);
      document.documentElement.style.colorScheme = "";
    }
  });
});

// G3-1: AppShell owns header/nav + ONE flexible content region. Views own
// their internal columns. jsdom has no layout engine, so viewport coverage
// is: (a) real computed-style assertions from the injected stylesheet,
// (b) CSS-text assertions for breakpoint bands/safe areas/scroll guards,
// (c) mount-identity assertions across simulated 320/768/1280 resizes.
const SHELL_CSS_PATH = join(process.cwd(), "src/shell/AppShell.module.css");

function readShellCss(): string {
  return readFileSync(SHELL_CSS_PATH, "utf8");
}

describe("AppShell responsive shell (G3-1)", () => {
  let styleEl: HTMLStyleElement | null = null;

  beforeAll(() => {
    // CSS modules hash class names: rewrite the raw selectors to the mapped
    // names so computed-style assertions exercise the real rules. Sort long
    // names first so `.nav` never corrupts `.navLink`.
    let css = readShellCss();
    const entries = Object.entries(styles as Record<string, string>)
      .sort((a, b) => b[0].length - a[0].length);
    for (const [local, mapped] of entries) {
      css = css.split(`.${local}`).join(`.${mapped}`);
    }
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-testid", "g3-shell-test-style");
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  });

  afterAll(() => {
    styleEl?.remove();
    styleEl = null;
  });

  function stubAuthenticated(userId = "shell-user"): void {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ state: "authenticated", userId }),
    )));
  }

  it("renders a single flexible content region with no column-grid assumption", async () => {
    stubAuthenticated();
    render(<AppShell><section data-testid="view">view body</section></AppShell>);
    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const main = screen.getByTestId("app-content");
    expect(main).toContainElement(screen.getByTestId("view"));
    // Neutral flexible container: block flow the view fills, never a routed
    // child pinned to the first column of a multi-column grid. (jsdom does
    // not expose min-width through getComputedStyle, so that half of the
    // assertion reads the stylesheet text below.)
    expect(getComputedStyle(main).display).toBe("block");
    const css = readShellCss();
    expect(css).toMatch(/\.main\s*\{[^}]*min-width\s*:\s*0/s);
    expect(css).not.toMatch(/grid-template-columns\s*:\s*240px/);
    expect(css).not.toMatch(/minmax\(280px, ?360px\)/);
  });

  it("keeps header/nav chrome, gates, switcher, and status intact", async () => {
    stubAuthenticated();
    render(<AppShell><span data-testid="child">x</span></AppShell>);
    await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByRole("banner")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeInTheDocument();
    // Plain-anchor deep links (no router context required).
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "New character" })).toHaveAttribute("href", "/characters/new");
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute("href", "#main-content");
    // Authorization context stays explicit: sign-out + pending-status slot,
    // device theme switcher, shortcut help, and status bar.
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.getByTestId("status-bar")).toHaveTextContent("Online");
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });

  it("resolves shell chrome strings through the i18n message table", async () => {
    // G3-3: the three G3-1 chrome literals now live in the message table.
    expect(defaultMessages["shell.skipToContent"]).toBe("Skip to main content");
    expect(defaultMessages["shell.nav.label"]).toBe("Primary");
    expect(defaultMessages["shell.nav.home"]).toBe("Home");
    try {
      registerLocale({
        "shell.skipToContent": "Zum Inhalt springen",
        "shell.nav.label": "Primär",
        "shell.nav.home": "Start",
      });
      stubAuthenticated();
      render(<AppShell><span data-testid="child">x</span></AppShell>);
      await screen.findByRole("button", { name: "Sign out" });
      expect(screen.getByRole("link", { name: "Zum Inhalt springen" })).toHaveAttribute("href", "#main-content");
      expect(screen.getByRole("navigation", { name: "Primär" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Start" })).toHaveAttribute("href", "/");
    } finally {
      resetLocale();
    }
  });

  it("adapts shell chrome by breakpoint with safe areas and scroll guards", () => {
    const css = readShellCss();
    // Phone 320-599 / tablet 600-1023 / desktop 1024px+ bands.
    expect(css).toMatch(/@media\s*\(\s*max-width\s*:\s*599px\s*\)/);
    expect(css).toMatch(/@media\s*\(\s*min-width\s*:\s*600px\s*\)\s*and\s*\(\s*max-width\s*:\s*1023px\s*\)/);
    expect(css).toMatch(/@media\s*\(\s*min-width\s*:\s*1024px\s*\)/);
    // Safe-area insets respected in chrome and content padding.
    expect(css).toMatch(/env\(safe-area-inset-top\)/);
    expect(css).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/env\(safe-area-inset-left\)/);
    expect(css).toMatch(/env\(safe-area-inset-right\)/);
    // Sticky (never fixed) header so a software keyboard or viewport
    // resize cannot trap primary actions behind an overlay. The footer
    // is ordinary flow, not sticky.
    expect(css).not.toMatch(/position\s*:\s*fixed/);
    expect(css).toMatch(/position\s*:\s*sticky/);
    // Sticky chrome must not cover focused controls or errors.
    expect(css).toMatch(/scroll-margin-top/);
    expect(css).toMatch(/scroll-padding-top/);
    // Views own their widths: content children participate with min-width 0.
    expect(css).toMatch(/min-width\s*:\s*0/);
  });

  it("keeps the header sticky while the status footer stays in ordinary flow", () => {
    const css = readShellCss();
    expect(css).toMatch(/\.header\s*\{[^}]*position\s*:\s*sticky/s);
    const footerStart = css.indexOf(".shell > footer");
    expect(footerStart).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", footerStart);
    let depth = 0;
    let footerBlock = "";
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          footerBlock = css.slice(open + 1, i);
          break;
        }
      }
    }
    expect(footerBlock).not.toMatch(/position\s*:\s*sticky/);
    expect(footerBlock).not.toMatch(/position\s*:\s*fixed/);
  });

  it("does not remount children across viewport changes (320/768/1280)", async () => {
    stubAuthenticated();
    let mounts = 0;
    function Probe() {
      const seen = useRef(false);
      useEffect(() => { if (!seen.current) { seen.current = true; mounts += 1; } }, []);
      return <input data-testid="viewport-probe" defaultValue="keep-me" />;
    }
    render(<AppShell><Probe /></AppShell>);
    await screen.findByRole("button", { name: "Sign out" });
    mounts = 0;
    const before = screen.getByTestId("viewport-probe");
    await userEvent.setup().type(before, "+edited");
    for (const width of [320, 768, 1280]) {
      Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
      window.dispatchEvent(new Event("resize"));
      // Let any resize-driven React work flush.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
      // Attribute/media-query driven only: same node, same state, no remount.
      expect(screen.getByTestId("viewport-probe")).toBe(before);
      expect(screen.getByTestId("viewport-probe")).toHaveValue("keep-me+edited");
    }
    expect(mounts).toBe(0);
    // Single region still holds the view after every resize.
    expect(screen.getAllByRole("main")).toHaveLength(1);
    expect(screen.getByTestId("app-content")).toContainElement(before);
  });
});
