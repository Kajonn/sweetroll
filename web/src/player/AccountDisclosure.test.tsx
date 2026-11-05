import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Account } from "./Account.js";
import type { ApiClient } from "../api/client.js";
import { setDebugMode } from "../ui/debugMode.js";

afterEach(() => { act(() => setDebugMode(false)); localStorage.clear(); });

it("has one device theme control and exposes IDs only after opting into debug", async () => {
  const client = { fetch: vi.fn(async (_method, path) => path === "/me" ? { state: "authenticated", userId: "private-account-id" } : { theme_default: null }) } as unknown as ApiClient;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><Account client={client} identity={{ getActorId: () => "private-account-id", isOnline: () => true, signOut: vi.fn() }} storageUnavailable={false} /></QueryClientProvider>);
  expect(await screen.findByText("This device")).toBeVisible();
  expect(screen.queryByText("private-account-id")).not.toBeInTheDocument();
  expect(screen.getAllByRole("combobox", { name: "Theme" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(screen.queryByText("Open a character to archive or recover it.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Developer tools"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show debug information" }));
  expect(screen.getAllByText("private-account-id")).toHaveLength(1);
});
