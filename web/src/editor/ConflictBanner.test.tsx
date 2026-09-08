import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConflictBanner } from "./ConflictBanner.js";

function renderBanner(overrides: Partial<React.ComponentProps<typeof ConflictBanner>> = {}) {
  const onAcceptTheirs = vi.fn();
  const onKeepMine = vi.fn();
  const onDismiss = vi.fn();
  const props: React.ComponentProps<typeof ConflictBanner> = {
    latestRevision: 7,
    onAcceptTheirs,
    onKeepMine,
    onDismiss,
    ...overrides,
  };
  const view = render(<ConflictBanner {...props} />);
  return {
    ...view,
    onAcceptTheirs,
    onKeepMine,
    onDismiss,
  };
}

describe("ConflictBanner", () => {
  it("renders the two recovery buttons plus a dismiss control and no merge action", () => {
    renderBanner();
    expect(screen.getByTestId("conflict-banner")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reload theirs/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /replace server version/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dismiss/i })).toBeInTheDocument();
  });

  it("shows the latest revision in the message", () => {
    renderBanner({ latestRevision: 42 });
    expect(screen.getByTestId("conflict-banner")).toHaveTextContent(/42/);
  });

  it("invokes onAcceptTheirs when Reload theirs is clicked", async () => {
    const user = userEvent.setup();
    const banner = renderBanner();
    await user.click(screen.getByRole("button", { name: /reload theirs/i }));
    expect(banner.onAcceptTheirs).toHaveBeenCalledTimes(1);
    expect(banner.onKeepMine).not.toHaveBeenCalled();
  });

  it("invokes onKeepMine when Replace server version is clicked", async () => {
    const user = userEvent.setup();
    const banner = renderBanner();
    await user.click(screen.getByRole("button", { name: /replace server version/i }));
    expect(banner.onKeepMine).toHaveBeenCalledTimes(1);
    expect(banner.onAcceptTheirs).not.toHaveBeenCalled();
  });

  it("invokes onDismiss when the dismiss button is clicked", async () => {
    const user = userEvent.setup();
    const banner = renderBanner();
    await user.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(banner.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("uses role=alert so screen readers announce the conflict", () => {
    renderBanner();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
