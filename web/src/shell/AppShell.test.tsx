import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell, useAuth } from "./AppShell.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("AppShell", () => {
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

  it("renders children in the main region", () => {
    render(<AppShell><span data-testid="child">x</span></AppShell>);
    expect(screen.getByTestId("child")).toBeInTheDocument();
  });
});
