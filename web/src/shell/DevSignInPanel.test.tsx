import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DevSignInPanel } from "./DevSignInPanel.js";

describe("DevSignInPanel", () => {
  it("renders a panel with the dev-signin submit button", () => {
    render(<DevSignInPanel onSignedIn={vi.fn()} />);
    expect(screen.getByTestId("dev-signin-panel")).toBeInTheDocument();
    expect(screen.getByTestId("dev-signin")).toBeInTheDocument();
  });

  it("invokes onSignedIn after the panel fetches /dev/signin successfully", async () => {
    const user = userEvent.setup();
    const fetch_ = vi.fn(async () => new Response("{}", { status: 200 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetch_ as unknown as typeof fetch;
    try {
      const onSignedIn = vi.fn();
      render(<DevSignInPanel onSignedIn={onSignedIn} />);
      await user.click(screen.getByTestId("dev-signin"));
      expect(fetch_).toHaveBeenCalledTimes(1);
      const call = fetch_.mock.calls[0] as [string, RequestInit] | undefined;
      const init = call?.[1];
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
      expect(onSignedIn).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("renders a single acceptance sign-in action without exposing a code field", () => {
    render(<DevSignInPanel acceptance onSignedIn={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Sign in for acceptance testing" })).toBeInTheDocument();
    expect(screen.queryByTestId("dev-signin-code")).not.toBeInTheDocument();
  });

  it("reports an acceptance sign-in failure", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    try {
      render(<DevSignInPanel acceptance onSignedIn={vi.fn()} />);
      await userEvent.setup().click(screen.getByTestId("dev-signin"));
      expect(await screen.findByRole("alert")).toHaveTextContent("Acceptance sign-in failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
