import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getAppRouter, registerAppRouter, resetAppRouter } from "../shell/appNavigation.js";
import { AppLink } from "./AppLink.js";

describe("AppLink", () => {
  afterEach(() => resetAppRouter());

  it("client-navigates unmodified left clicks when a router is registered", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/campaigns" data-testid="nav">Campaigns</AppLink>);
    const link = screen.getByTestId("nav");
    expect(link).toHaveAttribute("href", "/campaigns");
    await user.click(link);
    expect(push).toHaveBeenCalledWith("/campaigns");
  });

  it("lets modifier clicks fall through to the browser", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/campaigns" data-testid="nav">Campaigns</AppLink>);
    await user.keyboard("{Control>}");
    await user.click(screen.getByTestId("nav"));
    await user.keyboard("{/Control}");
    expect(push).not.toHaveBeenCalled();
  });

  it("renders a working plain anchor when no router is registered", async () => {
    expect(getAppRouter()).toBeNull();
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<AppLink href="/campaigns" data-testid="nav" onClick={onClick}>Campaigns</AppLink>);
    await user.click(screen.getByTestId("nav"));
    expect(onClick).toHaveBeenCalled();
    expect(screen.getByTestId("nav")).toHaveAttribute("href", "/campaigns");
  });

  it("does not intercept external URLs or hash links", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="https://example.com/x" data-testid="ext">X</AppLink>);
    await user.click(screen.getByTestId("ext"));
    expect(push).not.toHaveBeenCalled();
  });

  it("lets target=_blank links fall through to the browser", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/campaigns" target="_blank" data-testid="blank">Campaigns</AppLink>);
    await user.click(screen.getByTestId("blank"));
    expect(push).not.toHaveBeenCalled();
  });

  it("lets download links fall through to the browser", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="/export.pdf" download data-testid="dl">Export</AppLink>);
    await user.click(screen.getByTestId("dl"));
    expect(push).not.toHaveBeenCalled();
  });

  it("does not intercept same-document hash links", async () => {
    const user = userEvent.setup();
    const push = vi.fn();
    registerAppRouter({ history: { push } });
    render(<AppLink href="#main-content" data-testid="hash">Skip</AppLink>);
    await user.click(screen.getByTestId("hash"));
    expect(push).not.toHaveBeenCalled();
  });
});
