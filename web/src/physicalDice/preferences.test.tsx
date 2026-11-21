import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { DicePreferencesPanel } from "./preferences.js";

it("shows the requested viewing choice while saving and restores a rejected change", async () => {
  let fail!: (err: Error) => void;
  const response = new Promise((_, reject) => {
    fail = reject;
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ show_3d_dice: true, dice_color: "#4c79c9" })
    .mockReturnValueOnce(response);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <DicePreferencesPanel client={{ fetch } as ApiClient} online actor="player" />
    </QueryClientProvider>,
  );
  const choice = await screen.findByRole("checkbox", { name: "Show 3D dice", checked: true });
  await userEvent.click(choice);
  expect(choice).not.toBeChecked();
  fail(Error("connection lost"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Dice preferences could not be loaded or saved.",
  );
  expect(choice).toBeChecked();
});
