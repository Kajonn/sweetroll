import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AppNavigation } from "./AppNavigation.js";
import { registerAppRouter, resetAppRouter } from "./appNavigation.js";

afterEach(resetAppRouter);

it("names the existing systems landing route and preserves native destinations", () => {
  render(<AppNavigation />);
  expect(screen.getByRole("link", { name: "Systems" })).toHaveAttribute("href", "/");
  expect(screen.queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
});

it("closes the compact navigation after client navigation without reloading", async () => {
  const push = vi.fn();
  registerAppRouter({ history: { push } });
  const user = userEvent.setup();
  render(<AppNavigation />);
  const trigger = screen.getByRole("button", { name: "Navigation menu" });
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.click(screen.getByRole("link", { name: "Systems" }));
  expect(push).toHaveBeenCalledWith("/");
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});

it("closes with Escape and restores trigger focus, or closes on an outside pointer", async () => {
  const user = userEvent.setup();
  render(<><AppNavigation /><button>Outside</button></>);
  const trigger = screen.getByRole("button", { name: "Navigation menu" });
  await user.click(trigger);
  screen.getByRole("link", { name: "Account" }).focus();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute("aria-expanded", "false");
  await user.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
  expect(trigger).toHaveAttribute("aria-expanded", "false");
});
