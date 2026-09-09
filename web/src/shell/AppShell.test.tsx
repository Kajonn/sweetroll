import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef } from "react";

import { createApiClient } from "../api/client.js";
import { DocumentEditor } from "../editor/DocumentEditor.js";
import { queryClient } from "../queryClient.js";
import { AppShell, useAuth } from "./AppShell.js";

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
