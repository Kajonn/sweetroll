import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});
